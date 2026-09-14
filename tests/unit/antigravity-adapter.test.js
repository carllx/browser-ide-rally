import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AntigravityAdapter,
  normalizeIdentityUri
} from '../../src/adapters/ide/antigravity.js';

test('[unit] AntigravityAdapter: normalizeIdentityUri strips file:// and trailing slash', () => {
  assert.equal(normalizeIdentityUri('file:///path/to/repo/'), '/path/to/repo');
  assert.equal(normalizeIdentityUri('/path/to/repo'), '/path/to/repo');
});

test('[unit] Security Negative Test: IDE exact workspace mismatch is rejected', () => {
  const fakeExecutor = (bin, args) => {
    return JSON.stringify({
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///Users/other/malicious-repo',
                repository: { computedName: 'carllx/browser-ide-rally' }
              }
            ]
          }
        }
      }
    });
  };

  const adapter = new AntigravityAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.verifyTargetIdentity(
      'conv-target-1',
      'file:///Users/legit/browser-ide-rally',
      'carllx/browser-ide-rally'
    );
  }, /IDENTITY_MISMATCH: Workspace URI mismatch/);
});

test('[unit] Security Negative Test: IDE exact repository mismatch is rejected', () => {
  const fakeExecutor = (bin, args) => {
    return JSON.stringify({
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///Users/legit/repo',
                repository: { computedName: 'other/wrong-repo' }
              }
            ]
          }
        }
      }
    });
  };

  const adapter = new AntigravityAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.verifyTargetIdentity(
      'conv-target-1',
      'file:///Users/legit/repo',
      'carllx/browser-ide-rally'
    );
  }, /IDENTITY_MISMATCH: Repository identity mismatch/);
});

test('[unit] AntigravityAdapter: verifyTargetIdentity succeeds when exact match', () => {
  const fakeExecutor = (bin, args) => {
    return JSON.stringify({
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///Users/yamlam/Documents/GitHub/browser-ide-rally',
                repository: { computedName: 'carllx/browser-ide-rally' }
              }
            ]
          }
        }
      }
    });
  };

  const adapter = new AntigravityAdapter({ executor: fakeExecutor });
  const res = adapter.verifyTargetIdentity(
    'conv-target-1',
    'file:///Users/yamlam/Documents/GitHub/browser-ide-rally/',
    'carllx/browser-ide-rally'
  );
  assert.equal(res.verified, true);
  assert.equal(res.workspace, '/Users/yamlam/Documents/GitHub/browser-ide-rally');
});

test('[unit] AntigravityAdapter: dispatch and poll artifact contract', () => {
  const dispatchedCommands = [];
  const fakeExecutor = (bin, args) => {
    dispatchedCommands.push({ bin, args });
    return '';
  };

  const adapter = new AntigravityAdapter({ executor: fakeExecutor });
  const testNonce = 'NONCE_TEST_POLL';
  const artifactPath = path.join(os.tmpdir(), `test-poll-${Date.now()}.json`);

  const dispatchRes = adapter.dispatchEchoTask({
    conversationId: 'conv-123',
    envelope: {
      nonce: testNonce,
      operation: 'rally.echo',
      payload: { text: 'Return RALLY_ECHO:NONCE_TEST_POLL' }
    },
    artifactPath
  });

  assert.equal(dispatchRes.dispatched, true);
  assert.equal(dispatchedCommands.length, 1);
  assert.equal(dispatchedCommands[0].args[0], 'send-message');

  // Simulate IDE receiver writing the artifact
  fs.writeFileSync(artifactPath, JSON.stringify({
    nonce: testNonce,
    operation: 'rally.echo',
    result: `RALLY_ECHO:${testNonce}`
  }));

  const pollRes = adapter.pollReceiverArtifact({
    artifactPath,
    expectedNonce: testNonce,
    timeoutMs: 5000,
    pollIntervalMs: 50
  });

  assert.equal(pollRes.success, true);
  assert.equal(pollRes.result.result, `RALLY_ECHO:${testNonce}`);
  assert.equal(fs.existsSync(artifactPath), false, 'Artifact should be unlinked upon verification');
});
