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
  'TARGET_COMPLETED'
];

export function createActionFact({
  action_id,
  action_type = 'action',
  target_endpoint,
  stage = 'REQUESTED',
  binding_revision,
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
    evidence,
    created_at: now,
    updated_at: now
  };
}

export function transitionActionStage(action, { next_stage, evidence }) {
  if (!action) {
    throw new Error('Action must be a valid object');
  }
  if (!ALLOWED_ACTION_STAGES.includes(next_stage)) {
    throw new Error(`Invalid target stage "${next_stage}"`);
  }

  const currentIndex = ALLOWED_ACTION_STAGES.indexOf(action.stage);
  const nextIndex = ALLOWED_ACTION_STAGES.indexOf(next_stage);

  if (nextIndex <= currentIndex) {
    throw new Error(`Cannot transition backwards or sideways from ${action.stage} to ${next_stage}`);
  }

  const now = new Date().toISOString();
  action.stage = next_stage;
  action.evidence = evidence ?? action.evidence;
  action.updated_at = now;

  return { ...action };
}
