/**
 * Antigravity IDE Adapter 启动协调、版本防线与 Transcript Provenance 测试套件 (#16)
 *
 * 核心验证：
 * 1. Gate 1: Stale revision guard（防止 revision 0 以及 stale nonzero revision 污染当前状态）；
 * 2. Gate 2: Startup reconciliation 严格归属证明（exact conversation + expected workspace + expected repository）；
 * 3. Transcript Provenance: transcript artifact 本身必须证明属于 exact bound conversation；
 *    - A identity + A transcript -> 正常 reconcile；
 *    - A identity + B transcript (合法属于 B 的真实文件) -> UNKNOWN；
 *    - lookalike path (例如 <A>-extra) -> UNKNOWN；
 *    - malformed / unprovable transcript path -> UNKNOWN；
 * 4. 重启恢复：防止 handled cursor 作为 NEW 重复回放 (Restart Dedup)；
 * 5. 游标漂移 / 历史截断 / 文件丢失时的 fail-closed 保护。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import {
  AntigravityIdeAdapter,
  isProvenAntigravityTranscript
} from '../../src/adapters/ide/antigravity-adapter.js';

function createTempDir(prefix = 'ag-ide-recon-test', conversationId = 'conv-ag-001') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const logDir = path.join(tmpDir, 'brain', conversationId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return {
    dir: tmpDir,
    registryFile: path.join(tmpDir, 'registry.json'),
    transcriptFile: path.join(logDir, 'transcript.jsonl'),
    makeTranscriptPath: (convId) => {
      const p = path.join(tmpDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    },
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

      // 重启协调核验（携带有效身份证明与官方 Provenance 路径）
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
    assert.equal(reconMissing.reason, 'transcript_provenance_unverified: transcript path does not prove ownership of bound conversation');
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

test('[Transcript Provenance Gate] 6. transcript artifact provenance bound to exact conversation', () => {
  const { dir, makeTranscriptPath, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    const validIdentityProof = {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally']
    };

    // 6a. 构造真实存在的 Conversation A transcript (归属正确)
    const transcriptA = makeTranscriptPath('conv-ag-001');
    writeTranscript(transcriptA, []);
    assert.equal(isProvenAntigravityTranscript(transcriptA, 'conv-ag-001'), true);

    // 验证：A identity + A transcript (初始空轮次) -> 成功 reconcile
    const reconA = adapter.reconcileOnStartup(transcriptA, validIdentityProof);
    assert.equal(reconA.status, 'RECONCILED');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    // 写入新轮次并通过 Stop Hook 推进为 NEW
    writeTranscript(transcriptA, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn A done' }
    ]);
    const hookRes = adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptA
    });
    assert.equal(hookRes.accepted, true);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');

    // 标记 handled 后重启协调，验证保持 caught-up
    core.markEndpointHandled('ide', { expected_cursor: core.getSnapshot().endpoints.ide.latest_completed_cursor });
    const reconAHandled = adapter.reconcileOnStartup(transcriptA, validIdentityProof);
    assert.equal(reconAHandled.status, 'RECONCILED');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    // 6b. 构造真实存在的 Conversation B transcript (归属于另一个会话 conv-ag-002)
    const transcriptB = makeTranscriptPath('conv-ag-002');
    writeTranscript(transcriptB, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn B done' }
    ]);
    assert.equal(isProvenAntigravityTranscript(transcriptB, 'conv-ag-002'), true);
    assert.equal(isProvenAntigravityTranscript(transcriptB, 'conv-ag-001'), false);

    // 验证：A identity + B transcript (即便 B 物理存在且内容合法) -> 坚决 fail closed 到 UNKNOWN
    const reconB = adapter.reconcileOnStartup(transcriptB, validIdentityProof);
    assert.equal(reconB.status, 'UNKNOWN');
    assert.match(reconB.reason, /transcript_provenance_unverified/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');

    // 6c. Lookalike 路径攻击（例如 conv-ag-001-extra）
    const lookalikeTranscript = makeTranscriptPath('conv-ag-001-extra');
    writeTranscript(lookalikeTranscript, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Lookalike step' }
    ]);
    assert.equal(isProvenAntigravityTranscript(lookalikeTranscript, 'conv-ag-001'), false);

    const reconLookalike = adapter.reconcileOnStartup(lookalikeTranscript, validIdentityProof);
    assert.equal(reconLookalike.status, 'UNKNOWN');
    assert.match(reconLookalike.reason, /transcript_provenance_unverified/);

    // 6d. 格式损坏或缺少官方结构的路径
    const malformedPath = path.join(dir, 'conv-ag-001', 'transcript.jsonl');
    writeTranscript(malformedPath, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Malformed path step' }
    ]);
    assert.equal(isProvenAntigravityTranscript(malformedPath, 'conv-ag-001'), false);

    const reconMalformed = adapter.reconcileOnStartup(malformedPath, validIdentityProof);
    assert.equal(reconMalformed.status, 'UNKNOWN');
    assert.match(reconMalformed.reason, /transcript_provenance_unverified/);

    // 6e. Stop Hook 同样受 Provenance 保护，拒绝篡改路径
    const hookTampered = adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptB // 传入属于 B 的 transcript
    });
    assert.equal(hookTampered.accepted, false);
    assert.equal(hookTampered.reason, 'transcript_provenance_unverified');
  } finally {
    cleanup();
  }
});
