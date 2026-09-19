import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSafeContinue } from '../../src/controller/safe-continue.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import {
  setupMultiEndpointFixture,
  createMockBrowserAdapter,
  createMockIdeAdapter
} from './safe-continue.test.js';

test('Safe Continue Guards — 1. Source 为 UNKNOWN: 拦截为 BLOCKED，目标零副作用', () => {
  const { registry, core } = setupMultiEndpointFixture();
  let promptAttempted = false;
  const browserAdapter = {
    sendTextPrompt: () => { promptAttempted = true; }
  };

  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'UNKNOWN');

  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'UNKNOWN',
      browserAdapter
    });
  }, /SOURCE_ENDPOINT_UNKNOWN|BLOCKED/);

  assert.strictEqual(promptAttempted, false);
  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].action_type, 'continue');
  assert.strictEqual(actions[0].stage, 'BLOCKED');
});

test('Safe Continue Guards — 2. 防漂移守卫: 请求形成与执行之间源端点发生改变严格 BLOCKED', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  // 场景 A: 形成请求时是 NO_NEW_RESULT，执行前 source 产生了 NEW
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-initial',
    latest_completed_result: {
      cursor: 'cur-initial',
      result_ref: 'ref-init',
      text: 'Init',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });
  core.markEndpointHandled('ide-1', { expected_cursor: 'cur-initial' });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');

  // 突然产生新完成
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-newer',
    latest_completed_result: {
      cursor: 'cur-newer',
      result_ref: 'ref-newer',
      text: 'Newer unhandled',
      captured_at: '2026-09-18T10:05:00Z'
    }
  });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');

  // 用户请求传入的仍是形成时的 NO_NEW_RESULT 期望
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NO_NEW_RESULT',
      expected_source_cursor: 'cur-initial',
      browserAdapter
    });
  }, /STALE_SOURCE_CONTEXT/);

  // 场景 B: 形成请求时是 NEW (cur-newer)，执行前又更新成了 (cur-even-newer)
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-even-newer',
    latest_completed_result: {
      cursor: 'cur-even-newer',
      result_ref: 'ref-even-newer',
      text: 'Even newer',
      captured_at: '2026-09-18T10:10:00Z'
    }
  });

  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: 'cur-newer',
      expected_source_result_ref: 'ref-newer',
      browserAdapter
    });
  }, /STALE_SOURCE_CONTEXT/);
});

test('Safe Continue Guards — 3. NEW source 缺失结果材料时 Fail-Closed BLOCKED', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-no-artifact'
  });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].latest_completed_result, null);

  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: 'cur-no-artifact',
      expected_source_result_ref: 'ref-any',
      browserAdapter
    });
  }, /SOURCE_RESULT_UNAVAILABLE/);

  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
});

test('Safe Continue Guards — 4. 载荷超限防御: 超大结果正文严格 BLOCKED，绝不静默截断', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  const hugeText = 'X'.repeat(70 * 1024);
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-huge',
    latest_completed_result: {
      cursor: 'cur-huge',
      result_ref: 'ref-huge',
      text: hugeText,
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: 'cur-huge',
      expected_source_result_ref: 'ref-huge',
      browserAdapter
    });
  }, /PAYLOAD_TOO_LARGE|Envelope payload exceeds bound/);

  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].action_type, 'continue');
  assert.strictEqual(actions[0].stage, 'BLOCKED');
});

test('Safe Continue Guards — 5. 跨项目隔离: 项目 A 动作绝不包含项目 B 的结果正文', () => {
  const registry = createProjectRegistry();
  const b1 = createBinding({
    binding_id: 'proj-A',
    browser: { provider: 'chatgpt', conversation_id: 'conv-A' },
    ide: { conversation_id: 'conv-A-ide', workspace_identity: '/ws-a', repository_identity: 'org/repo' }
  });
  const b2 = createBinding({
    binding_id: 'proj-B',
    browser: { provider: 'chatgpt', conversation_id: 'conv-B' },
    ide: { conversation_id: 'conv-B-ide', workspace_identity: '/ws-b', repository_identity: 'org/repo' }
  });

  const coreA = registry.registerProject({ binding: b1 });
  const coreB = registry.registerProject({ binding: b2 });

  coreB.recordEndpointObservation('browser', {
    conversation_id: 'conv-B',
    trusted: true,
    latest_completed_cursor: 'cur-B',
    latest_completed_result: {
      cursor: 'cur-B',
      result_ref: 'ref-B',
      text: 'SECRET PROJECT B CONTENT',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  const dispatchedTasks = [];
  const ideAdapter = createMockIdeAdapter(dispatchedTasks);

  coreA.recordEndpointObservation('browser', {
    conversation_id: 'conv-A',
    trusted: true,
    latest_completed_cursor: null
  });

  executeSafeContinue({
    registry,
    bindingId: 'proj-A',
    expected_binding_revision: 1,
    target_endpoint: 'ide',
    source_endpoint: 'browser',
    expected_source_result_state: 'NO_NEW_RESULT',
    expected_source_cursor: null,
    ideAdapter
  });

  assert.strictEqual(dispatchedTasks.length, 1);
  const sentText = dispatchedTasks[0].envelope.payload.text;
  assert.strictEqual(sentText.includes('SECRET PROJECT B CONTENT'), false);
});

test('Safe Continue Guards — 6. 失败路径严格只记录单一 action_type: continue 的 BLOCKED Action', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const failingBrowserAdapter = {
    checkComposerPreflight: () => ({ ready: false, reason: 'composer_busy' }),
    sendTextPrompt: () => {}
  };

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-1'
  });
  core.markEndpointHandled('ide-1', { expected_cursor: 'cur-1' });

  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NO_NEW_RESULT',
      expected_source_cursor: 'cur-1',
      browserAdapter: failingBrowserAdapter
    });
  }, /PREFLIGHT_BLOCKED/);

  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1, 'Exactly one Action fact must exist');
  assert.strictEqual(actions[0].action_type, 'continue');
  assert.strictEqual(actions[0].stage, 'BLOCKED');
});

test('Safe Continue Guards — 7. Continue 仅在本地提交 (SUBMITTED_LOCALLY) 时绝不 mark handled；证实投递后推进 exact source', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const unconfirmedAdapter = {
    sendTextPrompt: () => ({ delivery_proven: false }),
    checkComposerPreflight: () => ({ ready: true })
  };

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-unhandled',
    latest_completed_result: {
      cursor: 'cur-ide-unhandled',
      result_ref: 'ref-unhandled',
      text: 'Unhandled text',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  // 1. 未证实投递 (停留在 SUBMITTED_LOCALLY) -> 绝不 mark handled
  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-ide-unhandled',
    expected_source_result_ref: 'ref-unhandled',
    browserAdapter: unconfirmedAdapter
  });

  let snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].last_handled_cursor, null);
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');

  // 2. 证实投递达成 ACCEPTED_OR_DELIVERED -> 仅自动推进 exact source
  const provenAdapter = createMockBrowserAdapter();
  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-ide-unhandled',
    expected_source_result_ref: 'ref-unhandled',
    browserAdapter: provenAdapter
  });

  snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].last_handled_cursor, 'cur-ide-unhandled');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('Safe Continue Guards — 8. 缺失 expected_source_result_state 或 expected_source_result_ref 严格 Fail-Closed BLOCKED', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-8',
    latest_completed_result: {
      cursor: 'cur-ide-8',
      result_ref: 'ref-ide-8',
      text: 'Test Text',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  // 1. 完全缺失 expected_source_result_state
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      browserAdapter
    });
  }, /expected_source_result_state is required/);

  // 2. 完全缺失 expected_source_cursor (Blocker 2 场景 A)
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_result_ref: 'ref-ide-8',
      browserAdapter
    });
  }, /expected_source_cursor is required/);

  // 3. 显式 null 游标仅在当前端点实际 cursor 确实为 null 时合法
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: null,
      expected_source_result_ref: 'ref-ide-8',
      browserAdapter
    });
  }, /STALE_SOURCE_CONTEXT.*expected source cursor "null", got "cur-ide-8"/);

  // 4. NEW source 缺失 expected_source_result_ref
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: 'cur-ide-8',
      browserAdapter
    });
  }, /expected_source_result_ref is required/);
});

test('Safe Continue Guards — 9. NO_NEW_RESULT 游标由 cursor-A 变为 cursor-B 必须 fail-closed BLOCKED (Blocker 2 场景 B)', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  // 1. 初始状态：source endpoint 为 NO_NEW_RESULT @ cursor-A
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cursor-A'
  });
  core.markEndpointHandled('ide-1', { expected_cursor: 'cursor-A' });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].latest_completed_cursor, 'cursor-A');

  // 请求形成时的快照参数：NO_NEW_RESULT @ cursor-A
  const requestParams = {
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NO_NEW_RESULT',
    expected_source_cursor: 'cursor-A',
    browserAdapter
  };

  // 2. 执行前，端点观察推进到 cursor-B 且已被处理，因此 result_state 依然是 NO_NEW_RESULT！
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cursor-B'
  });
  core.markEndpointHandled('ide-1', { expected_cursor: 'cursor-B' });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].latest_completed_cursor, 'cursor-B');

  // 3. 执行时必须判定为过期上下文 (STALE_SOURCE_CONTEXT) 并严格 BLOCKED
  assert.throws(() => {
    executeSafeContinue(requestParams);
  }, /STALE_SOURCE_CONTEXT.*expected source cursor "cursor-A", got "cursor-B"/);

  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].stage, 'BLOCKED');
});

test('Safe Continue Guards — 10. malformed result material 导致 Continue fail-closed 且绝不把脏内容 stringify 到出站包 (Blocker 3)', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const dispatchedPrompts = [];
  const browserAdapter = createMockBrowserAdapter(dispatchedPrompts);

  // 观测提供 malformed artifact (例如 text 为非 string 或 result_ref 为空)
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-malformed-test',
    latest_completed_result: {
      cursor: 'cur-malformed-test',
      result_ref: '', // malformed empty ref
      text: { malicious: 'object' } // malformed non-string
    }
  });

  const snap = core.getSnapshot();
  // 规范状态机中材料已被安全置为 null，但状态真值依然是 NEW
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].latest_completed_result, null);

  // 执行 Continue：因 NEW 端点缺少可用合规材料，必须 fail-closed BLOCKED
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      source_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: 'cur-malformed-test',
      expected_source_result_ref: 'any-ref',
      browserAdapter
    });
  }, /SOURCE_RESULT_UNAVAILABLE/);

  // 绝无任何请求被派发，绝无脏对象被 stringify 到出站载荷
  assert.strictEqual(dispatchedPrompts.length, 0);
  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].stage, 'BLOCKED');
});

