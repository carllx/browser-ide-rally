/**
 * Rally Binding 数据模型与校验
 * 拓扑：1 Browser conversation ↔ 1 Rally binding ↔ 1 target IDE conversation
 */

export const DEFAULT_CAPABILITIES = ['rally.echo'];

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

  // IDE 身份校验
  if (!binding.ide || typeof binding.ide !== 'object') {
    errors.push('ide identity object is required');
  } else {
    if (typeof binding.ide.conversation_id !== 'string' || !binding.ide.conversation_id.trim()) {
      errors.push('ide.conversation_id must be a non-empty string');
    }
    if (typeof binding.ide.workspace_identity !== 'string' || !binding.ide.workspace_identity.trim()) {
      errors.push('ide.workspace_identity must be a non-empty string');
    }
    if (typeof binding.ide.repository_identity !== 'string' || !binding.ide.repository_identity.trim()) {
      errors.push('ide.repository_identity must be a non-empty string');
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
 * 创建新的 Binding 实例
 * @param {object} params
 * @returns {object}
 */
export function createBinding({
  binding_id,
  binding_revision = 1,
  browser,
  ide,
  capabilities = DEFAULT_CAPABILITIES,
  paused = false
}) {
  const binding = {
    binding_id,
    binding_revision,
    browser: {
      provider: browser?.provider || 'chatgpt',
      conversation_id: browser?.conversation_id || ''
    },
    ide: {
      conversation_id: ide?.conversation_id || '',
      workspace_identity: ide?.workspace_identity || '',
      repository_identity: ide?.repository_identity || ''
    },
    capabilities: [...capabilities],
    paused: Boolean(paused),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

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
  return {
    ...binding,
    binding_revision: binding.binding_revision + 1,
    updated_at: new Date().toISOString()
  };
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
