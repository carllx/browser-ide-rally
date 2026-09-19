import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSafeContinue } from '../../src/controller/safe-continue.js';
import {
  setupMultiEndpointFixture,
  createMockIdeAdapter
} from './verified-consumption-helpers.js';

test('1. REQUESTED Continue does not clear source NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: () => {
      throw new Error('Local dispatch failure');
    }
  };

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-1',
    latest_completed_result: {
      cursor: 'cur-br-1',
      result_ref: 'res_br_ref_1',
      text: 'Browser proposal',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  assert.throws(() => {
    executeSafeContinue({
      registry,
      bindingId: 'proj-continue-1',
      expected_binding_revision: 1,
      target_endpoint: 'ide-1',
      expected_source_result_state: 'NEW',
      expected_source_cursor: 'cur-br-1',
      expected_source_result_ref: 'res_br_ref_1',
      ideAdapter
    });
  }, /Local dispatch failure/);

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
  const action = snap.actions.find(a => a.action_type === 'continue');
  assert.ok(action);
  assert.strictEqual(action.stage, 'FAILED');
});

test('2. SUBMITTED_LOCALLY Continue does not clear source NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: () => {
      return { delivery_proven: false };
    }
  };

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-2',
    latest_completed_result: {
      cursor: 'cur-br-2',
      result_ref: 'res_br_ref_2',
      text: 'Browser proposal 2',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  const res = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-2',
    expected_source_result_ref: 'res_br_ref_2',
    ideAdapter
  });

  assert.strictEqual(res.action.stage, 'SUBMITTED_LOCALLY');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('3. Exact consumption-eligible Continue + ACCEPTED_OR_DELIVERED auto-handles only its exact source NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = createMockIdeAdapter();

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-3',
    latest_completed_result: {
      cursor: 'cur-br-3',
      result_ref: 'res_br_ref_3',
      text: 'Browser spec ready',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  const res = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-3',
    expected_source_result_ref: 'res_br_ref_3',
    ideAdapter
  });

  assert.strictEqual(res.action.stage, 'ACCEPTED_OR_DELIVERED');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, 'cur-br-3');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'UNKNOWN');
});

test('4. TARGET_COMPLETED is not required for source handling', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = createMockIdeAdapter();

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-4',
    latest_completed_result: {
      cursor: 'cur-br-4',
      result_ref: 'res_br_ref_4',
      text: 'Browser work',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-1',
    workspace_identity: '/workspaces/proj',
    repository_identity: 'carllx/browser-ide-rally',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: null
  });

  executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-4',
    expected_source_result_ref: 'res_br_ref_4',
    ideAdapter
  });

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NO_NEW_RESULT');
  const action = snap.actions.find(a => a.action_type === 'continue');
  assert.strictEqual(action.stage, 'ACCEPTED_OR_DELIVERED');
});

test('5. Delivery UNKNOWN preserves source NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: () => ({
      delivery_proven: false,
      delivery_state: 'UNKNOWN',
      reason: 'Network timeout confirming task delivery'
    })
  };

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-5',
    latest_completed_result: {
      cursor: 'cur-br-5',
      result_ref: 'res_br_ref_5',
      text: 'Browser task',
      captured_at: '2026-09-19T09:00:00Z'
    }
  });

  const res = executeSafeContinue({
    registry,
    bindingId: 'proj-continue-1',
    expected_binding_revision: 1,
    target_endpoint: 'ide-1',
    expected_source_result_state: 'NEW',
    expected_source_cursor: 'cur-br-5',
    expected_source_result_ref: 'res_br_ref_5',
    ideAdapter
  });

  assert.strictEqual(res.action.stage, 'UNKNOWN');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('6. Source cursor drift before delivery proof preserves NEW and leaves previous handled cursor unchanged', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: () => {
      core.recordEndpointObservation('browser', {
        conversation_id: 'conv-br-1',
        trusted: true,
        latest_completed_cursor: 'cur-br-drift-new',
        latest_completed_result: {
          cursor: 'cur-br-drift-new',
          result_ref: 'res_br_ref_drift',
          text: 'Drifted new message from browser',
          captured_at: '2026-09-19T09:05:00Z'
        }
      });
      return { delivery_proven: true, delivery_evidence: 'Delivered after drift' };
    }
  };

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-6',
    latest_completed_result: {
      cursor: 'cur-br-6',
      result_ref: 'res_br_ref_6',
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
    expected_source_cursor: 'cur-br-6',
    expected_source_result_ref: 'res_br_ref_6',
    ideAdapter
  });

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.latest_completed_cursor, 'cur-br-drift-new');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
});

test('7. Source result_ref drift preserves NEW', () => {
  const { registry, core } = setupMultiEndpointFixture();
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: () => {
      core.recordEndpointObservation('browser', {
        conversation_id: 'conv-br-1',
        trusted: true,
        latest_completed_cursor: 'cur-br-7',
        latest_completed_result: {
          cursor: 'cur-br-7',
          result_ref: 'res_br_ref_mutated',
          text: 'Mutated material',
          captured_at: '2026-09-19T09:00:00Z'
        }
      });
      return { delivery_proven: true, delivery_evidence: 'Delivered' };
    }
  };

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: 'cur-br-7',
    latest_completed_result: {
      cursor: 'cur-br-7',
      result_ref: 'res_br_ref_7',
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
    expected_source_cursor: 'cur-br-7',
    expected_source_result_ref: 'res_br_ref_7',
    ideAdapter
  });

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});
