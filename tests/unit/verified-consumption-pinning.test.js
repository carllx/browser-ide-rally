import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileVerifiedConsumption } from '../../src/controller/consumption-reconciler.js';
import {
  setupMultiEndpointFixture
} from './verified-consumption-helpers.js';

function createBaseAction(params = {}) {
  return {
    action_id: 'act-pin-1',
    action_type: 'continue',
    target_endpoint: 'ide-1',
    stage: 'ACCEPTED_OR_DELIVERED',
    binding_revision: 1,
    ...params
  };
}

function createBaseContext(params = {}) {
  return {
    eligible: true,
    source_result_state: 'NEW',
    binding_id: 'proj-continue-1',
    binding_revision: 1,
    source_endpoint: 'browser',
    source_endpoint_revision: 1,
    expected_cursor: 'cur-br-pin',
    expected_result_ref: 'ref-br-pin',
    target_endpoint: 'ide-1',
    ...params
  };
}

function seedSourceBrowser(core, { cursor = 'cur-br-pin', resultRef = 'ref-br-pin', text = 'material' } = {}) {
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-1',
    trusted: true,
    latest_completed_cursor: cursor,
    latest_completed_result: resultRef !== null ? {
      cursor,
      result_ref: resultRef,
      text,
      captured_at: '2026-09-19T10:00:00Z'
    } : null
  });
}

test('Pinning 1. missing expected_result_ref cannot auto-handle', () => {
  const { core } = setupMultiEndpointFixture();
  seedSourceBrowser(core);

  const action = createBaseAction();
  const context = createBaseContext({ expected_result_ref: undefined });

  const result = reconcileVerifiedConsumption({ core, action, consumptionContext: context });

  assert.strictEqual(result.reconciled, false);
  assert.strictEqual(result.reason, 'missing_or_blank_expected_result_ref');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('Pinning 2. null or blank expected_result_ref cannot auto-handle', () => {
  const { core } = setupMultiEndpointFixture();
  seedSourceBrowser(core);

  const action = createBaseAction();

  // 2a. null
  const resNull = reconcileVerifiedConsumption({
    core,
    action,
    consumptionContext: createBaseContext({ expected_result_ref: null })
  });
  assert.strictEqual(resNull.reconciled, false);
  assert.strictEqual(resNull.reason, 'missing_or_blank_expected_result_ref');
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.strictEqual(core.getSnapshot().endpoints.browser.last_handled_cursor, null);

  // 2b. blank string
  const resBlank = reconcileVerifiedConsumption({
    core,
    action,
    consumptionContext: createBaseContext({ expected_result_ref: '   ' })
  });
  assert.strictEqual(resBlank.reconciled, false);
  assert.strictEqual(resBlank.reason, 'missing_or_blank_expected_result_ref');
  assert.strictEqual(core.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.strictEqual(core.getSnapshot().endpoints.browser.last_handled_cursor, null);
});

test('Pinning 3. current NEW with missing current result material cannot auto-handle', () => {
  const { core } = setupMultiEndpointFixture();
  seedSourceBrowser(core, { resultRef: null });

  const action = createBaseAction();
  const context = createBaseContext();

  const result = reconcileVerifiedConsumption({ core, action, consumptionContext: context });

  assert.strictEqual(result.reconciled, false);
  assert.strictEqual(result.reason, 'missing_current_result_material');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('Pinning 4. source_result_state !== "NEW" cannot auto-handle even if eligible: true is forged', () => {
  const { core } = setupMultiEndpointFixture();
  seedSourceBrowser(core);

  const action = createBaseAction();
  // 伪造的上下文：eligible: true 但 source_result_state 为 NO_NEW_RESULT
  const forgedContext = createBaseContext({
    eligible: true,
    source_result_state: 'NO_NEW_RESULT'
  });

  const result = reconcileVerifiedConsumption({ core, action, consumptionContext: forgedContext });

  assert.strictEqual(result.reconciled, false);
  assert.strictEqual(result.reason, 'not_eligible_for_auto_handled');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('Pinning 5. Action binding revision mismatch cannot auto-handle', () => {
  const { core } = setupMultiEndpointFixture();
  seedSourceBrowser(core);

  // Action 的 binding_revision 与当前 binding (revision 1) 失配
  const mismatchedAction = createBaseAction({ binding_revision: 2 });
  const context = createBaseContext({ binding_revision: 1 });

  const result = reconcileVerifiedConsumption({ core, action: mismatchedAction, consumptionContext: context });

  assert.strictEqual(result.reconciled, false);
  assert.strictEqual(result.reason, 'binding_revision_stale');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, null);
});

test('Pinning 6. a valid exact pinned context still auto-handles normally', () => {
  const { core } = setupMultiEndpointFixture();
  seedSourceBrowser(core);

  const action = createBaseAction();
  const context = createBaseContext();

  const result = reconcileVerifiedConsumption({ core, action, consumptionContext: context });

  assert.strictEqual(result.reconciled, true);
  assert.strictEqual(result.handled_cursor, 'cur-br-pin');
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.strictEqual(snap.endpoints.browser.last_handled_cursor, 'cur-br-pin');
});
