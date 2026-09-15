/**
 * Antigravity IDE Adapter 契约与验收测试套件 (#16)
 *
 * 遵循最高测试缝隙（Highest test seam）原则：
 * Adapter/runtime facts in → normalized observation → ProjectRegistry / Status Core → externally visible IDE Endpoint Result.
 *
 * 覆盖 Mission Contract 全部 10 项核心验收条件：
 * 1. exact conversation + workspace + repository identity match is required;
 * 2. non-final/intermediate activity does not commit completion;
 * 3. one reliable final Stop-hook completion advances IDE from caught-up to NEW, Browser truth unchanged;
 * 4. repeated replay of the same opaque IDE cursor does not create duplicate NEW or corrupt handled state;
 * 5. explicit Mark handled returns IDE to NO_NEW_RESULT, Browser unchanged;
 * 6. restart/reopen restores the handled IDE cursor without replaying it as NEW;
 * 7. next genuine final IDE completion advances exactly once after restart;
 * 8. stale binding revision, transcript truncation/drift, identity mismatch, ambiguous replay cursor, or hook drift fails closed to UNKNOWN / UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION;
 * 9. provider-specific transcript/step/fingerprint fields never become Core schema;
 * 10. no owner/next-actor semantics, no multi-conversation orchestration, no #17 UI, no Relay send work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { AntigravityIdeAdapter, decodeOpaqueCursor } from '../../src/adapters/ide/antigravity-adapter.js';

function createTempDir(prefix = 'ag-ide-adapter-test') {
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

test('[IDE Adapter] 1. exact conversation + workspace + repository identity match is required', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Finished task 1' }
    ]);

    // 1a. conversationId 不匹配：adapter 隔离拒收，不污染当前 Binding
    const resWrongConv = adapter.handleStopHook({
      conversationId: 'other-conv-id',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });
    assert.equal(resWrongConv.accepted, false);
    assert.match(resWrongConv.reason, /attribution_mismatch/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN'); // 未被修改

    // 1b. workspace identity 不匹配：fail-closed 到 UNKNOWN
    const resWrongWs = adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/different/unrelated/path'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });
    assert.equal(resWrongWs.accepted, false);
    assert.match(resWrongWs.reason, /workspace_mismatch/);
    const snap1 = core.getSnapshot();
    assert.equal(snap1.endpoints.ide.result_state, 'UNKNOWN');
    assert.match(snap1.endpoints.ide.continuity.unknown_reason, /workspace_mismatch/);

    // 1c. repository identity 严格规范匹配：必须匹配真正的 Git remote canonical owner/repo
    // 反例 1: 相同仓库名但不同 owner (fork/other-org) 必须 fail closed 到 UNKNOWN
    const bindingOtherOwner = makeSampleBinding('proj-other-owner', {
      ide: {
        conversation_id: 'conv-ag-001',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'other-owner/browser-ide-rally'
      }
    });
    const adapterOtherOwner = new AntigravityIdeAdapter({ binding: bindingOtherOwner, statusCore: core });
    const resWrongOwner = adapterOtherOwner.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });
    assert.equal(resWrongOwner.accepted, false);
    assert.match(resWrongOwner.reason, /repository_mismatch/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');

    // 反例 2: 仅为 remote URL 的部分子串 (例如仅 carllx 或仅 rally) 必须 fail closed
    const bindingSubstr = makeSampleBinding('proj-substr', {
      ide: {
        conversation_id: 'conv-ag-001',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'carllx'
      }
    });
    const adapterSubstr = new AntigravityIdeAdapter({ binding: bindingSubstr, statusCore: core });
    const resSubstr = adapterSubstr.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });
    assert.equal(resSubstr.accepted, false);
    assert.match(resSubstr.reason, /repository_mismatch/);
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 2. non-final / intermediate activity does not commit completion', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // 先初始化为受信 caught-up
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ag-001',
      trusted: true,
      latest_completed_cursor: null
    });
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [{ name: 'run_command' }] }
    ]);

    // 2a. fullyIdle === false: 中间工具执行中，严禁推进
    const resIntermediate = adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: false,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });
    assert.equal(resIntermediate.accepted, false);
    assert.match(resIntermediate.reason, /intermediate_activity/);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    // 2b. 未验证 terminationReason (如 SOME_TEMPORARY_STEP 或未验证的 model_stop 等 hook 漂移)
    // 关键契约 (#16 Review Gate 3): 必须 fail closed 到 UNKNOWN，绝不能保留旧的 NO_NEW_RESULT 受信状态！
    const resUnknownReason = adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'SOME_TEMPORARY_STEP',
      transcriptPath: transcriptFile
    });
    assert.equal(resUnknownReason.accepted, false);
    assert.match(resUnknownReason.reason, /non_final_termination_reason/);
    const snapDrift = core.getSnapshot();
    assert.equal(snapDrift.endpoints.ide.result_state, 'UNKNOWN');
    assert.match(snapDrift.endpoints.ide.continuity.unknown_reason, /non_final_termination_reason/);
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 3. one reliable final Stop-hook completion advances IDE from caught-up to NEW, Browser truth unchanged', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // 设定 Browser 端点状态为受信任的 NO_NEW_RESULT
    core.recordEndpointObservation('browser', {
      conversation_id: 'conv-browser-001',
      trusted: true,
      latest_completed_cursor: 'browser-cursor-101'
    });
    core.markEndpointHandled('browser', { expected_cursor: 'browser-cursor-101' });

    // 设定 IDE 端点状态为 caught-up
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ag-001',
      trusted: true,
      latest_completed_cursor: null
    });

    const initialSnapshot = core.getSnapshot();
    assert.equal(initialSnapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(initialSnapshot.endpoints.ide.result_state, 'NO_NEW_RESULT');

    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Work done successfully' }
    ]);

    const res = adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });

    assert.equal(res.accepted, true);

    const updatedSnapshot = core.getSnapshot();
    assert.equal(updatedSnapshot.endpoints.ide.result_state, 'NEW');
    assert.equal(updatedSnapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.match(updatedSnapshot.endpoints.ide.latest_completed_cursor, /^ag-step:1:/);
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 4. repeated replay of the same opaque IDE cursor does not create duplicate NEW or corrupt handled state', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 completed' }
    ]);

    const hookEvent = {
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    };

    adapter.handleStopHook(hookEvent);
    const snap1 = core.getSnapshot();
    assert.equal(snap1.endpoints.ide.result_state, 'NEW');
    const cursor = snap1.endpoints.ide.latest_completed_cursor;

    const markRes = core.markEndpointHandled('ide', { expected_cursor: cursor });
    assert.equal(markRes.success, true);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    // 重复投递相同的 Stop Hook (相同 step_index 和 content)
    adapter.handleStopHook(hookEvent);
    const snap2 = core.getSnapshot();
    // 依然为 NO_NEW_RESULT，绝不重复生成 NEW，绝不破坏 handled 账本
    assert.equal(snap2.endpoints.ide.result_state, 'NO_NEW_RESULT');
    assert.equal(snap2.endpoints.ide.last_handled_cursor, cursor);
    assert.equal(snap2.endpoints.ide.latest_completed_cursor, cursor);
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 5. explicit Mark handled returns IDE to NO_NEW_RESULT, Browser unchanged', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // Browser 设置为 NEW
    core.recordEndpointObservation('browser', {
      conversation_id: 'conv-browser-001',
      trusted: true,
      latest_completed_cursor: 'browser-new-turn'
    });
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'IDE finished something' }
    ]);

    adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });

    const snapBefore = core.getSnapshot();
    assert.equal(snapBefore.endpoints.ide.result_state, 'NEW');
    assert.equal(snapBefore.endpoints.browser.result_state, 'NEW');

    // 显式标记 IDE handled
    const ideCursor = snapBefore.endpoints.ide.latest_completed_cursor;
    const handledRes = core.markEndpointHandled('ide', { expected_cursor: ideCursor });
    assert.equal(handledRes.success, true);

    const snapAfter = core.getSnapshot();
    // IDE 返回 NO_NEW_RESULT，Browser NEW 完全保持不变
    assert.equal(snapAfter.endpoints.ide.result_state, 'NO_NEW_RESULT');
    assert.equal(snapAfter.endpoints.browser.result_state, 'NEW');
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 6. restart/reopen restores the handled IDE cursor without replaying it as NEW', () => {
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

      // 重启协调核验
      const recon = reloadedAdapter.reconcileOnStartup(transcriptFile);
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

test('[IDE Adapter] 7. next genuine final IDE completion advances exactly once after restart', () => {
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

      reloadedAdapter.reconcileOnStartup(transcriptFile);
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

test('[IDE Adapter] 8. stale binding revision, transcript truncation/drift, identity mismatch, ambiguous replay cursor, or hook drift fails closed to UNKNOWN / UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    // 8a. 过期 binding_revision：直接 fail closed
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ag-001',
      binding_revision: 99, // 期望为 1
      trusted: true,
      latest_completed_cursor: 'ag-step:1:aaaabbbb'
    });
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');
    assert.match(core.getSnapshot().endpoints.ide.continuity.unknown_reason, /stale_revision/);

    // 8a-2. 旧版本 adapter 的 fail-closed observation 必须携带其绑定时的 binding_revision
    // 当 core 升级到 rev 2 之后，持有着 rev 1 的旧 adapter 发出的 failure 观察无法篡改新 revision 的端点
    core.updateBinding({
      ...binding,
      binding_revision: 2
    });
    // 此时 Core 的 revision 为 2，设置当前端点为受信 NO_NEW_RESULT
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ag-001',
      binding_revision: 2,
      trusted: true,
      latest_completed_cursor: 'ag-step:1:rev2valid'
    });
    core.markEndpointHandled('ide', { expected_cursor: 'ag-step:1:rev2valid' });
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    // adapter 仍然持有旧的 binding (rev 1)，直接调用其私有 _failClosedToUnknown 模拟抛出 fail closed 事实
    adapter._failClosedToUnknown('some_failure');
    // Core 收到带 revision 1 的 observation，与当前 revision 2 不符，判定为 stale_revision
    assert.match(core.getSnapshot().endpoints.ide.continuity.unknown_reason, /stale_revision: expected rev 2, got rev 1/);

    // 8b. Transcript 截断与漂移 (Handled cursor step_index 不在 transcript 或指纹不符)
    // 恢复为版本 1 的 binding，测试同版本下的历史截断
    core.updateBinding({
      ...binding,
      binding_revision: 1
    });
    writeTranscript(transcriptFile, [
      { step_index: 10, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Completely different truncated step' }
    ]);
    // 假定此前 handled 为 step 5
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ag-001',
      binding_revision: 1,
      trusted: true,
      latest_completed_cursor: 'ag-step:5:deadbeef12345678'
    });
    core.markEndpointHandled('ide', { expected_cursor: 'ag-step:5:deadbeef12345678' });

    const reconDrift = adapter.reconcileOnStartup(transcriptFile);
    assert.equal(reconDrift.status, 'UNKNOWN');
    const snapDrift = core.getSnapshot();
    assert.equal(snapDrift.endpoints.ide.result_state, 'UNKNOWN');
    assert.match(snapDrift.endpoints.ide.continuity.unknown_reason, /UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION/);

    // 8c. Transcript 文件丢失
    const reconMissing = adapter.reconcileOnStartup('/non/existent/path/transcript.jsonl');
    assert.equal(reconMissing.status, 'UNKNOWN');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 9. provider-specific transcript/step/fingerprint fields never become Core schema', () => {
  const { transcriptFile, cleanup } = createTempDir();
  try {
    const binding = makeSampleBinding();
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding });
    const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

    writeTranscript(transcriptFile, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1' }
    ]);

    adapter.handleStopHook({
      conversationId: 'conv-ag-001',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFile
    });

    const snapshot = core.getSnapshot();
    const ideFact = snapshot.endpoints.ide;

    // Core schema 只有规范字段：endpoint, result_state, latest_completed_cursor, last_handled_cursor, completed_at, continuity, updated_at
    const allowedCoreKeys = new Set([
      'endpoint',
      'result_state',
      'latest_completed_cursor',
      'last_handled_cursor',
      'completed_at',
      'continuity',
      'unknown_reason',
      'updated_at'
    ]);

    for (const key of Object.keys(ideFact)) {
      assert.equal(allowedCoreKeys.has(key), true, 'Unexpected provider key: ' + key);
    }

    // 明确断言绝不包含 Antigravity 私有属性
    assert.equal('step_index' in ideFact, false);
    assert.equal('stepIndex' in ideFact, false);
    assert.equal('fingerprint' in ideFact, false);
    assert.equal('transcript_path' in ideFact, false);
    assert.equal('terminationReason' in ideFact, false);

    // 游标在 Core 中纯粹是不透明字符串
    assert.equal(typeof ideFact.latest_completed_cursor, 'string');
    const decoded = decodeOpaqueCursor(ideFact.latest_completed_cursor);
    assert.equal(decoded.stepIndex, 1);
  } finally {
    cleanup();
  }
});

test('[IDE Adapter] 10. no owner/next-actor semantics, no multi-conversation orchestration, no #17 UI, no Relay send work', () => {
  const binding = makeSampleBinding();
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding });

  const snap = core.getSnapshot();
  // 严格继承 Parent Spec #12 与 CONTEXT.md 约束
  assert.equal('baton' in snap, false);
  assert.equal('owner' in snap, false);
  assert.equal('next_actor' in snap, false);
  assert.equal('orchestration' in snap, false);
  assert.equal('relay' in snap, false);
});
