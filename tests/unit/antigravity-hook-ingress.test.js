import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { AntigravityHookIngress } from '../../src/runtime/antigravity-hook-ingress.js';

describe('AntigravityHookIngress', () => {
  let tmpDir;
  let registry;
  let ingress;

  function createTempTranscript(conversationId, content = 'Completed task output') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ingress-test-'));
    const logDir = path.join(dir, conversationId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const transcriptPath = path.join(logDir, 'transcript.jsonl');
    const line = JSON.stringify({
      step_index: 10,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content
    }) + '\n';
    fs.writeFileSync(transcriptPath, line, 'utf8');
    return { dir, transcriptPath };
  }

  beforeEach(() => {
    registry = createProjectRegistry();
  });

  afterEach(() => {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  const currentWorkspace = process.cwd();
  const currentRepo = 'carllx/browser-ide-rally';

  function setupProject(bindingId, ideConvId, workspace = currentWorkspace, repo = currentRepo) {
    return registry.registerProject({
      binding: {
        binding_id: bindingId,
        binding_revision: 1,
        browser: {
          provider: 'chatgpt',
          conversation_id: `browser-conv-${bindingId}`
        },
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            endpoint_revision: 1,
            conversation_id: ideConvId,
            workspace_identity: workspace,
            repository_identity: repo
          }
        ],
        capabilities: ['read', 'write'],
        paused: false
      }
    });
  }

  it('routes valid Stop Hook by conversationId to bound IDE endpoint and advances state to NEW', () => {
    const convId = 'ag-conv-a';
    const project = setupProject('proj-a', convId, currentWorkspace, currentRepo);

    const t = createTempTranscript(convId, 'Build succeeded and tests pass');
    tmpDir = t.dir;

    ingress = new AntigravityHookIngress({ registry });

    const result = ingress.handleHook({
      conversationId: convId,
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    });

    assert.equal(result.accepted, true);
    assert.equal(result.binding_id, 'proj-a');
    assert.equal(result.endpoint_id, 'ide-primary');

    const snapshot = project.getSnapshot();
    const ideFact = snapshot.endpoints.ide_endpoints['ide-primary'];
    assert.equal(ideFact.continuity.trusted, true);
    assert.ok(ideFact.latest_completed_cursor);
    assert.equal(ideFact.result_state, 'NEW');

    // Browser status remains unchanged (UNKNOWN)
    assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  });

  it('fails closed when conversationId is unknown / not bound to any project', () => {
    setupProject('proj-a', 'ag-conv-a', currentWorkspace, currentRepo);

    ingress = new AntigravityHookIngress({ registry });

    const result = ingress.handleHook({
      conversationId: 'unknown-conv-xyz',
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: '/some/path/transcript.jsonl'
    });

    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'unknown_conversation_not_bound');
  });

  it('rejects intermediate activity (fullyIdle: false) without updating state to NEW', () => {
    const convId = 'ag-conv-b';
    const project = setupProject('proj-b', convId, currentWorkspace, currentRepo);

    const t = createTempTranscript(convId, 'Running step 1');
    tmpDir = t.dir;

    ingress = new AntigravityHookIngress({ registry });

    const result = ingress.handleHook({
      conversationId: convId,
      workspacePaths: [currentWorkspace],
      fullyIdle: false, // Not fully idle!
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    });

    assert.equal(result.accepted, false);
    assert.match(result.reason, /intermediate_activity/);

    const snapshot = project.getSnapshot();
    assert.notEqual(snapshot.endpoints.ide_endpoints['ide-primary'].result_state, 'NEW');
  });

  it('ensures project isolation: Hook for Project B does not mutate Project A', () => {
    const convA = 'ag-conv-a';
    const convB = 'ag-conv-b';
    const projectA = setupProject('proj-a', convA, currentWorkspace, currentRepo);
    const projectB = setupProject('proj-b', convB, currentWorkspace, currentRepo);

    const t = createTempTranscript(convB, 'Task finished on Project B');
    tmpDir = t.dir;

    ingress = new AntigravityHookIngress({ registry });

    const result = ingress.handleHook({
      conversationId: convB,
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    });

    assert.equal(result.accepted, true);
    assert.equal(result.binding_id, 'proj-b');

    // Project B is NEW
    const snapB = projectB.getSnapshot();
    assert.equal(snapB.endpoints.ide_endpoints['ide-primary'].result_state, 'NEW');

    // Project A is still UNKNOWN
    const snapA = projectA.getSnapshot();
    assert.equal(snapA.endpoints.ide_endpoints['ide-primary'].result_state, 'UNKNOWN');
    assert.equal(snapA.endpoints.ide_endpoints['ide-primary'].continuity.trusted, false);
  });
});
