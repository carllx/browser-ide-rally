/**
 * 多项目持久化注册表 (Durable Multi-Project Registry)
 *
 * 核心设计原则 (#14, #21, #41):
 * 1. 多项目隔离：支持管理多个互不干扰的 Project Binding 及其 Status Core；
 * 2. 原子化与版本化持久化：使用 schema_version: 3，包含 retired_generations 退役代际账本，通过临时文件加原子重命名确保写入安全；
 * 3. 确定性无损迁移：支持从 schema_version: 1 及旧版/candidate-era schema_version: 2 平滑迁移，
 *    保持 handled/latest/continuity 及历史退役代际完整还原；不支持或损坏的 schema 一律 fail-closed；
 * 4. 专有受信 Hydration 缝隙：底层规范事实安全还原，绝不混淆 live observation；
 * 5. 安全端点生命周期编排：由 Registry 代理 Core 的安全 rebindEndpoint、addIdeEndpoint、removeIdeEndpoint；
 * 6. 活跃会话唯一性守卫：精确排除目标 slot 本身，严禁跨端点与跨项目活跃会话抢占。
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateBinding } from '../controller/binding.js';
import { createProjectStatusCore } from '../status/status-core.js';
import { normalizeRetiredGeneration } from '../status/retired-generations.js';

export const CURRENT_SCHEMA_VERSION = 3;
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
    /** @type {Map<string, object>} 规范留存的已移出项目事实账本 */
    this._removedProjects = new Map();
  }

  registerProject({
    binding,
    initial_endpoints = null,
    initial_ordering_evidence = null,
    initial_retired_generations = null
  }) {
    const validation = validateBinding(binding);
    if (!validation.valid) {
      throw new Error(`Cannot register invalid binding: ${validation.errors.join('; ')}`);
    }

    if (this._projects.has(binding.binding_id)) {
      throw new Error(`Project binding_id "${binding.binding_id}" is already registered`);
    }

    if (this._removedProjects.has(binding.binding_id)) {
      throw new Error(`Cannot register project: binding_id "${binding.binding_id}" is already present in retained evidence`);
    }

    // 唯一性守卫：排查 display_name、browser conversation 与 ide conversations
    const newDisplayName = binding.display_name ? binding.display_name.trim().toLowerCase() : null;
    const newBrowserConvId = binding.browser?.conversation_id ? binding.browser.conversation_id.trim() : null;
    const newIdeConvIds = new Set(
      (binding.ide_endpoints || []).map(ep => ep.conversation_id?.trim()).filter(Boolean)
    );

    for (const [existingId, existingCore] of this._projects.entries()) {
      const existingBinding = existingCore.getBinding();
      const existingEffectiveName = (existingBinding.display_name || existingBinding.binding_id || '').trim().toLowerCase();
      if (newDisplayName && existingEffectiveName && existingEffectiveName === newDisplayName) {
        throw new Error(`Project display_name "${binding.display_name}" is already registered in project "${existingId}"`);
      }

      if (newBrowserConvId && existingBinding.browser?.conversation_id?.trim() === newBrowserConvId) {
        throw new Error(`Browser conversation_id "${binding.browser.conversation_id}" is already registered in project "${existingId}"`);
      }

      for (const ep of existingBinding.ide_endpoints || []) {
        const existingIdeConv = ep.conversation_id?.trim();
        if (existingIdeConv && newIdeConvIds.has(existingIdeConv)) {
          throw new Error(`IDE conversation_id "${existingIdeConv}" is already registered in project "${existingId}"`);
        }
      }
    }

    const core = createProjectStatusCore({
      binding,
      initial_endpoints,
      initial_ordering_evidence,
      initial_retired_generations,
      onMutation: () => {
        if (this._storagePath) {
          this.saveToFile(this._storagePath);
        }
      }
    });
    this._projects.set(binding.binding_id, core);
    if (this._storagePath) {
      try {
        this.saveToFile(this._storagePath);
      } catch (err) {
        this._projects.delete(binding.binding_id);
        throw err;
      }
    }
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

  /**
   * 从活跃集合中安全移出项目，并将其完整规范事实留存于持久化已移出账本中
   * 遵循 Issue #36 契约：
   * 1. 严格要求 exact binding_id + exact expected_binding_revision；
   * 2. 脏版本或缺失版本严格抛出 STALE_OR_MISSING_BINDING_REVISION 并保证 Zero Mutation；
   * 3. 持久化失败时内存原子回滚，保持存储真值权威；
   * 4. 兄弟项目与底层真实环境（外部会话/工作区/代码仓）完全不受修改。
   * @param {string} bindingId
   * @param {object} options
   * @param {number} options.expected_binding_revision
   * @returns {{ success: boolean, binding_id: string, removed_at: string }}
   */
  removeProject(bindingId, { expected_binding_revision } = {}) {
    if (expected_binding_revision === undefined || expected_binding_revision === null || typeof expected_binding_revision !== 'number') {
      throw new Error('expected_binding_revision is required for removeProject');
    }

    const core = this.getProject(bindingId);
    const snapshot = core.getSnapshot();

    if (snapshot.binding.binding_revision !== expected_binding_revision) {
      const err = new Error(
        `STALE_OR_MISSING_BINDING_REVISION: expected ${expected_binding_revision}, actual ${snapshot.binding.binding_revision}`
      );
      err.code = 'STALE_OR_MISSING_BINDING_REVISION';
      throw err;
    }

    const removedAt = new Date().toISOString();
    const retainedEvidence = {
      ...core.exportState(),
      removed_at: removedAt
    };

    // 内存事务性转移
    this._projects.delete(bindingId);
    this._removedProjects.set(bindingId, retainedEvidence);

    if (this._storagePath) {
      try {
        this.saveToFile(this._storagePath);
      } catch (err) {
        // 存储失败：内存原子回滚
        this._projects.set(bindingId, core);
        this._removedProjects.delete(bindingId);
        throw err;
      }
    }

    return {
      success: true,
      binding_id: bindingId,
      removed_at: removedAt
    };
  }

  hasRemovedProject(bindingId) {
    return this._removedProjects.has(bindingId);
  }

  getRemovedProject(bindingId) {
    const retained = this._removedProjects.get(bindingId);
    if (!retained) {
      throw new Error(`Removed project "${bindingId}" not found in retention ledger`);
    }
    return retained;
  }

  listRemovedProjects() {
    return Array.from(this._removedProjects.values());
  }

  /**
   * 活跃端点会话唯一性校验（仅排除精确的目标槽位 targetSlot；严格区分 role 与 Browser provider；退役历史不占位）
   * @param {object} params
   * @param {string} params.projectBindingId
   * @param {string|null} [params.targetSlot] - 正在重绑的目标端点 ID（如 'browser', 'ide-A' 等）
   * @param {'browser'|'ide'} params.role
   * @param {string} params.conversationId
   * @param {string|null} [params.provider]
   */
  assertActiveConversationUnique({ projectBindingId, targetSlot = null, role, conversationId, provider = null }) {
    if (!conversationId || typeof conversationId !== 'string') return;
    const cleanConvId = conversationId.trim();
    if (!cleanConvId) return;

    const targetProvider = (typeof provider === 'string' && provider.trim()) ? provider.trim() : 'chatgpt';

    for (const [existingId, existingCore] of this._projects.entries()) {
      const isCurrentProject = existingId === projectBindingId;
      const existingBinding = existingCore.getBinding();
      const projectName = existingBinding.display_name || existingId;

      if (role === 'browser') {
        if (isCurrentProject && (targetSlot === 'browser' || !targetSlot)) {
          continue;
        }
        const existingBrowserConv = existingBinding.browser?.conversation_id?.trim();
        const existingBrowserProvider = existingBinding.browser?.provider?.trim() || 'chatgpt';
        if (existingBrowserConv && existingBrowserConv === cleanConvId && existingBrowserProvider === targetProvider) {
          const location = isCurrentProject ? 'the same project' : `project "${projectName}"`;
          throw new Error(`Browser conversation "${cleanConvId}" is already bound to ${location} (provider: ${targetProvider}).`);
        }
      } else if (role === 'ide') {
        for (const ep of existingBinding.ide_endpoints || []) {
          if (isCurrentProject && targetSlot && ep.endpoint_id === targetSlot) {
            continue;
          }
          const existingIdeConv = ep.conversation_id?.trim();
          if (existingIdeConv && existingIdeConv === cleanConvId) {
            if (isCurrentProject) {
              throw new Error(`Antigravity conversation "${cleanConvId}" is already bound to endpoint "${ep.endpoint_id}" in the same project.`);
            } else {
              throw new Error(`Antigravity conversation "${cleanConvId}" is already bound to project "${projectName}".`);
            }
          }
        }
      }
    }
  }

  rebindProjectEndpoint(bindingId, rebindOptions) {
    const core = this.getProject(bindingId);
    const targetEndpoint = rebindOptions.endpoint_id || rebindOptions.endpoint || rebindOptions.target_endpoint;
    const resolved = typeof core._resolveEndpoint === 'function' ? core._resolveEndpoint(targetEndpoint) : null;
    const targetSlot = resolved ? resolved.id : targetEndpoint;
    const role = (resolved ? resolved.role : (targetEndpoint === 'browser' ? 'browser' : 'ide'));
    const conversationId = rebindOptions.identity?.conversation_id;
    const provider = rebindOptions.identity?.provider || (role === 'browser' ? core.getBinding().browser?.provider : null);

    if (conversationId) {
      this.assertActiveConversationUnique({
        projectBindingId: bindingId,
        targetSlot,
        role,
        conversationId,
        provider
      });
    }

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

  markProjectEndpointHandled(bindingId, endpointId, { expected_cursor } = {}) {
    const core = this.getProject(bindingId);
    const result = core.markEndpointHandled(endpointId, { expected_cursor });
    if (result.success && this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return result;
  }

  reconcileProjectOrdering(bindingId) {
    const core = this.getProject(bindingId);
    const snapshot = core.reconcileProjectOrdering();
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return snapshot;
  }

  setProjectHumanIntervention(bindingId, { active = true, reason = null, expected_binding_revision } = {}) {
    const core = this.getProject(bindingId);
    const snapshot = core.getSnapshot();
    if (expected_binding_revision === undefined || expected_binding_revision === null) {
      throw new Error('expected_binding_revision is required for setProjectHumanIntervention');
    }
    if (expected_binding_revision !== snapshot.binding.binding_revision) {
      const err = new Error(
        `STALE_OR_MISSING_BINDING_REVISION: expected ${expected_binding_revision}, actual ${snapshot.binding.binding_revision}`
      );
      err.code = 'STALE_OR_MISSING_BINDING_REVISION';
      throw err;
    }

    core.setHumanIntervention({ active, reason });
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return {
      success: true,
      human_intervention: core.getSnapshot().human_intervention
    };
  }

  clearProjectHumanIntervention(bindingId, { expected_binding_revision } = {}) {
    return this.setProjectHumanIntervention(bindingId, {
      active: false,
      reason: null,
      expected_binding_revision
    });
  }

  recordProjectActionFact(bindingId, actionParams) {
    const core = this.getProject(bindingId);
    const fact = core.recordActionFact(actionParams);
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return fact;
  }

  advanceProjectActionStage(bindingId, actionId, transitionParams) {
    const core = this.getProject(bindingId);
    const updated = core.advanceActionStage(actionId, transitionParams);
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return updated;
  }

  exportRegistryData() {
    const projectsObj = {};
    for (const [bindingId, core] of this._projects.entries()) {
      projectsObj[bindingId] = core.exportState();
    }
    const removedProjectsObj = {};
    for (const [bindingId, retained] of this._removedProjects.entries()) {
      removedProjectsObj[bindingId] = retained;
    }
    return {
      schema_version: CURRENT_SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      projects: projectsObj,
      removed_projects: removedProjectsObj
    };
  }

  saveToFile(filePath = this._storagePath) {
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

    if (!parsed || (parsed.schema_version !== 1 && parsed.schema_version !== 2 && parsed.schema_version !== CURRENT_SCHEMA_VERSION)) {
      const err = new Error(
        `UNSUPPORTED_SCHEMA_VERSION: Unsupported registry storage schema_version: expected ${CURRENT_SCHEMA_VERSION}, 2, or 1, got ${parsed?.schema_version}`
      );
      err.code = 'UNSUPPORTED_SCHEMA_VERSION';
      throw err;
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

      // 严格校验退役代际账本（Fail-Closed，不容许任何畸形或损坏条目）
      let retiredGenerationsToLoad = [];
      if (projData.retired_generations !== undefined && projData.retired_generations !== null) {
        if (!Array.isArray(projData.retired_generations)) {
          throw new Error(`Corrupt retired_generations ledger for binding_id "${bindingId}"`);
        }
        for (const item of projData.retired_generations) {
          retiredGenerationsToLoad.push(normalizeRetiredGeneration(item));
        }
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
        initial_endpoints: endpointsToLoad,
        initial_ordering_evidence: projData.ordering_evidence || null,
        initial_retired_generations: retiredGenerationsToLoad
      });

      if (projData.human_intervention) {
        core.setHumanIntervention(projData.human_intervention);
      }

      if (Array.isArray(projData.actions)) {
        for (const act of projData.actions) {
          core.recordActionFact(act);
        }
      }

      core.setOnMutation(() => {
        if (this._storagePath) {
          this.saveToFile(this._storagePath);
        }
      });

      nextProjects.set(bindingId, core);
    }

    const nextRemovedProjects = new Map();
    const seenRemovedBindingIds = new Set();
    if (parsed.removed_projects !== undefined && parsed.removed_projects !== null) {
      if (typeof parsed.removed_projects !== 'object' || Array.isArray(parsed.removed_projects)) {
        throw new Error('Invalid registry storage format: "removed_projects" must be an object');
      }
      for (const [bindingId, retainedData] of Object.entries(parsed.removed_projects)) {
        if (!retainedData || typeof retainedData !== 'object' || !retainedData.binding) {
          throw new Error(`Corrupt removed project data for binding_id "${bindingId}"`);
        }
        const internalId = retainedData.binding.binding_id;
        if (bindingId !== internalId) {
          throw new Error(
            `Durable removed project key mismatch: outer key "${bindingId}" does not match internal binding_id "${internalId}"`
          );
        }
        if (seenBindingIds.has(internalId)) {
          throw new Error(`Durable binding_id collision: "${internalId}" exists in both active and removed projects`);
        }
        if (seenRemovedBindingIds.has(internalId)) {
          throw new Error(`Duplicate removed binding_id "${internalId}" detected in durable storage`);
        }
        seenRemovedBindingIds.add(internalId);
        nextRemovedProjects.set(bindingId, retainedData);
      }
    }

    this._projects = nextProjects;
    this._removedProjects = nextRemovedProjects;
    this._storagePath = filePath;
  }
}
