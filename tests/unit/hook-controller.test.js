import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleAntigravityHookRequest } from '../../src/surface/hook-controller.js';

describe('hook-controller', () => {
  it('returns 503 if observationCoordinator is not configured', () => {
    const res = handleAntigravityHookRequest({
      body: { conversationId: 'conv-123' },
      observationCoordinator: null
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.success, false);
    assert.equal(res.payload.reason, 'observation_coordinator_not_configured');
  });

  it('delegates to observationCoordinator.handleAntigravityHook and returns 200 on execution', () => {
    const mockCoordinator = {
      handleAntigravityHook: (body) => {
        if (body.conversationId === 'valid-conv') {
          return { accepted: true, binding_id: 'proj-1' };
        }
        return { accepted: false, reason: 'unknown_conversation_not_bound' };
      }
    };

    const resSuccess = handleAntigravityHookRequest({
      body: { conversationId: 'valid-conv' },
      observationCoordinator: mockCoordinator
    });
    assert.equal(resSuccess.statusCode, 200);
    assert.equal(resSuccess.payload.success, true);
    assert.equal(resSuccess.payload.result.accepted, true);

    const resFail = handleAntigravityHookRequest({
      body: { conversationId: 'other-conv' },
      observationCoordinator: mockCoordinator
    });
    assert.equal(resFail.statusCode, 200);
    assert.equal(resFail.payload.success, false);
    assert.equal(resFail.payload.result.accepted, false);
  });

  it('returns 500 if handleAntigravityHook throws an unexpected error', () => {
    const throwingCoordinator = {
      handleAntigravityHook: () => {
        throw new Error('Database disk error');
      }
    };

    const res = handleAntigravityHookRequest({
      body: { conversationId: 'any' },
      observationCoordinator: throwingCoordinator
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.success, false);
    assert.match(res.payload.reason, /Database disk error/);
  });
});
