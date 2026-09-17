/**
 * 多项目持久化注册表 (Durable Multi-Project Registry)
 *
 * 核心设计原则 (#14, #21):
 * 1. 多项目隔离：支持管理多个互不干扰的 Project Binding 及其 Status Core；
 * 2. 原子化与版本化持久化：使用 schema_version: 2，通过临时文件加原子重命名确保写入安全；
 * 3. v1 确定性迁移：对于已有 schema_version: 1 数据，执行严格确定性的单槽位迁移 (ide-default)，
 *    保持 handled/latest/continuity 事实完整还原；不支持或损坏的 schema 一律 fail-closed；
 * 4. 专有受信 Hydration 缝隙：底层规范事实安全还原，绝不混淆 live observation；
 * 5. 安全端点生命周期编排：由 Registry 代理 Core 的安全 rebindEndpoint、addIdeEndpoint、removeIdeEndpoint。
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateBinding } from '../controller/binding.js';
import { createProjectStatusCore } from '../status/status-core.js';

export const CURRENT_SCHEMA_VERSION = 2;
export const DETERMINISTIC_MIGRATED_IDE_ID = 'ide-default';

export function createProjectRegistry({ storagePath = null } = {}) {
  const registry = new ProjectRegistry({ storagePath });
  if (storagePath && fs.existsSync(storagePath)) {
    registry.loadFromFile(storagePath);
  }
  return registry;
}

export class ProjectRegistry {
  constructor({ storagePath = null } = {}) {
    this._storagePath = storagePath;
    /** @type {Map<string, import('../status/status-core.js').ProjectStatusCore>} */
    this._projects = new Map();
  }

  registerProject({ binding, initial_endpoints = null }) {
    const validation = validateBinding(binding);
    if (!validation.valid) {
      throw new Error(`Cannot register invalid binding: ${validation.errors.join('; ')}`);
    }

    if (this._projects.has(binding.binding_id)) {
      throw new Error(`Project binding_id "${binding.binding_id}" is already registered`);
    }

    const core = createProjectStatusCore({ binding, initial_endpoints });
    this._projects.set(binding.binding_id, core);
    return core;
  }

  getProject(bindingId) {
    const core = this._projects.get(bindingId);
    if (!core) {
      throw new Error(`Project "${bindingId}" not found in registry`);
    }
    return core;
  }

  hasProject(bindingId) {
    return this._projects.has(bindingId);
  }

  listProjects() {
    return Array.from(this._projects.values()).map(core => core.getSnapshot());
  }

  rebindProjectEndpoint(bindingId, rebindOptions) {
    const core = this.getProject(bindingId);
    const snapshot = core.rebindEndpoint(rebindOptions);
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return snapshot;
  }

  addProjectIdeEndpoint(bindingId, { endpoint_id, identity }) {
    const core = this.getProject(bindingId);
    const snapshot = core.addIdeEndpoint({ endpoint_id, identity });
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return snapshot;
  }

  removeProjectIdeEndpoint(bindingId, endpointId, options = {}) {
    const core = this.getProject(bindingId);
    const snapshot = core.removeIdeEndpoint(endpointId, options);
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return snapshot;
  }

  exportRegistryData() {
    const projectsObj = {};
    for (const [bindingId, core] of this._projects.entries()) {
      projectsObj[bindingId] = core.exportState();
    }
    return {
      schema_version: CURRENT_SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      projects: projectsObj
    };
  }

  saveToFile(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Valid storage filePath is required for saveToFile');
    }

    const data = this.exportRegistryData();
    const payload = JSON.stringify(data, null, 2);

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempFile = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempFile, payload, 'utf-8');
    fs.renameSync(tempFile, filePath);
    this._storagePath = filePath;
  }

  loadFromFile(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Valid storage filePath is required for loadFromFile');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Storage file "${filePath}" does not exist`);
    }

    let parsed;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Corrupt durable registry storage: ${err.message}`);
    }

    if (!parsed || (parsed.schema_version !== 1 && parsed.schema_version !== CURRENT_SCHEMA_VERSION)) {
      throw new Error(
        `Unsupported registry storage schema_version: expected ${CURRENT_SCHEMA_VERSION} or 1, got ${parsed?.schema_version}`
      );
    }

    const isV1Migration = parsed.schema_version === 1;

    if (!parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
      throw new Error('Invalid registry storage format: "projects" must be an object');
    }

    const nextProjects = new Map();
    const seenBindingIds = new Set();

    for (const [bindingId, projData] of Object.entries(parsed.projects)) {
      if (!projData || !projData.binding) {
        throw new Error(`Corrupt project data for binding_id "${bindingId}"`);
      }

      const internalId = projData.binding.binding_id;
      if (bindingId !== internalId) {
        throw new Error(
          `Durable project key mismatch: outer key "${bindingId}" does not match internal binding_id "${internalId}"`
        );
      }

      if (seenBindingIds.has(internalId)) {
        throw new Error(`Duplicate internal binding_id "${internalId}" detected in durable storage`);
      }
      seenBindingIds.add(internalId);

      if (projData.endpoints && typeof projData.endpoints !== 'object') {
        throw new Error(`Corrupt endpoints ledger for binding_id "${bindingId}"`);
      }

      let bindingToLoad = projData.binding;
      let endpointsToLoad = projData.endpoints || {};

      // 若为 v1 数据，执行确定性单槽位迁移
      if (isV1Migration) {
        const legacyIde = projData.binding.ide;
        if (!legacyIde || typeof legacyIde !== 'object') {
          throw new Error(`Corrupt v1 project data: missing ide identity for "${bindingId}"`);
        }
        bindingToLoad = {
          ...projData.binding,
          ide_endpoints: [{
            endpoint_id: DETERMINISTIC_MIGRATED_IDE_ID,
            endpoint_revision: 1,
            conversation_id: legacyIde.conversation_id,
            workspace_identity: legacyIde.workspace_identity,
            repository_identity: legacyIde.repository_identity
          }]
        };

        const migratedIdeEndpoints = {};
        if (endpointsToLoad.ide) {
          migratedIdeEndpoints[DETERMINISTIC_MIGRATED_IDE_ID] = {
            ...endpointsToLoad.ide,
            endpoint: DETERMINISTIC_MIGRATED_IDE_ID,
            role: 'ide',
            endpoint_revision: 1
          };
        }
        endpointsToLoad = {
          browser: endpointsToLoad.browser,
          ide_endpoints: migratedIdeEndpoints
        };
      }

      const core = createProjectStatusCore({
        binding: bindingToLoad,
        initial_endpoints: endpointsToLoad
      });

      if (projData.human_intervention) {
        core.setHumanIntervention(projData.human_intervention);
      }

      if (Array.isArray(projData.actions)) {
        for (const act of projData.actions) {
          core.recordActionFact(act);
        }
      }

      nextProjects.set(bindingId, core);
    }

    this._projects = nextProjects;
    this._storagePath = filePath;
  }
}
