import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ACTION_STAGES,
  TERMINAL_ACTION_STAGES,
  createActionFact,
  transitionActionStage,
  correlateActionCompletion
} from '../../src/status/action-ledger.js';

test('[Action Ledger] 1. 完整支持至少 7 个规范阶段', () => {
  const expectedStages = [
    'REQUESTED',
    'SUBMITTED_LOCALLY',
    'ACCEPTED_OR_DELIVERED',
    'TARGET_COMPLETED',
    'BLOCKED',
    'FAILED',
    'UNKNOWN'
  ];
  for (const st of expectedStages) {
    assert.ok(ALLOWED_ACTION_STAGES.includes(st), `Missing stage: ${st}`);
  }
});

test('[Action Ledger] 2. 创建 Action 事实并校验必填字段与默认值', () => {
  const fact = createActionFact({
    action_id: 'act-001',
    action_type: 'send',
    target_endpoint: 'browser',
    binding_revision: 2,
    nonce: 'nonce-123',
    evidence: { reason: 'User requested dispatch' }
  });

  assert.equal(fact.action_id, 'act-001');
  assert.equal(fact.action_type, 'send');
  assert.equal(fact.target_endpoint, 'browser');
  assert.equal(fact.stage, 'REQUESTED');
  assert.equal(fact.binding_revision, 2);
  assert.equal(fact.nonce, 'nonce-123');
  assert.ok(fact.created_at);
  assert.ok(fact.updated_at);

  assert.throws(() => {
    createActionFact({ action_id: '' });
  }, /action_id is required/);

  assert.throws(() => {
    createActionFact({ action_id: 'act-err', stage: 'INVALID_STAGE' });
  }, /Invalid action stage/);
});

test('[Action Ledger] 3. 合法阶段正向推进流转', () => {
  const act = createActionFact({
    action_id: 'act-flow',
    target_endpoint: 'ide-a',
    binding_revision: 1
  });

  // REQUESTED -> SUBMITTED_LOCALLY
  transitionActionStage(act, {
    next_stage: 'SUBMITTED_LOCALLY',
    evidence: 'DOM composer submit clicked'
  });
  assert.equal(act.stage, 'SUBMITTED_LOCALLY');
  assert.equal(act.evidence, 'DOM composer submit clicked');

  // SUBMITTED_LOCALLY -> ACCEPTED_OR_DELIVERED
  transitionActionStage(act, {
    next_stage: 'ACCEPTED_OR_DELIVERED',
    evidence: 'Assistant ACK observed'
  });
  assert.equal(act.stage, 'ACCEPTED_OR_DELIVERED');

  // ACCEPTED_OR_DELIVERED -> TARGET_COMPLETED
  transitionActionStage(act, {
    next_stage: 'TARGET_COMPLETED',
    evidence: 'Target artifact confirmed with nonce'
  });
  assert.equal(act.stage, 'TARGET_COMPLETED');
});

test('[Action Ledger] 4. 支持由任意前置阶段流转至 BLOCKED / FAILED / UNKNOWN', () => {
  const actBlocked = createActionFact({
    action_id: 'act-blocked',
    target_endpoint: 'browser',
    binding_revision: 1
  });
  transitionActionStage(actBlocked, {
    next_stage: 'BLOCKED',
    evidence: 'stale_or_missing_binding_revision'
  });
  assert.equal(actBlocked.stage, 'BLOCKED');

  const actFailed = createActionFact({
    action_id: 'act-failed',
    target_endpoint: 'ide-b',
    binding_revision: 1
  });
  transitionActionStage(actFailed, {
    next_stage: 'SUBMITTED_LOCALLY',
    evidence: 'CLI invoked'
  });
  transitionActionStage(actFailed, {
    next_stage: 'FAILED',
    evidence: 'Transport connection dropped'
  });
  assert.equal(actFailed.stage, 'FAILED');

  const actUnknown = createActionFact({
    action_id: 'act-unknown',
    target_endpoint: 'browser',
    binding_revision: 1
  });
  transitionActionStage(actUnknown, {
    next_stage: 'SUBMITTED_LOCALLY',
    evidence: 'DOM submitted'
  });
  transitionActionStage(actUnknown, {
    next_stage: 'UNKNOWN',
    evidence: 'Delivery unconfirmed within timeout'
  });
  assert.equal(actUnknown.stage, 'UNKNOWN');
});

test('[Action Ledger] 5. 严格禁止倒退或横向非法跳转，终态禁止再次流转', () => {
  const act = createActionFact({
    action_id: 'act-jump',
    target_endpoint: 'ide-a',
    binding_revision: 1
  });
  transitionActionStage(act, { next_stage: 'BLOCKED', evidence: 'blocked' });

  // 终态 BLOCKED 禁止再转
  assert.throws(() => {
    transitionActionStage(act, { next_stage: 'REQUESTED' });
  }, /Cannot transition from BLOCKED/);

  assert.throws(() => {
    transitionActionStage(act, { next_stage: 'TARGET_COMPLETED' });
  }, /Cannot transition from BLOCKED/);

  const actDone = createActionFact({
    action_id: 'act-done',
    target_endpoint: 'browser',
    binding_revision: 1
  });
  transitionActionStage(actDone, { next_stage: 'SUBMITTED_LOCALLY' });
  transitionActionStage(actDone, { next_stage: 'ACCEPTED_OR_DELIVERED' });
  transitionActionStage(actDone, { next_stage: 'TARGET_COMPLETED' });

  // 终态 TARGET_COMPLETED 禁止倒退
  assert.throws(() => {
    transitionActionStage(actDone, { next_stage: 'SUBMITTED_LOCALLY' });
  }, /Cannot transition from TARGET_COMPLETED/);
});

test('[Action Ledger] 6. correlateActionCompletion 严格校验关联凭证，非关联完成绝不推进 Action', () => {
  const act = createActionFact({
    action_id: 'act-corr-1',
    target_endpoint: 'ide-a',
    binding_revision: 1,
    nonce: 'unique-nonce-xyz',
    correlation_id: 'corr-999'
  });
  act.stage = 'ACCEPTED_OR_DELIVERED';

  // 1. 无凭证或非关联完成观察 -> 严禁归属
  assert.equal(correlateActionCompletion(act, { latest_completed_cursor: 'turn-99' }), false);
  assert.equal(correlateActionCompletion(act, { nonce: 'different-nonce' }), false);
  assert.equal(correlateActionCompletion(act, {}), false);

  // 2. 匹配 nonce -> 归属成功
  assert.equal(correlateActionCompletion(act, { nonce: 'unique-nonce-xyz' }), true);

  // 3. 匹配 correlation_id -> 归属成功
  assert.equal(correlateActionCompletion(act, { correlation_id: 'corr-999' }), true);

  // 4. 处于非投递阶段 (如 REQUESTED) 即使有相同 nonce 也不能归属完成
  const earlyAct = createActionFact({
    action_id: 'act-early',
    target_endpoint: 'ide-a',
    binding_revision: 1,
    nonce: 'unique-nonce-xyz'
  });
  assert.equal(correlateActionCompletion(earlyAct, { nonce: 'unique-nonce-xyz' }), false);
});
