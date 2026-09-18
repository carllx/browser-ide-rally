/**
 * 安全控制公共工具与状态辅助模块 (Safe Controls Common Utilities)
 * 
 * 核心契约：
 * 1. 严格版本核验：expected_binding_revision 缺失或陈旧直接 Fail-Closed；
 * 2. 统一阻断记录：失配时在只读状态表面保留 BLOCKED Action 事实；
 * 3. 精准端点寻址：支持 Map 与对象形式的 IDE 适配器解析。
 */

/**
 * 生成规范 Action ID
 * @returns {string}
 */
export function generateActionId() {
  return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 生成规范 Nonce 防重放凭据
 * @returns {string}
 */
export function generateNonce() {
  return `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 校验期望版本并解析项目核心及当前快照
 * @param {object} registry - ProjectRegistry 实例
 * @param {string} bindingId - 项目 Binding ID
 * @param {number} expectedRevision - 期望的 Binding 版本
 * @returns {{ core: object, currentBinding: object }}
 */
export function resolveProjectAndValidateRevision(registry, bindingId, expectedRevision) {
  if (!registry || typeof registry.getProject !== 'function') {
    throw new Error('Valid ProjectRegistry is required for safe control execution');
  }
  if (!bindingId || typeof bindingId !== 'string') {
    throw new Error('Valid bindingId is required');
  }

  if (expectedRevision === undefined || expectedRevision === null || !Number.isInteger(expectedRevision)) {
    throw new Error('STALE_OR_MISSING_BINDING_REVISION: expected_binding_revision is required and must be an integer');
  }

  const core = registry.getProject(bindingId);
  const snapshot = core.getSnapshot();
  const currentBinding = snapshot.binding;

  if (currentBinding.binding_revision !== expectedRevision) {
    throw new Error(
      `STALE_OR_MISSING_BINDING_REVISION: Expected revision ${expectedRevision}, but canonical revision is ${currentBinding.binding_revision}`
    );
  }

  return { core, currentBinding };
}

/**
 * 当操作被阻断时记录 BLOCKED 事实，保证 Action 平面事实可见且只读表面完好
 * @param {object} registry
 * @param {string} bindingId
 * @param {object} params
 */
export function recordBlockedAction(registry, bindingId, {
  actionId,
  actionType,
  targetEndpoint,
  expectedRevision,
  reason
}) {
  try {
    if (registry && typeof registry.hasProject === 'function' && registry.hasProject(bindingId)) {
      const core = registry.getProject(bindingId);
      const action = core.recordActionFact({
        action_id: actionId,
        action_type: actionType,
        target_endpoint: targetEndpoint || null,
        stage: 'REQUESTED',
        binding_revision: expectedRevision ?? 0,
        evidence: reason
      });
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: reason
      });
    }
  } catch {
    // 保护调用栈，防止阻断事实记录本身的错误覆盖主要领域错误
  }
}

/**
 * 解析特定端点的 IDE 适配器
 * @param {Map|object} ideAdapters
 * @param {string} endpointId
 * @returns {object|null}
 */
export function resolveIdeAdapter(ideAdapters, endpointId) {
  if (!ideAdapters) return null;
  if (ideAdapters instanceof Map) {
    return ideAdapters.get(endpointId) || null;
  }
  if (typeof ideAdapters === 'object') {
    if (ideAdapters[endpointId]) {
      return ideAdapters[endpointId];
    }
    return ideAdapters;
  }
  return null;
}
