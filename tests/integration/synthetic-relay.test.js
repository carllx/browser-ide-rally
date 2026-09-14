import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { RallyController } from '../../src/controller/controller.js';
import { createBinding } from '../../src/controller/binding.js';
import { PHASES } from '../../src/controller/exchange.js';

function createMockBrowserAdapter({
  isGenerating = false,
  promptDraft = '',
  targetUrlMatches = true,
  turnEnvelope = null,
  ackText = 'ACK:NONCE_MOCK'
} = {}) {
  return {
    locateExactConversationTab: (convId) => {
      if (!targetUrlMatches) {
        throw new Error('TARGET_LOOKUP_FAIL: No Chrome tab found');
      }
      return { windowIndex: 1, tabIndex: 1, url: `https://chatgpt.com/c/${convId}` };
    },
    checkPreflight: () => {
      if (promptDraft.length > 0) throw new Error(`PREFLIGHT_FAIL: Unsent draft present: "${promptDraft}"`);
      if (isGenerating) throw new Error('PREFLIGHT_FAIL: ChatGPT is currently generating');
      return { url: 'https://chatgpt.com/c/test', hasPrompt: true, promptDraft, isGenerating };
    },
    captureAssistantTurnBaseline: () => ({
      assistantTurnCount: 1,
      assistantTurnIds: ['turn_old_0']
    }),
    sendTextPrompt: () => true,
    waitForNewAssistantEnvelope: ({ expectedNonce, binding }) => {
      if (!turnEnvelope) {
        return {
          envelope: {
            version: 1,
            nonce: expectedNonce,
            binding_id: binding.binding_id,
            binding_revision: binding.binding_revision,
            operation: 'rally.echo',
            target: 'bound_ide',
            payload: { text: `Return exactly RALLY_ECHO:${expectedNonce}` }
          },
          turnIdentity: { turnId: 'turn_new_1', turnIndex: 1 },
          rawText: `<RALLY_HANDOFF>{"version": 1, "nonce": "${expectedNonce}", "operation": "rally.echo", "target": "bound_ide", "payload": {"text": "echo"}}</RALLY_HANDOFF>`
        };
      }
      return turnEnvelope;
    },
    deliverResultAndAwaitAck: ({ expectedAckPrefix }) => ({
      success: true,
      ackText: ackText || `ACK:${expectedAckPrefix}`,
      durationMs: 150
    })
  };
}

function createMockIdeAdapter({
  identityMismatch = false,
  pollTimesOut = false
} = {}) {
  return {
    verifyTargetIdentity: (convId, expectedWs, expectedRepo) => {
      if (identityMismatch) {
        throw new Error('IDENTITY_MISMATCH: Workspace URI mismatch');
      }
      return { verified: true, conversationId: convId, workspace: expectedWs, repository: expectedRepo };
    },
    dispatchEchoTask: ({ envelope, artifactPath }) => ({
      dispatched: true,
      artifactPath,
      dispatchedAt: new Date().toISOString()
    }),
    pollReceiverArtifact: ({ expectedNonce }) => {
      if (pollTimesOut) {
        throw new Error('TIMEOUT: Receiver failed to produce artifact');
      }
      return {
        success: true,
        result: {
          nonce: expectedNonce,
          operation: 'rally.echo',
          result: `RALLY_ECHO:${expectedNonce}`
        },
        durationMs: 200,
        stat: { size: 100, mtime: new Date().toISOString() }
      };
    }
  };
}

test('[synthetic integration] RallyController: happy path reaches browser_acknowledged', async () => {
  const binding = createBinding({
    binding_id: 'bind-synthetic-1',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-synth' },
    ide: {
      conversation_id: 'conv-ide-synth',
      workspace_identity: 'file:///workspace/rally',
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  const controller = new RallyController({
    binding,
    browserAdapter: createMockBrowserAdapter(),
    ideAdapter: createMockIdeAdapter()
  });

  const result = await controller.executeRoundTrip({
    exchangeId: 'ex-synth-01',
    nonce: 'NONCE_SYNTH_PASS'
  });

  assert.equal(result.success, true);
  assert.equal(result.exchange.phase, PHASES.BROWSER_ACKNOWLEDGED);
  assert.equal(result.exchange.needs_human, false);
  assert.ok(result.statusDump);
  assert.ok(result.compactStatus.includes('Phase browser_acknowledged'));
});

test('[synthetic integration] Security Negative Test: Paused binding blocks before browser interaction', async () => {
  const binding = createBinding({
    binding_id: 'bind-paused',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'c1' },
    ide: { conversation_id: 'c2', workspace_identity: 'w1', repository_identity: 'r1' },
    paused: true
  });

  const controller = new RallyController({
    binding,
    browserAdapter: createMockBrowserAdapter(),
    ideAdapter: createMockIdeAdapter()
  });

  const result = await controller.executeRoundTrip();
  assert.equal(result.success, false);
  assert.equal(result.exchange.phase, PHASES.BLOCKED);
  assert.equal(result.exchange.needs_human, true);
  assert.match(result.exchange.blocker, /Binding is paused/);
});

test('[synthetic integration] Security Negative Test: IDE identity mismatch halts progression', async () => {
  const binding = createBinding({
    binding_id: 'bind-mismatch',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'c1' },
    ide: { conversation_id: 'c2', workspace_identity: 'w1', repository_identity: 'r1' }
  });

  const controller = new RallyController({
    binding,
    browserAdapter: createMockBrowserAdapter(),
    ideAdapter: createMockIdeAdapter({ identityMismatch: true })
  });

  const result = await controller.executeRoundTrip();
  assert.equal(result.success, false);
  assert.equal(result.exchange.phase, PHASES.BLOCKED);
  assert.match(result.exchange.blocker, /IDENTITY_MISMATCH/);
});

test('[synthetic integration] Security Negative Test: Receiver timeout enters unknown_delivery and requires human', async () => {
  const binding = createBinding({
    binding_id: 'bind-timeout',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'c1' },
    ide: { conversation_id: 'c2', workspace_identity: 'w1', repository_identity: 'r1' }
  });

  const controller = new RallyController({
    binding,
    browserAdapter: createMockBrowserAdapter(),
    ideAdapter: createMockIdeAdapter({ pollTimesOut: true })
  });

  const result = await controller.executeRoundTrip();
  assert.equal(result.success, false);
  assert.equal(result.exchange.phase, PHASES.UNKNOWN_DELIVERY);
  assert.equal(result.exchange.needs_human, true);
  assert.match(result.exchange.blocker, /TIMEOUT: Receiver failed/);
});
