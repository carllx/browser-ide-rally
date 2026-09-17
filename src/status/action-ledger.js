/**
 * Action Ledger — 动作事实与阶段流转管理模块
 * 
 * 领域不变式：
 * 1. 记录与流转与 Endpoint Result 彻底独立共存；
 * 2. 严格按阶段正向推进，禁止倒退或横向跳转。
 */

export const ALLOWED_ACTION_STAGES = [
  'REQUESTED',
  'SUBMITTED_LOCALLY',
  'ACCEPTED_OR_DELIVERED',
  'TARGET_COMPLETED',
  'BLOCKED',
  'FAILED',
  'UNKNOWN'
];

export const TERMINAL_ACTION_STAGES = [
  'TARGET_COMPLETED',
  'BLOCKED',
  'FAILED'
];

const VALID_ACTION_TRANSITIONS = {
  REQUESTED: ['SUBMITTED_LOCALLY', 'BLOCKED', 'FAILED', 'UNKNOWN'],
  SUBMITTED_LOCALLY: ['ACCEPTED_OR_DELIVERED', 'TARGET_COMPLETED', 'BLOCKED', 'FAILED', 'UNKNOWN'],
  ACCEPTED_OR_DELIVERED: ['TARGET_COMPLETED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['TARGET_COMPLETED', 'FAILED'],
  BLOCKED: [],
  FAILED: [],
  TARGET_COMPLETED: []
};

export function createActionFact({
  action_id,
  action_type = 'action',
  target_endpoint,
  stage = 'REQUESTED',
  binding_revision,
  payload = null,
  nonce = null,
  correlation_id = null,
  evidence = null
}) {
  if (!action_id || typeof action_id !== 'string') {
    throw new Error('action_id is required and must be a string');
  }
  if (!ALLOWED_ACTION_STAGES.includes(stage)) {
    throw new Error(`Invalid action stage "${stage}"`);
  }

  const now = new Date().toISOString();
  return {
    action_id,
    action_type,
    target_endpoint: target_endpoint || null,
    stage,
    binding_revision,
    payload,
    nonce: nonce || null,
    correlation_id: correlation_id || null,
    evidence,
    created_at: now,
    updated_at: now
  };
}

export function transitionActionStage(action, { next_stage, evidence }) {
  if (!action || typeof action !== 'object') {
    throw new Error('Action must be a valid object');
  }
  if (!ALLOWED_ACTION_STAGES.includes(next_stage)) {
    throw new Error(`Invalid target stage "${next_stage}"`);
  }

  const currentStage = action.stage;
  if (TERMINAL_ACTION_STAGES.includes(currentStage)) {
    throw new Error(`Cannot transition from ${currentStage} to ${next_stage}: ${currentStage} is a terminal state`);
  }

  const allowedNext = VALID_ACTION_TRANSITIONS[currentStage] || [];
  if (!allowedNext.includes(next_stage)) {
    throw new Error(`Cannot transition backwards or invalid step from ${currentStage} to ${next_stage}`);
  }

  const now = new Date().toISOString();
  action.stage = next_stage;
  action.evidence = evidence !== undefined ? evidence : action.evidence;
  action.updated_at = now;

  return { ...action };
}

/**
 * 校验目标完成观察是否具备可靠的关联凭证以推进对应 Action
 * 严禁将无关的新观察结果错误归属于某个动作
 * @param {object} action - Action 记录
 * @param {object} observation - 接收到的完成观察或事实
 * @returns {boolean}
 */
export function correlateActionCompletion(action, observation = {}) {
  if (!action || typeof action !== 'object' || !observation || typeof observation !== 'object') {
    return false;
  }
  if (!['ACCEPTED_OR_DELIVERED', 'UNKNOWN'].includes(action.stage)) {
    return false;
  }
  if (action.nonce && observation.nonce && action.nonce === observation.nonce) {
    return true;
  }
  if (action.correlation_id && observation.correlation_id && action.correlation_id === observation.correlation_id) {
    return true;
  }
  if (action.action_id && observation.action_id && action.action_id === observation.action_id) {
    return true;
  }
  return false;
}
