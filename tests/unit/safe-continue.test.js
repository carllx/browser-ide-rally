import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSafeContinue } from '../../src/controller/safe-continue.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

export function setupMultiEndpointFixture() {
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

export function createMockBrowserAdapter(dispatchedPrompts = []) {
  return {
    sendTextPrompt: (conversationId, text) => {
      dispatchedPrompts.push({ conversationId, text });
      return { delivery_proven: true, delivery_evidence: 'Mock browser prompt delivered' };
    },
    checkComposerPreflight: () => ({ ready: true })
  };
}

export function createMockIdeAdapter(dispatchedTasks = []) {
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

  const actions = core.getSnapshot().actions;
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].action_type, 'continue');

  assert.strictEqual(dispatchedPrompts.length, 1);
  const promptText = dispatchedPrompts[0].text;
  assert.ok(promptText.includes('Finished implementing feature X in IDE-1.'));
  assert.strictEqual(promptText.includes('Browser plan ready.'), false);

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

  assert.strictEqual(dispatchedTasks.length, 1);
  const taskEnvelope = dispatchedTasks[0].envelope;
  assert.strictEqual(taskEnvelope.operation, 'rally.prompt');
  assert.ok(taskEnvelope.payload.text.includes('Browser reviewed specs and approved change.'));
  assert.strictEqual(taskEnvelope.payload.text.includes('Previous IDE work done.'), false);

  assert.deepEqual(taskEnvelope.payload.provenance, {
    binding_id: 'proj-continue-1',
    binding_revision: 1,
    source_endpoint: 'browser',
    source_endpoint_revision: 1,
    source_result_ref: 'res_br_ref_2',
    source_completed_at: '2026-09-18T10:00:00Z',
    target_endpoint: 'ide-1'
  });

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
});

test('Safe Continue — 3. Source 为 NO_NEW_RESULT: 允许派发，不回放陈旧历史', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const dispatchedPrompts = [];
  const browserAdapter = createMockBrowserAdapter(dispatchedPrompts);

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

test('Safe Continue — 4. Multi-IDE 到 Browser: 缺失 source_endpoint 时拦截；禁止 sibling 聚合', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

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
