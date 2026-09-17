/**
 * Rally Binding 数据模型与校验
 * 拓扑：1 Browser conversation ↔ 1 Rally binding ↔ 1..N target IDE endpoint slots
 * 
 * 核心设计原则：
 * 1. Exactly one canonical Browser endpoint；
 * 2. 1..N concurrent IDE endpoint slots，每个槽位由 Rally-owned stable endpoint_id 标识；
 * 3. 纯数据模型与校验（纯函数/变换），不涉及状态机与生命周期守卫；
 * 4. 消除 mutable ide setter，任何 legacy `ide` compatibility surface 仅在恰好 1 个 IDE 端点时作为只读 derived property 暴露；
 * 5. 抽取统一 helper 消除重复的 Object.defineProperty 代码。
 */

export const DEFAULT_CAPABILITIES = ['rally.echo'];

/**
 * 校验单个 IDE 端点配置合法性
 * @param {object} ep 
 * @returns {string[]} 错误列表
 */
export function validateIdeEndpoint(ep) {
  const errors = [];
  if (!ep || typeof ep !== 'object') {
    return ['IDE endpoint must be a non-null object'];
  }
  if (typeof ep.endpoint_id !== 'string' || !ep.endpoint_id.trim()) {
    errors.push('IDE endpoint_id must be a non-empty string');
  }
  if (ep.endpoint_revision !== undefined && (!Number.isInteger(ep.endpoint_revision) || ep.endpoint_revision < 1)) {
    errors.push('IDE endpoint_revision must be an integer >= 1');
  }
  if (typeof ep.conversation_id !== 'string' || !ep.conversation_id.trim()) {
    errors.push('IDE conversation_id must be a non-empty string');
  }
  if (typeof ep.workspace_identity !== 'string' || !ep.workspace_identity.trim()) {
    errors.push('IDE workspace_identity must be a non-empty string');
  }
  if (typeof ep.repository_identity !== 'string' || !ep.repository_identity.trim()) {
    errors.push('IDE repository_identity must be a non-empty string');
  }
  return errors;
}

/**
 * 校验 Binding 记录合法性
 * @param {object} binding 
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBinding(binding) {
  const errors = [];
  if (!binding || typeof binding !== 'object') {
    return { valid: false, errors: ['Binding must be a non-null object'] };
  }

  if (typeof binding.binding_id !== 'string' || !binding.binding_id.trim()) {
    errors.push('binding_id must be a non-empty string');
  }

  if (!Number.isInteger(binding.binding_revision) || binding.binding_revision < 1) {
    errors.push('binding_revision must be an integer >= 1');
  }

  // Browser 身份校验
  if (!binding.browser || typeof binding.browser !== 'object') {
    errors.push('browser identity object is required');
  } else {
    if (typeof binding.browser.provider !== 'string' || !binding.browser.provider.trim()) {
      errors.push('browser.provider must be a non-empty string');
    }
    if (typeof binding.browser.conversation_id !== 'string' || !binding.browser.conversation_id.trim()) {
      errors.push('browser.conversation_id must be a non-empty string');
    }
  }

  // IDE 端点集合校验 (支持 ide_endpoints 数组或旧 ide 单对象)
  const ideEndpoints = Array.isArray(binding.ide_endpoints)
    ? binding.ide_endpoints
    : (binding.ide ? [{ endpoint_id: 'ide', endpoint_revision: 1, ...binding.ide }] : null);

  if (!ideEndpoints || ideEndpoints.length === 0) {
    errors.push('At least one IDE endpoint is required');
  } else {
    const seenIds = new Set();
    for (let i = 0; i < ideEndpoints.length; i++) {
      const ep = ideEndpoints[i];
      const epErrors = validateIdeEndpoint(ep);
      if (epErrors.length > 0) {
        errors.push(`IDE endpoint [${i}]: ${epErrors.join(', ')}`);
      } else {
        if (seenIds.has(ep.endpoint_id)) {
          errors.push(`Duplicate IDE endpoint_id "${ep.endpoint_id}" detected`);
        }
        seenIds.add(ep.endpoint_id);
      }
    }
  }

  // Capabilities 校验
  if (!Array.isArray(binding.capabilities) || binding.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array of allowed operations');
  }

  if (typeof binding.paused !== 'boolean') {
    errors.push('paused must be a boolean');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 为 Binding 对象绑定只读兼容性 ide 属性
 * 仅在恰好 1 个 IDE 端点时返回其身份，多端点时返回 undefined（不可模糊解析）
 * 消除可变 setter，确保 Lifecycle authority 唯一
 * @param {object} obj 
 */
function attachReadOnlyIdeAccessor(obj) {
  Object.defineProperty(obj, 'ide', {
    get() {
      if (this.ide_endpoints && this.ide_endpoints.length === 1) {
        return this.ide_endpoints[0];
      }
      return undefined;
    },
    enumerable: true,
    configurable: true
  });
}

/**
 * 创建新的 Binding 实例
 * @param {object} params
 * @returns {object}
 */
export function createBinding({
  binding_id,
  binding_revision = 1,
  browser,
  ide,
  ide_endpoints,
  capabilities = DEFAULT_CAPABILITIES,
  paused = false
}) {
  let normalizedIdeEndpoints = [];

  if (Array.isArray(ide_endpoints) && ide_endpoints.length > 0) {
    normalizedIdeEndpoints = ide_endpoints.map(ep => ({
      endpoint_id: ep.endpoint_id,
      endpoint_revision: ep.endpoint_revision || 1,
      conversation_id: ep.conversation_id || '',
      workspace_identity: ep.workspace_identity || '',
      repository_identity: ep.repository_identity || ''
    }));
  } else if (ide && typeof ide === 'object') {
    normalizedIdeEndpoints = [{
      endpoint_id: ide.endpoint_id || 'ide',
      endpoint_revision: ide.endpoint_revision || 1,
      conversation_id: ide.conversation_id || '',
      workspace_identity: ide.workspace_identity || '',
      repository_identity: ide.repository_identity || ''
    }];
  }

  const binding = {
    binding_id,
    binding_revision,
    browser: {
      provider: browser?.provider || 'chatgpt',
      conversation_id: browser?.conversation_id || ''
    },
    ide_endpoints: normalizedIdeEndpoints,
    capabilities: [...capabilities],
    paused: Boolean(paused),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  attachReadOnlyIdeAccessor(binding);

  const validation = validateBinding(binding);
  if (!validation.valid) {
    throw new Error(`Invalid Binding creation: ${validation.errors.join('; ')}`);
  }

  return binding;
}

/**
 * 递增 Binding 版本（任何关键身份或配置变更时触发）
 * @param {object} binding
 * @returns {object} 更新后的新 binding 对象
 */
export function bumpRevision(binding) {
  const next = {
    ...binding,
    binding_revision: binding.binding_revision + 1,
    ide_endpoints: binding.ide_endpoints ? binding.ide_endpoints.map(ep => ({ ...ep })) : [],
    updated_at: new Date().toISOString()
  };
  attachReadOnlyIdeAccessor(next);
  return next;
}

/**
 * 暂停 Binding
 * @param {object} binding 
 * @returns {object}
 */
export function pauseBinding(binding) {
  return {
    ...binding,
    paused: true,
    updated_at: new Date().toISOString()
  };
}

/**
 * 恢复 Binding
 * @param {object} binding 
 * @returns {object}
 */
export function resumeBinding(binding) {
  return {
    ...binding,
    paused: false,
    updated_at: new Date().toISOString()
  };
}
