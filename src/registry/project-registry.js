/**
 * 多项目持久化注册表 (Durable Multi-Project Registry)
 *
 * 核心设计原则 (Core Principles):
 * 1. 多项目隔离：支持管理多个互不干扰的 Project Binding 及其 Status Core；
 * 2. 原子化与版本化持久化：使用 schema_version: 1，通过临时文件加原子重命名 (fs.renameSync) 确保写入安全；
 * 3. 故障关闭 (Fail-Closed)：数据损坏、版本不匹配或格式不完整时拒绝静默恢复，直接抛出明确错误；
 * 4. 独立受信任恢复：通过专用 hydration 缝隙还原底层规范事实，绝不混淆 live observation；
 * 5. 安全端点重绑：代理调用 Core 的安全 rebindEndpoint()，守卫未处理 NEW 并强制 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION。
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateBinding } from '../controller/binding.js';
import { createProjectStatusCore } from '../status/status-core.js';

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * 创建多项目注册表实例
 * @param {object} [options]
 * @param {string} [options.storagePath] - 可选的持久化文件路径
 * @returns {ProjectRegistry}
 */
export function createProjectRegistry({ storagePath = null } = {}) {
  const registry = new ProjectRegistry({ storagePath });
  if (storagePath && fs.existsSync(storagePath)) {
    registry.loadFromFile(storagePath);
  }
  return registry;
}

export class ProjectRegistry {
  /**
   * @param {object} [options]
   * @param {string} [options.storagePath]
   */
  constructor({ storagePath = null } = {}) {
    this._storagePath = storagePath;
    /** @type {Map<string, import('../status/status-core.js').ProjectStatusCore>} */
    this._projects = new Map();
  }

  /**
   * 注册并托管新项目
   * @param {object} params
   * @param {object} params.binding - Project Binding 实例
   * @param {object} [params.initial_endpoints] - 可选的初始/已持久化端点事实
   * @returns {import('../status/status-core.js').ProjectStatusCore}
   */
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

  /**
   * 获取指定 binding_id 的 Status Core
   * @param {string} bindingId 
   * @returns {import('../status/status-core.js').ProjectStatusCore}
   */
  getProject(bindingId) {
    const core = this._projects.get(bindingId);
    if (!core) {
      throw new Error(`Project "${bindingId}" not found in registry`);
    }
    return core;
  }

  /**
   * 判断是否存在指定 binding_id
   * @param {string} bindingId 
   * @returns {boolean}
   */
  hasProject(bindingId) {
    return this._projects.has(bindingId);
  }

  /**
   * 列出所有已注册项目的规范快照
   * @returns {Array<object>}
   */
  listProjects() {
    return Array.from(this._projects.values()).map(core => core.getSnapshot());
  }

  /**
   * 安全重绑指定项目的某个端点 (#14)
   * @param {string} bindingId 
   * @param {object} params
   * @param {'browser' | 'ide'} params.endpoint 
   * @param {object} params.identity 
   * @param {boolean} [params.allow_discard_unhandled=false] 
   * @returns {object} 更新后的快照
   */
  rebindProjectEndpoint(bindingId, { endpoint, identity, allow_discard_unhandled = false }) {
    const core = this.getProject(bindingId);
    const snapshot = core.rebindEndpoint({ endpoint, identity, allow_discard_unhandled });
    if (this._storagePath) {
      this.saveToFile(this._storagePath);
    }
    return snapshot;
  }

  /**
   * 导出当前全部项目的持久化数据结构
   * @returns {object}
   */
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

  /**
   * 原子写入保存到文件
   * 先写入临时文件再通过 fs.renameSync 原子替换，防止中途断电或写入损坏
   * @param {string} filePath 
   */
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

  /**
   * 从持久化文件恢复多项目状态 (Fail-Closed 校验)
   * @param {string} filePath 
   */
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

    // 1. 版本严格校验：不支持的版本一律 Fail-Closed
    if (!parsed || parsed.schema_version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported registry storage schema_version: expected ${CURRENT_SCHEMA_VERSION}, got ${parsed?.schema_version}`
      );
    }

    // 2. 结构校验
    if (!parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
      throw new Error('Invalid registry storage format: "projects" must be an object');
    }

    // 3. 受信反序列化每个项目
    this._projects.clear();
    for (const [bindingId, projData] of Object.entries(parsed.projects)) {
      if (!projData || !projData.binding) {
        throw new Error(`Corrupt project data for binding_id "${bindingId}"`);
      }

      const core = createProjectStatusCore({
        binding: projData.binding,
        initial_endpoints: projData.endpoints
      });

      if (projData.human_intervention) {
        core.setHumanIntervention(projData.human_intervention);
      }

      if (Array.isArray(projData.actions)) {
        for (const act of projData.actions) {
          core.recordActionFact(act);
        }
      }

      this._projects.set(bindingId, core);
    }

    this._storagePath = filePath;
  }
}
