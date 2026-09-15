/**
 * Status Core 验收与回归测试套件
 *
 * 遵循最高测试缝隙（Highest test seam）原则：
 * canonical project facts in → externally visible Status Core snapshot/view out.
 * 验证所有领域不变式、验收条件以及 Browser Review 指出的 3 个核心回归守卫。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinding, bumpRevision } from '../../src/controller/binding.js';
import { createProjectStatusCore, deriveEndpointResult } from '../../src/status/status-core.js';

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

test('[Status Core] 1. Snapshot 暴露稳定的 Project Binding 身份与版本（合法 revision bump 正常更新）', () => {
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

  // 记录 Browser 的底层规范事实（最新完成游标 turn-browser-101）
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'turn-browser-101',
    completed_at: '2026-09-15T10:00:00.000Z'
  });

  // 记录 IDE 的底层规范事实（最新完成游标 turn-ide-201）
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    latest_completed_cursor: 'turn-ide-201',
    completed_at: '2026-09-15T10:01:00.000Z'
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'NEW');
  assert.equal(snapshot.endpoints.browser.latest_completed_cursor, 'turn-browser-101');
  assert.equal(snapshot.endpoints.ide.result_state, 'NEW');
  assert.equal(snapshot.endpoints.ide.latest_completed_cursor, 'turn-ide-201');

  // 紧凑视图同样反映两端独立并存的 NEW
  const compact = core.toCompactView();
  assert.match(compact, /Browser: NEW/);
  assert.match(compact, /IDE: NEW/);
  // 严禁出现任何 Baton、owner 或 whose turn 推断
  assert.doesNotMatch(compact, /Baton|owner|turn|next_actor/i);
});

test('[Status Core] 3. NEW + UNKNOWN: Fail-closed 优先，独立可见', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // Browser 处于正常的未处理完成态 (NEW)
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'turn-browser-102'
  });

  // IDE 发生连续性断裂或归属不符，产生 UNKNOWN
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-wrong-id', // 不匹配的对话 ID
    latest_completed_cursor: 'turn-ide-301'
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

  // 两端最新完成均与 last_handled_cursor 一致（已全部处理）
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'turn-browser-50',
    last_handled_cursor: 'turn-browser-50'
  });
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    latest_completed_cursor: 'turn-ide-60',
    last_handled_cursor: 'turn-ide-60'
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
  const result = core.markEndpointHandled('browser');
  assert.equal(result.success, false);
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
});

test('[Status Core] 6. Human Intervention 独立共存且清除时不篡改 Endpoint Result', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // Browser 处于 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'b-999'
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
    latest_completed_cursor: 'b-1'
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
    latest_completed_cursor: 'b-turn-1'
  });
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    latest_completed_cursor: 'ide-turn-1',
    last_handled_cursor: 'ide-turn-1'
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

test('[Status Core] 10. 过期的 binding_revision 观察导致 UNKNOWN', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 传入错误的 revision
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    binding_revision: 99, // 当前为 1
    latest_completed_cursor: 'turn-999'
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snapshot.endpoints.browser.unknown_reason, /stale_revision/);
});

/* =========================================================================
 * 针对 Browser Review 提出的 3 个核心回归守卫 (Regression Guard Tests)
 * ========================================================================= */

test('[Regression 1] Endpoint Result 纯粹从底层规范事实确定性派生，不可写入伪造', () => {
  // 直接验证纯函数推导逻辑
  assert.equal(
    deriveEndpointResult({ continuity: { trusted: false } }),
    'UNKNOWN'
  );
  assert.equal(
    deriveEndpointResult({
      continuity: { trusted: true },
      latest_completed_cursor: 'turn-1',
      last_handled_cursor: null
    }),
    'NEW'
  );
  assert.equal(
    deriveEndpointResult({
      continuity: { trusted: true },
      latest_completed_cursor: 'turn-1',
      last_handled_cursor: 'turn-1'
    }),
    'NO_NEW_RESULT'
  );

  // 在 Core 中验证：无法通过传入 result_state: 'NO_NEW_RESULT' 来改写尚未 handled 的 cursor
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'cursor-alpha-100',
    last_handled_cursor: null,
    result_state: 'NO_NEW_RESULT' // 尝试传入伪造的状态
  });

  // 派生状态依然忠实基于 cursor 事实推导出 NEW！
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
});

test('[Regression 2] 旧的或不匹配的 cursor 调用 markEndpointHandled 绝不能清除当前 NEW', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 当前已产生最新的完成 turn-2，上次处理的是 turn-1
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'turn-2',
    last_handled_cursor: 'turn-1'
  });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 1. 尝试使用旧游标 turn-1 进行 handled 推进
  const oldResult = core.markEndpointHandled('browser', { expected_cursor: 'turn-1' });
  assert.equal(oldResult.success, false);
  assert.equal(oldResult.reason, 'cursor_mismatch');
  // 核心守卫：当前的 NEW 完好无损，绝对不会被静默抹除！
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 2. 尝试使用完全不匹配的伪造游标 turn-unknown 进行推进
  const fakeResult = core.markEndpointHandled('browser', { handled_turn_id: 'turn-unknown' });
  assert.equal(fakeResult.success, false);
  assert.equal(fakeResult.reason, 'cursor_mismatch');
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 3. 只有与当前最新完成一致的游标才能成功推进
  const validResult = core.markEndpointHandled('browser', { expected_cursor: 'turn-2' });
  assert.equal(validResult.success, true);
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(core.getSnapshot().endpoints.browser.last_handled_cursor, 'turn-2');
});

test('[Regression 3] updateBinding 禁止跨 conversation 改变 endpoint identity，防止旧事实串线', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // Browser 处于 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    latest_completed_cursor: 'b-turn-1'
  });
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 尝试将 Browser 对话改为新会话 conv-browser-beta（不安全 rebind）
  const dangerousRebind = {
    ...binding,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-beta' // 变更了会话身份
    }
  };

  assert.throws(() => {
    core.updateBinding(dangerousRebind);
  }, /Identity-changing rebind is prohibited in Status Core/);

  // 证明：旧 conversation 的状态绝对没有被挂接到新 conversation 上
  assert.equal(core.getSnapshot().binding.browser.conversation_id, 'conv-browser-alpha');
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
});
