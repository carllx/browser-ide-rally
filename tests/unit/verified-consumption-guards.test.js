import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSafeContinue } from '../../src/controller/safe-continue.js';
import { executeSafeSend } from '../../src/controller/safe-send.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import {
  setupMultiEndpointFixture,
  createMockBrowserAdapter,
  createMockIdeAdapter
} from './verified-consumption-helpers.js';

test('8. Stale binding / source revision or target mismatch preserves NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: () => {
      core.rebindEndpoint({
        endpoint_id: 'ide-1',
        identity: {
          conversation_id: 'conv-ide-1-rebound',
          workspace_identity: '/workspaces/proj',
          repository_identity: 'carllx/browser-ide-rally'
        },
        confirm_replace_unknown: true
      });
      return { delivery_proven: true, delivery_evidence: 'Delivered' };
    }
  };

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-8',
    latest_completed_result: {
      cursor: 'cur-br-8',
      result_ref: 'res_br_ref_8',
      text: 'Original message',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-8',
    expected_source_result_ref: 'res_br_ref_8',
    ideAdapter
  });

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('9. Unrelated generic Action / Send reaching ACCEPTED_OR_DELIVERED cannot clear NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = createMockIdeAdapter();

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-9',
    latest_completed_result: {
      cursor: 'cur-br-9',
      result_ref: 'res_br_ref_9',
      text: 'Browser proposal 9',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  const res = executeSafeSend({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    action_type: 'send',
    payload: { text: 'Hello IDE directly' },
    ideAdapter
  });

  assert.strictEqual(res.action.stage, 'ACCEPTED_OR_DELIVERED');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('10. Sibling IDE activity cannot clear another endpoint NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-1',
    latest_completed_result: {
      cursor: 'cur-ide-1',
      result_ref: 'res_ide_ref_1',
      text: 'IDE 1 finished',
      captured_at: '2026-09-19T09:00:00Z'
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
      result_ref: 'res_ide_ref_2',
      text: 'IDE 2 finished',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-2'].result_state, 'NEW');

  executeSafeContinue({
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

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].last_handled_cursor, 'cur-ide-1');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-2'].result_state, 'NEW');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-2'].last_handled_cursor, null);
});

test('11. Cross-project activity cannot clear another project NEW', () => {
  const registry = createProjectRegistry();
  const binding1 = createBinding({
    binding_id: 'proj-1',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-p1' },
    ide_endpoints: [{ endpoint_id: 'ide-1', endpoint_revision: 1, conversation_id: 'conv-ide-p1', workspace_identity: '/w1', repository_identity: 'repo1' }]
  });
  const binding2 = createBinding({
    binding_id: 'proj-2',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-p2' },
    ide_endpoints: [{ endpoint_id: 'ide-1', endpoint_revision: 1, conversation_id: 'conv-ide-p2', workspace_identity: '/w2', repository_identity: 'repo2' }]
  });

  const core1 = registry.registerProject({ binding: binding1 });
  const core2 = registry.registerProject({ binding: binding2 });
  const ideAdapter = createMockIdeAdapter();

  core1.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-p1',
    trusted: true,
    latest_completed_cursor: 'cur-p1',
    latest_completed_result: { cursor: 'cur-p1', result_ref: 'ref-p1', text: 'p1', captured_at: '2026-09-19T09:00:00Z' }
  });

  core2.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-p2',
    trusted: true,
    latest_completed_cursor: 'cur-p2',
    latest_completed_result: { cursor: 'cur-p2', result_ref: 'ref-p2', text: 'p2', captured_at: '2026-09-19T09:00:00Z' }
  });

  executeSafeContinue({
    registry,
    bindingId: 'proj-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-p1',
    expected_source_result_ref: 'ref-p1',
    ideAdapter
  });

  assert.strictEqual(core1.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(core2.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.strictEqual(core2.getSnapshot().endpoints.browser.last_handled_cursor, null);
});

test('12. Context-free Continue formed from NO_NEW_RESULT does not perform auto-handled mutation', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = createMockIdeAdapter();

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-initial'
  });
  core.markEndpointHandled('browser', { expected_cursor: 'cur-br-initial' });
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(core.getSnapshot().endpoints.browser.last_handled_cursor, 'cur-br-initial');

  const res = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NO_NEW_RESULT',
    expected_source_cursor: 'cur-br-initial',
    ideAdapter
  });

  assert.strictEqual(res.action.stage, 'ACCEPTED_OR_DELIVERED');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, 'cur-br-initial');
});

test('13. Both directions covered: Browser NEW -> IDE Continue and IDE NEW -> Browser Continue', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const browserAdapter = createMockBrowserAdapter();
  const ideAdapter = createMockIdeAdapter();

  // 方向 A: Browser -> IDE
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-13',
    latest_completed_result: { cursor: 'cur-br-13', result_ref: 'ref-br-13', text: 'Br text', captured_at: '2026-09-19T09:00:00Z' }
  });
  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-13',
    expected_source_result_ref: 'ref-br-13',
    ideAdapter
  });
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(core.getSnapshot().endpoints.browser.last_handled_cursor, 'cur-br-13');

  // 方向 B: IDE -> Browser
  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-13',
    latest_completed_result: { cursor: 'cur-ide-13', result_ref: 'ref-ide-13', text: 'IDE text', captured_at: '2026-09-19T09:00:00Z' }
  });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NEW');

  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    source_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-ide-13',
    expected_source_result_ref: 'ref-ide-13',
    browserAdapter
  });
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');
  assert.strictEqual(core.getSnapshot().endpoints.ide_endpoints['ide-1'].last_handled_cursor, 'cur-ide-13');
});

test('14. Manual Mark handled remains independently functional', () => {
  const { core } = setupMultiEndpointFixture();

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-manual',
    latest_completed_result: { cursor: 'cur-br-manual', result_ref: 'ref-br-man', text: 'manual text', captured_at: '2026-09-19T09:00:00Z' }
  });
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  const res = core.markEndpointHandled('browser', { expected_cursor: 'cur-br-manual' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.handled_cursor, 'cur-br-manual');
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
});
