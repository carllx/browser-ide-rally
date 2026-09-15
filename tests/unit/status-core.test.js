/**
 * Status Core 验收与回归测试套件
 *
 * 遵循最高测试缝隙（Highest test seam）原则：
 * canonical project facts in → externally visible Status Core snapshot/view out.
 * 验证所有领域不变式、验收条件以及两轮 Browser Review 与 Code Review 发现的核心回归守卫。
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

  // 记录 Browser 的显式受信任底层规范事实（最新完成游标 turn-browser-101）
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'turn-browser-101',
    completed_at: '2026-09-15T10:00:00.000Z'
  });

  // 记录 IDE 的显式受信任底层规范事实（最新完成游标 turn-ide-201）
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    trusted: true,
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
    trusted: true,
    latest_completed_cursor: 'turn-browser-102'
  });

  // IDE 发生连续性断裂或归属不符，产生 UNKNOWN
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-wrong-id', // 不匹配的对话 ID
    trusted: true,
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

test('[Status Core] 4. Both caught up: 通过显式 Mark handled 推进达成两端 NO_NEW_RESULT', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 两端先接收到可靠的完成
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'turn-browser-50'
  });
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    trusted: true,
    latest_completed_cursor: 'turn-ide-60'
  });

  // 确认两端处于 NEW
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');

  // 通过显式 markEndpointHandled 推进
  const bResult = core.markEndpointHandled('browser', { expected_cursor: 'turn-browser-50' });
  const iResult = core.markEndpointHandled('ide', { expected_cursor: 'turn-ide-60' });

  assert.equal(bResult.success, true);
  assert.equal(iResult.success, true);

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
    trusted: true,
    result_state: 'IDLE'
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snapshot.endpoints.browser.unknown_reason, /disallowed_idle_state/);

  // 当处于 UNKNOWN 时，执行 markEndpointHandled 不能凭空推断为 NO_NEW_RESULT
  const result = core.markEndpointHandled('browser', { expected_cursor: 'any' });
  assert.equal(result.success, false);
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
});

test('[Status Core] 6. Human Intervention 独立共存且清除时不篡改 Endpoint Result', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // Browser 处于 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
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
    trusted: true,
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
    trusted: true,
    latest_completed_cursor: 'b-turn-1'
  });
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-alpha',
    trusted: true,
    latest_completed_cursor: 'ide-turn-1'
  });
  core.markEndpointHandled('ide', { expected_cursor: 'ide-turn-1' });

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
    trusted: true,
    binding_revision: 99, // 当前为 1
    latest_completed_cursor: 'turn-999'
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snapshot.endpoints.browser.unknown_reason, /stale_revision/);
});

/* =========================================================================
 * 核心回归守卫测试 (Regression Guard Tests - Passes 1 & 2 & Code Review)
 * ========================================================================= */

test('[Regression 1] Endpoint Result 纯粹从底层规范事实确定性派生，不可写入伪造', () => {
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

  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'cursor-alpha-100',
    result_state: 'NO_NEW_RESULT' // 尝试伪造状态
  });

  // 派生状态依然忠实基于 cursor 事实推导出 NEW！
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
});

test('[Regression 2] 旧的或不匹配的 cursor 调用 markEndpointHandled 绝不能清除当前 NEW', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'turn-2'
  });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 1. 尝试使用旧游标 turn-1 进行 handled 推进
  const oldResult = core.markEndpointHandled('browser', { expected_cursor: 'turn-1' });
  assert.equal(oldResult.success, false);
  assert.equal(oldResult.reason, 'cursor_mismatch');
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 2. 尝试使用完全不匹配的伪造游标 turn-unknown 进行推进
  const fakeResult = core.markEndpointHandled('browser', { expected_cursor: 'turn-unknown' });
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

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'b-turn-1'
  });
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  const dangerousRebind = {
    ...binding,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-beta'
    }
  };

  assert.throws(() => {
    core.updateBinding(dangerousRebind);
  }, /Identity-changing rebind is prohibited in Status Core/);

  assert.equal(core.getSnapshot().binding.browser.conversation_id, 'conv-browser-alpha');
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
});

test('[Regression 4] observation 无法写入/修改 last_handled_cursor 或静默清掉 NEW', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 建立 NEW 状态
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'cursor-123'
  });
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.equal(core.getSnapshot().endpoints.browser.last_handled_cursor, null);

  // 尝试在 observation 中注入 last_handled_cursor
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    last_handled_cursor: 'cursor-123'
  });

  // 核心守卫：last_handled_cursor 绝不被 observation 写入，NEW 依然完好无损！
  assert.equal(core.getSnapshot().endpoints.browser.last_handled_cursor, null);
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
});

test('[Regression 5] 空或不充分 observation 不能把初始 UNKNOWN 变成 NO_NEW_RESULT', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');

  // 传入完全空的 observation
  core.recordEndpointObservation('browser', {});
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');

  // 传入仅含 conversation_id 但缺少显式 trusted 证据的 observation
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha'
  });
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
  assert.match(core.getSnapshot().endpoints.browser.unknown_reason, /unverified_continuity/);
});

test('[Regression 6] 伪造的 convenience result_state 无法建立 trust 或达成 caught-up 状态', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 仅传入 result_state: 'NO_NEW_RESULT'，未提供显式 trust
  core.recordEndpointObservation('browser', {
    result_state: 'NO_NEW_RESULT'
  });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');

  // 传入 conversation_id + result_state: 'NO_NEW_RESULT'，但依然没有 trusted 证据
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    result_state: 'NO_NEW_RESULT'
  });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
});

test('[Regression 7] 显式 trusted 且确实无未处理完成时正确派生 NO_NEW_RESULT', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 明确提供 trusted: true，且无完成游标（无未处理完成）
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: null
  });

  const snapshot = core.getSnapshot();
  assert.equal(snapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(snapshot.endpoints.browser.continuity.trusted, true);
  assert.equal(snapshot.endpoints.browser.unknown_reason, null);
});

test('[Regression 8] 未受信的 observation 绝不能将脏游标写入规范状态', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  // 初始游标为 null
  assert.equal(core.getSnapshot().endpoints.browser.latest_completed_cursor, null);

  // 传入一个未受信的 observation（例如缺少 trusted 声明，或者归属不匹配），附带游标
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    // 缺少 trusted: true
    latest_completed_cursor: 'dirty-cursor-999'
  });

  // 核心守卫：未受信观察的游标绝不被写入底层！
  assert.equal(core.getSnapshot().endpoints.browser.latest_completed_cursor, null);
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
});

test('[Regression 9] 假值游标（如数字 0 或空字符串）能正确派生为 NEW 而非被错误漏判', () => {
  assert.equal(
    deriveEndpointResult({
      continuity: { trusted: true },
      latest_completed_cursor: 0,
      last_handled_cursor: null
    }),
    'NEW'
  );

  assert.equal(
    deriveEndpointResult({
      continuity: { trusted: true },
      latest_completed_cursor: '',
      last_handled_cursor: null
    }),
    'NEW'
  );
});

test('[Regression 10] 未提供 expected_cursor 时 markEndpointHandled 强制拒绝盲目推进', () => {
  const binding = createSampleBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-alpha',
    trusted: true,
    latest_completed_cursor: 'turn-999'
  });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 未提供 expected_cursor，拒绝盲目推进
  const result = core.markEndpointHandled('browser');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'cursor_mismatch');
  // NEW 完好无损
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
});
