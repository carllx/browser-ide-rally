/**
 * Antigravity IDE Adapter 启动协调与版本防线测试套件 (#16)
 *
 * 核心验证：
 * 1. Gate 1: Stale revision guard（防止 revision 0 以及 stale nonzero revision 污染当前状态）；
 * 2. Gate 2: Startup reconciliation 严格归属证明（exact conversation + expected workspace + expected repository）；
 * 3. 重启恢复：防止 handled cursor 作为 NEW 重复回放；
 * 4. 游标漂移 / 历史截断 / 文件丢失时的 fail-closed 保护。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { AntigravityIdeAdapter } from '../../src/adapters/ide/antigravity-adapter.js';

function createTempDir(prefix = 'ag-ide-recon-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir: tmpDir,
    registryFile: path.join(tmpDir, 'registry.json'),
    transcriptFile: path.join(tmpDir, 'transcript.jsonl'),
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

function makeSampleBinding(id = 'proj-ag-001', overrides = {}) {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-001'
    },
    ide: {
      conversation_id: 'conv-ag-001',
      workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
      repository_identity: 'carllx/browser-ide-rally'
    },
    ...overrides
  });
}

function writeTranscript(filePath, steps) {
  const lines = steps.map(s => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
}

test('[Reconciliation] 1. restart/reopen restores the handled IDE cursor without replaying it as NEW', () => {
  const { registryFile, transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();

    {
      const registry = createProjectRegistry({ storagePath: registryFile });
      const core = registry.registerProject({ binding });
      const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

      writeTranscript(transcriptFile, [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done' }
      ]);

      adapter.handleStopHook({
        conversationId: 'conv-ag-001',
        workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
        transcriptPath: transcriptFile
      });

      const cursor = core.getSnapshot().endpoints.ide.latest_completed_cursor;
      core.markEndpointHandled('ide', { expected_cursor: cursor });
      registry.saveToFile(registryFile);
    }

    {
      const reloadedRegistry = createProjectRegistry({ storagePath: registryFile });
      const reloadedCore = reloadedRegistry.getProject(binding.binding_id);
      const reloadedAdapter = new AntigravityIdeAdapter({ binding, statusCore: reloadedCore });

      // 重启协调核验（携带有效身份证明）
      const recon = reloadedAdapter.reconcileOnStartup(transcriptFile, {
        conversationId: 'conv-ag-001',
        workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
      });
      assert.equal(recon.status, 'RECONCILED');

      const reloadedSnap = reloadedCore.getSnapshot();
      // 保持 caught-up (NO_NEW_RESULT)，未被重新当成 NEW 回放！
      assert.equal(reloadedSnap.endpoints.ide.result_state, 'NO_NEW_RESULT');
      assert.match(reloadedSnap.endpoints.ide.last_handled_cursor, /^ag-step:1:/);
    }
  } finally {
    cleanup();
  }
});

test('[Reconciliation] 2. next genuine final IDE completion advances exactly once after restart', () => {
  const { registryFile, transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();

    {
      const registry = createProjectRegistry({ storagePath: registryFile });
      const core = registry.registerProject({ binding });
      const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

      writeTranscript(transcriptFile, [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done' }
      ]);

      adapter.handleStopHook({
        conversationId: 'conv-ag-001',
        workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
        transcriptPath: transcriptFile
      });

      const cursor = core.getSnapshot().endpoints.ide.latest_completed_cursor;
      core.markEndpointHandled('ide', { expected_cursor: cursor });
      registry.saveToFile(registryFile);
    }

    {
      const reloadedRegistry = createProjectRegistry({ storagePath: registryFile });
      const reloadedCore = reloadedRegistry.getProject(binding.binding_id);
      const reloadedAdapter = new AntigravityIdeAdapter({ binding, statusCore: reloadedCore });

      reloadedAdapter.reconcileOnStartup(transcriptFile, {
        conversationId: 'conv-ag-001',
        workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
      });
      assert.equal(reloadedCore.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

      // 模拟执行新轮次并写入 transcript
      writeTranscript(transcriptFile, [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 2 done' }
      ]);

      const res = reloadedAdapter.handleStopHook({
        conversationId: 'conv-ag-001',
        workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
        transcriptPath: transcriptFile
      });
      assert.equal(res.accepted, true);

      const snap = reloadedCore.getSnapshot();
      assert.equal(snap.endpoints.ide.result_state, 'NEW');
      assert.match(snap.endpoints.ide.latest_completed_cursor, /^ag-step:3:/);
      assert.match(snap.endpoints.ide.last_handled_cursor, /^ag-step:1:/);
    }
  } finally {
    cleanup();
  }
});

test('[Reconciliation] 3. transcript truncation and drift fails closed to UNKNOWN', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // 设置此前 handled 游标为 step 5
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ag-001',
      binding_revision: 1,
      trusted: true,
      latest_completed_cursor: 'ag-step:5:deadbeef12345678'
    });
    core.markEndpointHandled('ide', { expected_cursor: 'ag-step:5:deadbeef12345678' });

    // 物理 transcript 被截断，仅包含 step 10，丢失 step 5
    writeTranscript(transcriptFile, [
      { step_index: 10, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Truncated step' }
    ]);

    const reconDrift = adapter.reconcileOnStartup(transcriptFile, {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
    });
    assert.equal(reconDrift.status, 'UNKNOWN');
    assert.equal(reconDrift.reason, 'handled_cursor_drift_or_truncated');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');

    // 文件丢失场景
    const reconMissing = adapter.reconcileOnStartup('/non/existent/path/transcript.jsonl', {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
    });
    assert.equal(reconMissing.status, 'UNKNOWN');
    assert.equal(reconMissing.reason, 'transcript_unavailable');
  } finally {
    cleanup();
  }
});

test('[Reconciliation Gate 1] 4. stale revision guard rejects revision 0 and stale nonzero revision without mutating continuity', () => {
  const binding = makeSampleBinding('proj-ag-gate1', { binding_revision: 2 });
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding });

  // 先确立受信状态
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ag-001',
    binding_revision: 2,
    trusted: true,
    latest_completed_cursor: 'ag-step:1:rev2valid'
  });
  assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');

  // 4a. 带有 revision 0 的观察（属于过期版本，不得因 0 是 falsy 而绕过校验）
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ag-001',
    binding_revision: 0,
    continuity_lost: true,
    reason: 'some_rev0_failure'
  });
  // 必须被拦截为 stale_revision，而不是将端点标记为 continuity_lost
  let snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide.result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide.continuity.unknown_reason, /stale_revision: expected rev 2, got rev 0/);

  // 恢复受信状态
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ag-001',
    binding_revision: 2,
    trusted: true,
    latest_completed_cursor: 'ag-step:1:rev2valid'
  });
  assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');

  // 4b. 带有 stale nonzero revision 1 的观察
  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ag-001',
    binding_revision: 1,
    continuity_lost: true,
    reason: 'some_rev1_failure'
  });
  snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide.result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide.continuity.unknown_reason, /stale_revision: expected rev 2, got rev 1/);

  // 4c. 旧 adapter 实例持有 revision 1，其触发的 _failClosedToUnknown 同样携带 revision 1，无法污染 revision 2 的 Core 状态
  const staleAdapter = new AntigravityIdeAdapter({
    binding: { ...binding, binding_revision: 1 },
    statusCore: core
  });
  staleAdapter._failClosedToUnknown('stale_adapter_crash');
  snap = core.getSnapshot();
  assert.match(snap.endpoints.ide.continuity.unknown_reason, /stale_revision: expected rev 2, got rev 1/);
});

test('[Reconciliation Gate 2] 5. wrong existing transcript cannot establish trusted state without exact proof', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // 物理文件存在且包含完整的成功完成轮次
    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done' }
    ]);

    // 5a. 未提供身份凭据 -> 坚决 fail closed
    const reconNoProof = adapter.reconcileOnStartup(transcriptFile);
    assert.equal(reconNoProof.status, 'UNKNOWN');
    assert.match(reconNoProof.reason, /attribution_mismatch/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');

    // 5b. 提供了错误的 conversationId -> 坚决 fail closed
    const reconWrongConv = adapter.reconcileOnStartup(transcriptFile, {
      conversationId: 'conv-alien-999',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
    });
    assert.equal(reconWrongConv.status, 'UNKNOWN');
    assert.match(reconWrongConv.reason, /attribution_mismatch/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');

    // 5c. 提供了错误的 workspace -> 坚决 fail closed
    const reconWrongWs = adapter.reconcileOnStartup(transcriptFile, {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/tmp/some-other-workspace']
    });
    assert.equal(reconWrongWs.status, 'UNKNOWN');
    assert.match(reconWrongWs.reason, /workspace_mismatch/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');
  } finally {
    cleanup();
  }
});

test('[Reconciliation Gate 2] 6. exact bound transcript reconciles cleanly when proved', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // 空 transcript 初始干净状态协调
    writeTranscript(transcriptFile, []);
    const reconEmpty = adapter.reconcileOnStartup(transcriptFile, {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
    });
    assert.equal(reconEmpty.status, 'RECONCILED');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    // 存在已处理完成历史的协调
    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done' }
    ]);
    adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });
    core.markEndpointHandled('ide', { expected_cursor: core.getSnapshot().endpoints.ide.latest_completed_cursor });
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    const reconHandled = adapter.reconcileOnStartup(transcriptFile, {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
    });
    assert.equal(reconHandled.status, 'RECONCILED');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');
  } finally {
    cleanup();
  }
});
