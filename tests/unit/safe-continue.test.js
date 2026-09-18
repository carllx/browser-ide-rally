import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSafeContinue } from '../../src/controller/safe-continue.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

function setupMultiEndpointFixture() {
  const registry = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-continue-1',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-br-1',
      branch: 'mainline'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-1',
        workspace_identity: '/workspaces/proj',
        repository_identity: 'carllx/browser-ide-rally'
      },
      {
        endpoint_id: 'ide-2',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-2',
        workspace_identity: '/workspaces/proj-2',
        repository_identity: 'carllx/browser-ide-rally'
      }
    ]
  });
  const core = registry.registerProject({ binding });
  return { registry, core, binding };
}

function createMockBrowserAdapter(dispatchedPrompts = []) {
  return {
    sendTextPrompt: (conversationId, text) => {
      dispatchedPrompts.push({ conversationId, text });
      return { delivery_proven: true, delivery_evidence: 'Mock browser prompt delivered' };
    },
    checkComposerPreflight: () => ({ ready: true })
  };
}

function createMockIdeAdapter(dispatchedTasks = []) {
  return {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: ({ conversationId, envelope, targetEndpoint }) => {
      dispatchedTasks.push({ conversationId, envelope, targetEndpoint });
      return { delivery_proven: true, delivery_evidence: 'Mock IDE task delivered' };
    }
  };
}

test('Safe Continue — 1. Dual NEW (Browser + IDE) -> 选 Browser: 包含 IDE 结果，Browser NEW 保留', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const dispatchedPrompts = [];
  const browserAdapter = createMockBrowserAdapter(dispatchedPrompts);

  const ideResult = {
    cursor: 'cur-ide-1',
    result_ref: 'res_ide_ref_1',
    text: 'Finished implementing feature X in IDE-1.',
    captured_at: '2026-09-18T10:00:00Z'
  };
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-1',
    latest_completed_result: ideResult
  });

  const browserResult = {
    cursor: 'cur-br-1',
    result_ref: 'res_br_ref_1',
    text: 'Browser plan ready.',
    captured_at: '2026-09-18T09:55:00Z'
  };
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-1',
    latest_completed_result: browserResult
  });

  // 两端此时皆为 NEW
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');

  const result = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-ide-1',
    expected_source_result_ref: 'res_ide_ref_1',
    browserAdapter
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action.action_type, 'continue');
  assert.strictEqual(result.action.target_endpoint, 'browser');
  assert.strictEqual(result.action.stage, 'ACCEPTED_OR_DELIVERED');

  // 断言只有唯一个 Action 事实
  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].action_type, 'continue');

  // 断言 Browser 发送正文包含了 IDE 结果，且不包含 Browser 自身结果
  assert.strictEqual(dispatchedPrompts.length, 1);
  const promptText = dispatchedPrompts[0].text;
  assert.ok(promptText.includes('Finished implementing feature X in IDE-1.'));
  assert.strictEqual(promptText.includes('Browser plan ready.'), false);

  // 关键不变式：两端 Endpoint Result 依然为 NEW，未被标记 handled
  const snapAfter = core.getSnapshot();
  assert.strictEqual(snapAfter.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snapAfter.endpoints.browser.last_handled_cursor, null);
  assert.strictEqual(snapAfter.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.strictEqual(snapAfter.endpoints.ide_endpoints['ide-1'].last_handled_cursor, null);
});

test('Safe Continue — 2. Dual NEW (Browser + IDE) -> 选 IDE: 包含 Browser 结果，IDE NEW 保留', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const dispatchedTasks = [];
  const ideAdapter = createMockIdeAdapter(dispatchedTasks);

  const browserResult = {
    cursor: 'cur-br-2',
    result_ref: 'res_br_ref_2',
    text: 'Browser reviewed specs and approved change.',
    captured_at: '2026-09-18T10:00:00Z'
  };
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-2',
    latest_completed_result: browserResult
  });

  const ideResult = {
    cursor: 'cur-ide-2',
    result_ref: 'res_ide_ref_2',
    text: 'Previous IDE work done.',
    captured_at: '2026-09-18T09:50:00Z'
  };
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-2',
    latest_completed_result: ideResult
  });

  const result = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    source_endpoint: 'browser',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-2',
    expected_source_result_ref: 'res_br_ref_2',
    ideAdapter
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action.action_type, 'continue');
  assert.strictEqual(result.action.target_endpoint, 'ide-1');

  // 断言派发给 IDE 的 payload
  assert.strictEqual(dispatchedTasks.length, 1);
  const taskEnvelope = dispatchedTasks[0].envelope;
  assert.strictEqual(taskEnvelope.operation, 'rally.prompt');
  assert.ok(taskEnvelope.payload.text.includes('Browser reviewed specs and approved change.'));
  assert.strictEqual(taskEnvelope.payload.text.includes('Previous IDE work done.'), false);

  // Provenance 校验
  assert.deepEqual(taskEnvelope.payload.provenance, {
    binding_id: 'proj-continue-1',
    binding_revision: 1,
    source_endpoint: 'browser',
    source_endpoint_revision: 1,
    source_result_ref: 'res_br_ref_2',
    source_completed_at: '2026-09-18T10:00:00Z',
    target_endpoint: 'ide-1'
  });

  // 两端依然为 NEW
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
});

test('Safe Continue — 3. Source 为 NO_NEW_RESULT: 允许派发，不回放陈旧历史', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const dispatchedPrompts = [];
  const browserAdapter = createMockBrowserAdapter(dispatchedPrompts);

  // IDE 已经是 caught-up (NO_NEW_RESULT)
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-old',
    latest_completed_result: {
      cursor: 'cur-old',
      result_ref: 'res_old',
      text: 'OLD HISTORICAL TEXT THAT MUST NOT REPLAY',
      captured_at: '2026-09-18T08:00:00Z'
    }
  });
  core.markEndpointHandled('ide-1', { expected_cursor: 'cur-old' });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');

  const result = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NO_NEW_RESULT',
    expected_source_cursor: 'cur-old',
    browserAdapter
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(dispatchedPrompts.length, 1);
  const promptText = dispatchedPrompts[0].text;
  assert.strictEqual(promptText.includes('OLD HISTORICAL TEXT THAT MUST NOT REPLAY'), false);
});

test('Safe Continue — 4. Source 为 UNKNOWN: 拦截为 BLOCKED，目标零副作用', () => {
  const { registry, core } = setupMultiEndpointFixture();
  let promptAttempted = false;
  const browserAdapter = {
    sendTextPrompt: () => { promptAttempted = true; }
  };

  // ide-1 为初始 UNKNOWN (未观察/受信断裂)
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

test('Safe Continue — 5. Multi-IDE 到 Browser: 缺失 source_endpoint 时拦截；禁止 sibling 聚合', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  // 未指定 source_endpoint
  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      expected_source_result_state: 'NEW',
      browserAdapter
    });
  }, /SOURCE_ENDPOINT_REQUIRED/);

  // 提供了明确的 ide-2，不能聚合 ide-1
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-1',
    latest_completed_result: {
      cursor: 'cur-ide-1',
      result_ref: 'ref-1',
      text: 'SIBLING IDE 1 TEXT',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });
  core.recordEndpointObservation('ide-2', {
    conversation_id: 'conv-ide-2',
    workspace_identity: '/workspaces/proj-2',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-2',
    latest_completed_result: {
      cursor: 'cur-ide-2',
      result_ref: 'ref-2',
      text: 'CHOSEN IDE 2 TEXT',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  const dispatched = [];
  const adapter = createMockBrowserAdapter(dispatched);

  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-2',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-ide-2',
    expected_source_result_ref: 'ref-2',
    browserAdapter: adapter
  });

  assert.strictEqual(dispatched.length, 1);
  assert.ok(dispatched[0].text.includes('CHOSEN IDE 2 TEXT'));
  assert.strictEqual(dispatched[0].text.includes('SIBLING IDE 1 TEXT'), false);
});

test('Safe Continue — 6. 防漂移守卫: 请求形成与执行之间源端点发生改变严格 BLOCKED', () => {
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

test('Safe Continue — 7. NEW source 缺失结果材料时 Fail-Closed BLOCKED', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  // 设置 NEW 状态但无 result material
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

  // 端点依然为 NEW
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
});

test('Safe Continue — 8. 载荷超限防御: 超大结果正文严格 BLOCKED，绝不静默截断', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  // 构造超过 64KB 的超大结果正文
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

test('Safe Continue — 9. 跨项目隔离: 项目 A 动作绝不包含项目 B 的结果正文', () => {
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

  // 项目 A 的 Browser 没有新结果 (NO_NEW_RESULT)
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
    ideAdapter
  });

  assert.strictEqual(dispatchedTasks.length, 1);
  const sentText = dispatchedTasks[0].envelope.payload.text;
  assert.strictEqual(sentText.includes('SECRET PROJECT B CONTENT'), false);
});

test('Safe Continue — 10. 失败路径严格只记录单一 action_type: continue 的 BLOCKED Action', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const failingBrowserAdapter = {
    checkComposerPreflight: () => ({ ready: false, reason: 'composer_busy' }),
    sendTextPrompt: () => {}
  };

  // 源端点为 NO_NEW_RESULT，通过了 continue 校验，但在 safe-send preflight 阶段受阻
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

test('Safe Continue — 11. Continue 生命周期绝不自动 mark handled', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const dispatchedPrompts = [];
  const browserAdapter = createMockBrowserAdapter(dispatchedPrompts);

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

  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-ide-unhandled',
    expected_source_result_ref: 'ref-unhandled',
    browserAdapter
  });

  const snap = core.getSnapshot();
  // 核心断言：未处理的完成游标绝对不能自动变成已处理！
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].last_handled_cursor, null);
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});
