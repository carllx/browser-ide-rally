/**
 * Status Core 验收测试套件
 *
 * 遵循最高测试缝隙（Highest test seam）原则：
 * canonical project facts in → externally visible Status Core snapshot/view out.
 * 验证所有领域不变式与验收条件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinding, bumpRevision } from '../../src/controller/binding.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';

function createSampleBinding(overrides = {}) {
  return createBinding({
    binding_id: 'bind-tracer-001',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-alpha'
    },
    ide: {
      conversation_id: 'conv-ide-alpha',
      workspace_identity: 'file:///workspace/rally',
      repository_identity: 'carllx/browser-ide-rally'
    },
    ...overrides
  });
}

test('[Status Core] 1. Snapshot 暴露稳定的 Project Binding 身份与版本', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.binding.binding_id, 'bind-tracer-001');
  assert.equal(snapshot.binding.binding_revision, 1);
  assert.equal(snapshot.binding.browser.conversation_id, 'conv-browser-alpha');
  assert.equal(snapshot.binding.ide.conversation_id, 'conv-ide-alpha');

  // 当 binding revision 递增更新时，snapshot 能够准确反映新 revision
  const bumped = bumpRevision(binding);
  core.updateBinding(bumped);

  const updatedSnapshot = core.getSnapshot();
  assert.equal(updatedSnapshot.binding.binding_revision, 2);
  assert.match(core.toCompactView(), /bind-tracer-001@rev2/);
});

test('[Status Core] 2. Dual NEW: Browser=NEW 与 IDE=NEW 能够独立共存，不相互掩盖', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 记录 Browser 的新完成
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    has_unhandled_completion: true,
    turn_id: 'turn-browser-101',
    completed_at: '2026-09-15T10:00:00.000Z'
  });

  // 记录 IDE 的新完成
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    has_unhandled_completion: true,
    turn_id: 'turn-ide-201',
    completed_at: '2026-09-15T10:01:00.000Z'
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW');
  assert.equal(snapshot.endpoints.browser.turn_id, 'turn-browser-101');
  assert.equal(snapshot.endpoints.ide.result_state, 'NEW');
  assert.equal(snapshot.endpoints.ide.turn_id, 'turn-ide-201');

  // 紧凑视图同样反映两端并存的 NEW
  const compact = core.toCompactView();
  assert.match(compact, /Browser: NEW/);
  assert.match(compact, /IDE: NEW/);
  // 严禁出现任何 Baton、owner 或 whose turn 推断
  assert.doesNotMatch(compact, /Baton|owner|turn|next_actor/i);
});

test('[Status Core] 3. NEW + UNKNOWN: Fail-closed 优先，独立可见', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // Browser 处于 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    result_state: 'NEW',
    turn_id: 'turn-browser-102'
  });

  // IDE 发生连续性断裂或归属不符，产生 UNKNOWN
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-wrong-id', // 不匹配的对话 ID
    has_unhandled_completion: true
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW');
  assert.equal(snapshot.endpoints.ide.result_state, 'UNKNOWN');
  assert.match(snapshot.endpoints.ide.unknown_reason, /attribution_mismatch/);

  const compact = core.toCompactView();
  assert.match(compact, /Browser: NEW/);
  assert.match(compact, /IDE: UNKNOWN/);
});

test('[Status Core] 4. Both caught up: 两端均处于 NO_NEW_RESULT', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 两端均无未处理完成
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    has_unhandled_completion: false
  });
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    has_unhandled_completion: false
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(snapshot.endpoints.ide.result_state, 'NO_NEW_RESULT');

  const compact = core.toCompactView();
  assert.match(compact, /Browser: NO_NEW_RESULT/);
  assert.match(compact, /IDE: NO_NEW_RESULT/);
});

test('[Status Core] 5. UNKNOWN 优先级高于便利推断，严禁 IDLE', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 尝试传入 IDLE 观察，必须 fail-closed 为 UNKNOWN
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    result_state: 'IDLE'
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snapshot.endpoints.browser.unknown_reason, /disallowed_idle_state/);

  // 当处于 UNKNOWN 时，执行 markEndpointHandled 不能凭空推断为 NO_NEW_RESULT
  core.markEndpointHandled('browser');
  const snapshotAfterHandled = core.getSnapshot();
  assert.equal(snapshotAfterHandled.endpoints.browser.result_state, 'UNKNOWN');
});

test('[Status Core] 6. Human Intervention 独立共存且清除时不篡改 Endpoint Result', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // Browser 处于 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    result_state: 'NEW',
    turn_id: 'b-999'
  });

  // 设置人工介入事实
  core.setHumanIntervention({
    active: true,
    reason: 'Security review required before commit'
  });

  let snapshot = core.getSnapshot();
  assert.equal(snapshot.human_intervention.active, true);
  assert.equal(snapshot.human_intervention.reason, 'Security review required before commit');
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW'); // 保持 NEW

  let compact = core.toCompactView();
  assert.match(compact, /Human: REQUIRED \(Security review required before commit\)/);
  assert.match(compact, /Browser: NEW/);

  // 清除人工介入事实
  core.clearHumanIntervention();
  snapshot = core.getSnapshot();
  assert.equal(snapshot.human_intervention.active, false);
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW'); // 依然保持 NEW

  compact = core.toCompactView();
  assert.match(compact, /Human: NONE/);
  assert.match(compact, /Browser: NEW/);
});

test('[Status Core] 7. Action 事实独立演进，不改写 Endpoint Result', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    result_state: 'NEW',
    turn_id: 'b-1'
  });

  // 记录新动作请求
  const action = core.recordActionFact({
    action_id: 'act-001',
    action_type: 'send',
    target_endpoint: 'ide',
    stage: 'REQUESTED'
  });
  assert.equal(action.stage, 'REQUESTED');

  let snapshot = core.getSnapshot();
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].stage, 'REQUESTED');
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW'); // 端点状态未被修改

  // 推进到 SUBMITTED_LOCALLY
  core.advanceActionStage('act-001', {
    next_stage: 'SUBMITTED_LOCALLY',
    evidence: { local_submission_time: '2026-09-15T10:10:00Z' }
  });

  snapshot = core.getSnapshot();
  assert.equal(snapshot.actions[0].stage, 'SUBMITTED_LOCALLY');
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW'); // 依然未被篡改

  // 无法逆向推进阶段
  assert.throws(() => {
    core.advanceActionStage('act-001', {
      next_stage: 'REQUESTED',
      evidence: null
    });
  }, /Cannot transition backwards/);

  // 推进到 ACCEPTED_OR_DELIVERED
  core.advanceActionStage('act-001', {
    next_stage: 'ACCEPTED_OR_DELIVERED',
    evidence: { ack_id: 'ack-777' }
  });
  snapshot = core.getSnapshot();
  assert.equal(snapshot.actions[0].stage, 'ACCEPTED_OR_DELIVERED');
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW');
});

test('[Status Core] 8. 机器可读快照与紧凑视图同源且不包含 Baton / Owner 字段', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    result_state: 'NEW',
    turn_id: 'b-turn-1'
  });
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    result_state: 'NO_NEW_RESULT'
  });

  const snapshot = core.getSnapshot();
  const compact = core.toCompactView();

  // 验证快照无 owner/baton 结构
  assert.equal(snapshot.owner, undefined);
  assert.equal(snapshot.baton, undefined);
  assert.equal(snapshot.next_actor, undefined);
  assert.equal(snapshot.whose_turn, undefined);

  // 验证紧凑视图包含两端确定事实
  assert.ok(compact.includes('Browser: NEW'));
  assert.ok(compact.includes('IDE: NO_NEW_RESULT'));
  assert.doesNotMatch(compact, /Baton|owner|turn|next_actor/i);
});

test('[Status Core] 9. 完全无需 Relay Exchange 即可运作', () => {
  const binding = createSampleBinding();
  // 没有任何 Exchange 导入或引用，纯粹基于 Binding 和 StatusCore
  const core = createProjectStatusCore({ binding });

  assert.ok(core);
  assert.equal(typeof core.recordEndpointObservation, 'function');
  assert.equal(typeof core.getSnapshot, 'function');
  assert.equal(typeof core.toCompactView, 'function');

  const snapshot = core.getSnapshot();
  // 验证快照中没有 exchange 依赖结构
  assert.equal(snapshot.exchange, undefined);
});

test('[Status Core] 10. 显式 Mark Handled 将 NEW 转为 NO_NEW_RESULT', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    has_unhandled_completion: true,
    turn_id: 'ide-turn-888'
  });

  assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');

  core.markEndpointHandled('ide', { handled_turn_id: 'ide-turn-888' });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.ide.result_state, 'NO_NEW_RESULT');
  assert.equal(snapshot.endpoints.ide.last_handled_turn_id, 'ide-turn-888');
});

test('[Status Core] 11. 过期的 binding_revision 观察导致 UNKNOWN', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 传入错误的 revision
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    binding_revision: 99, // 当前为 1
    has_unhandled_completion: true
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snapshot.endpoints.browser.unknown_reason, /stale_revision/);
});
