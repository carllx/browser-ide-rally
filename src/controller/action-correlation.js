/**
 * 动作完成关联与生命周期推进模块 (Action Completion Correlation)
 * 
 * 核心设计准则 (#18):
 * 1. 严格关联：当且仅当具备可靠关联证据（nonce / correlation_id / action_id）时，
 *    才允许推进 Action 事实至 TARGET_COMPLETED；
 * 2. 零猜测契约：严禁将无关的 Endpoint Result 或无关联证据的观察冒领为动作完成；
 * 3. 独立事实平面：Action 完成推进绝不改写端点的 last_handled_cursor 或伪造 NO_NEW_RESULT。
 */

import { correlateActionCompletion } from '../status/action-ledger.js';

/**
 * 校验并推进关联动作完成
 * @param {object} params
 * @param {object} params.core - ProjectStatusCore 实例
 * @param {object} params.observation - 端点观察结果或外部完成事实
 * @returns {object|null} 推进更新后的 Action，若无关联动作则返回 null
 */
export function correlateAndAdvanceActionCompletion({ core, observation }) {
  if (!core || !observation || typeof observation !== 'object') {
    return null;
  }

  const snapshot = core.getSnapshot();
  const actions = snapshot.actions || [];

  // 仅在 ACCEPTED_OR_DELIVERED 或 UNKNOWN 状态下可推进至 TARGET_COMPLETED
  const candidate = actions.find(a => correlateActionCompletion(a, observation));

  if (candidate) {
    return core.advanceActionStage(candidate.action_id, {
      next_stage: 'TARGET_COMPLETED',
      evidence: observation.completion_evidence || `Correlated completion observed via nonce ${observation.nonce || candidate.nonce}`
    });
  }

  return null;
}
