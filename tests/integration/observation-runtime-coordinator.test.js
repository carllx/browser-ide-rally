import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createObservationRuntimeCoordinator } from '../../src/runtime/observation-runtime-coordinator.js';
import { AntigravityHookIngress } from '../../src/runtime/antigravity-hook-ingress.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

describe('ObservationRuntimeCoordinator Integration', () => {
  let tmpDir;
  let registry;
  let coordinator;
  let surfaceServer;

  function createTempTranscript(conversationId, content = 'Integration task completed') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-coord-test-'));
    const logDir = path.join(dir, conversationId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const transcriptPath = path.join(logDir, 'transcript.jsonl');
    const line = JSON.stringify({
      step_index: 42,
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

  afterEach(async () => {
    if (coordinator) {
      coordinator.stop();
    }
    if (surfaceServer) {
      await surfaceServer.close();
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  const currentWorkspace = process.cwd();
  const currentRepo = 'carllx/browser-ide-rally';

  function setupProject(bindingId, browserConvId, ideConvId, workspace = currentWorkspace, repo = currentRepo) {
    return registry.registerProject({
      binding: {
        binding_id: bindingId,
        binding_revision: 1,
        browser: {
          provider: 'chatgpt',
          conversation_id: browserConvId
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

  it('runs one-shot IDE startup reconciliation on coordinator start and preserves handled cursor without replaying as NEW', async () => {
    const convId = 'ag-conv-reconcile';
    const project = setupProject('proj-rec', 'browser-conv-rec', convId, currentWorkspace, currentRepo);

    const t = createTempTranscript(convId, 'Turn 1 done');
    tmpDir = t.dir;

    // 先通过 Stop Hook 建立初始 handled 事实
    const ingress = coordinator?.hookIngress || new AntigravityHookIngress({ registry });
    const hookRes = ingress.handleHook({
      conversationId: convId,
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    });
    assert.equal(hookRes.accepted, true);

    const initialCursor = project.getSnapshot().endpoints.ide_endpoints['ide-primary'].latest_completed_cursor;
    project.markEndpointHandled('ide-primary', { expected_cursor: initialCursor });

    assert.equal(project.getSnapshot().endpoints.ide_endpoints['ide-primary'].result_state, 'NO_NEW_RESULT');

    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-conv-rec',
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    coordinator = createObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500,
      brainBaseDir: tmpDir
    });

    await coordinator.start();

    // After start, one-shot reconciliation was executed and restores handled cursor without fabricating NEW
    const snapshot = project.getSnapshot();
    const ideFact = snapshot.endpoints.ide_endpoints['ide-primary'];
    assert.equal(ideFact.continuity.trusted, true);
    assert.equal(ideFact.last_handled_cursor, initialCursor);
    assert.equal(ideFact.result_state, 'NO_NEW_RESULT');

    coordinator.stop();
  });

  it('receives Antigravity Stop Hook via Surface Server HTTP POST /api/hooks/antigravity', async () => {
    const convId = 'ag-conv-http';
    const t = createTempTranscript(convId, 'Delivered via HTTP hook');
    tmpDir = t.dir;

    const project = setupProject('proj-http', 'browser-conv-http', convId, currentWorkspace, currentRepo);

    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-conv-http',
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    coordinator = createObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 1000,
      brainBaseDir: tmpDir
    });

    surfaceServer = await startStatusSurfaceServer({
      registry,
      browserAdapter: mockBrowserAdapter,
      observationCoordinator: coordinator,
      port: 0
    });

    const hookPayload = {
      conversationId: convId,
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    };

    const res = await fetch(`${surfaceServer.url}/api/hooks/antigravity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hookPayload)
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.result.accepted, true);
    assert.equal(body.result.binding_id, 'proj-http');

    const snapshot = project.getSnapshot();
    assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].result_state, 'NEW');
  });

  it('advances to NEW on coordinator startup when new completed turns exist after handled cursor', async () => {
    const convId = 'ag-conv-subsequent';
    const project = setupProject('proj-sub', 'browser-conv-sub', convId, currentWorkspace, currentRepo);

    const t = createTempTranscript(convId, 'Turn 1 done');
    tmpDir = t.dir;

    // 先通过 Stop Hook 记录 Turn 1 并 handled
    const ingress = new AntigravityHookIngress({ registry });
    const hookRes1 = ingress.handleHook({
      conversationId: convId,
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    });
    assert.equal(hookRes1.accepted, true);

    const cursor1 = project.getSnapshot().endpoints.ide_endpoints['ide-primary'].latest_completed_cursor;
    project.markEndpointHandled('ide-primary', { expected_cursor: cursor1 });
    assert.equal(project.getSnapshot().endpoints.ide_endpoints['ide-primary'].result_state, 'NO_NEW_RESULT');

    // 模拟 Antigravity 在关机/脱机期间生成了 Turn 2 并写入了 transcript
    const nextLine = JSON.stringify({
      step_index: 43,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Turn 2 done in background'
    }) + '\n';
    fs.appendFileSync(t.transcriptPath, nextLine, 'utf8');

    // 此时 Status Surface 启动并调用 coordinator.start()
    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-conv-sub',
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    coordinator = createObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500,
      brainBaseDir: tmpDir
    });

    await coordinator.start();

    // 验证：coordinator startup 识别到 handled 之后的全新 turn，准确推进为 NEW！
    const snap = project.getSnapshot();
    const ideFact = snap.endpoints.ide_endpoints['ide-primary'];
    assert.equal(ideFact.continuity.trusted, true);
    assert.equal(ideFact.last_handled_cursor, cursor1);
    assert.notEqual(ideFact.latest_completed_cursor, cursor1);
    assert.equal(ideFact.result_state, 'NEW');

    coordinator.stop();
  });

  it('refuses hook mutations after coordinator stop, preserving canonical state with runtime_stopped rejection', async () => {
    const convId = 'ag-conv-stopped-guard';
    const project = setupProject('proj-stop', 'browser-conv-stop', convId, currentWorkspace, currentRepo);

    const t = createTempTranscript(convId, 'Turn delivered after stop');
    tmpDir = t.dir;

    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-conv-stop',
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    coordinator = createObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500,
      brainBaseDir: tmpDir
    });

    // 1. coordinator start
    await coordinator.start();

    const initialSnapshot = project.getSnapshot();
    const initialIdeState = initialSnapshot.endpoints.ide_endpoints['ide-primary'].result_state;

    // 2. coordinator stop
    coordinator.stop();

    // 3. deliver valid final Antigravity Hook (payload 本身完全合法)
    const validHookPayload = {
      conversationId: convId,
      workspacePaths: [currentWorkspace],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: t.transcriptPath
    };

    const directResult = coordinator.handleAntigravityHook(validHookPayload);

    // 4 & 5. 返回 rejected / stopped 语义，且 endpoint canonical state 必须保持不变
    assert.equal(directResult.accepted, false);
    assert.equal(directResult.reason, 'runtime_stopped');

    const postDirectSnapshot = project.getSnapshot();
    assert.equal(postDirectSnapshot.endpoints.ide_endpoints['ide-primary'].result_state, initialIdeState);
    assert.equal(postDirectSnapshot.endpoints.ide_endpoints['ide-primary'].latest_completed_cursor, null);

    // 验证 HookIngress 实例自身同样拒绝
    const ingressResult = coordinator.hookIngress.handleHook(validHookPayload);
    assert.equal(ingressResult.accepted, false);
    assert.equal(ingressResult.reason, 'runtime_stopped');

    const finalSnapshot = project.getSnapshot();
    assert.equal(finalSnapshot.endpoints.ide_endpoints['ide-primary'].result_state, initialIdeState);
  });
});
