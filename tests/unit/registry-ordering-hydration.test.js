/**
 * ProjectRegistry Ordering Hydration & Backward Compatibility Suite
 * 
 * 强制契约 (Delta 2):
 * 1. 真实落盘与加载能够完整持久化与还原 ordering_evidence checkpoint；
 * 2. 兼容老版本 schema-v2 数据：若老文件没有 ordering_evidence 字段，安全默认 NONE，不升 schema_version。
 * 3. 跨重启后可调用 registry.reconcileProjectOrdering(bindingId) 正常对账。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry, CURRENT_SCHEMA_VERSION } from '../../src/registry/project-registry.js';

function createTempStoragePath(prefix = 'rally-test-hydration-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir: tmpDir,
    file: path.join(tmpDir, 'registry.json'),
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('[Registry Ordering Hydration] 1. 真实落盘与恢复完整保留 ordering checkpoint 事实', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg1 = createProjectRegistry({ storagePath: file });
    const p1 = reg1.registerProject({
      binding: createBinding({
        binding_id: 'proj-hydration-1',
        display_name: 'Hydration 1',
        browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
        ide: { conversation_id: 'ide-conv-1', workspace_identity: '/ws/1', repository_identity: 'repo/1' }
      })
    });

    // 记录两端初始游标，并由 Browser live 见证产生最新完成
    p1.recordEndpointObservation('ide', {
      conversation_id: 'ide-conv-1',
      trusted: true,
      latest_completed_cursor: 'ide_c1'
    });
    p1.recordEndpointObservation('browser', {
      conversation_id: 'b-conv-1',
      trusted: true,
      latest_completed_cursor: 'b_c1',
      live_witnessed: true
    });

    const snap1 = p1.getSnapshot();
    assert.equal(snap1.ordering_evidence.latest_endpoint, 'browser');
    assert.equal(snap1.ordering_evidence.checkpoint_cursors.browser, 'b_c1');
    assert.equal(snap1.ordering_evidence.checkpoint_cursors.ide['ide'], 'ide_c1');

    reg1.saveToFile();

    // 重新从磁盘加载
    const reg2 = createProjectRegistry({ storagePath: file });
    assert.equal(CURRENT_SCHEMA_VERSION, 2, 'Must remain schema-v2 without bumping');

    const p1Recovered = reg2.getProject('proj-hydration-1');
    assert.ok(p1Recovered, 'Project must be recovered');
    const snap2 = p1Recovered.getSnapshot();

    assert.equal(snap2.ordering_evidence.latest_endpoint, 'browser');
    assert.equal(snap2.ordering_evidence.checkpoint_cursors.browser, 'b_c1');
    assert.equal(snap2.ordering_evidence.checkpoint_cursors.ide['ide'], 'ide_c1');
    assert.equal(snap2.ordering_evidence.certainty, 'DEFINITE');
  } finally {
    cleanup();
  }
});

test('[Registry Ordering Hydration] 2. 兼容旧版本 schema-v2 数据（缺失 ordering_evidence 安全默认 NONE）', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg1 = createProjectRegistry({ storagePath: file });
    const p1 = reg1.registerProject({
      binding: createBinding({
        binding_id: 'proj-legacy',
        display_name: 'Legacy Project',
        browser: { provider: 'chatgpt', conversation_id: 'b-legacy' },
        ide: { conversation_id: 'ide-legacy', workspace_identity: '/ws/legacy', repository_identity: 'repo/legacy' }
      })
    });

    p1.recordEndpointObservation('browser', {
      conversation_id: 'b-legacy',
      trusted: true,
      latest_completed_cursor: 'b-leg-cur'
    });
    p1.recordEndpointObservation('ide', {
      conversation_id: 'ide-legacy',
      trusted: true,
      latest_completed_cursor: 'ide-leg-cur'
    });

    reg1.saveToFile();

    // 模拟旧版 schema-v2 数据：读取落盘文件并剥离 ordering_evidence 字段
    const rawData = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rawData.schema_version, 2);
    for (const projKey of Object.keys(rawData.projects)) {
      delete rawData.projects[projKey].ordering_evidence;
    }
    fs.writeFileSync(file, JSON.stringify(rawData, null, 2), 'utf8');

    // 重新从磁盘加载剥离了 ordering_evidence 的旧版数据
    const reg2 = createProjectRegistry({ storagePath: file });
    assert.equal(CURRENT_SCHEMA_VERSION, 2);

    const proj = reg2.getProject('proj-legacy');
    assert.ok(proj);

    const snap = proj.getSnapshot();
    assert.ok(snap.ordering_evidence, 'ordering_evidence must be safely hydrated');
    assert.equal(snap.ordering_evidence.latest_endpoint, null);
    assert.equal(snap.ordering_evidence.certainty, 'NONE');
    assert.equal(snap.ordering_evidence.evidence_type, 'INITIAL');
    assert.equal(snap.ordering_evidence.checkpoint_cursors.browser, 'b-leg-cur');
    assert.equal(snap.ordering_evidence.checkpoint_cursors.ide['ide'], 'ide-leg-cur');

    // 验证可通过 registry.reconcileProjectOrdering 正常对账（返回更新后的 snapshot）
    const reconciledSnapshot = reg2.reconcileProjectOrdering('proj-legacy');
    assert.ok(reconciledSnapshot);
    // 游标未发生变化，对账保持先前 NONE
    assert.equal(reconciledSnapshot.ordering_evidence.certainty, 'NONE');
    assert.equal(reconciledSnapshot.ordering_evidence.latest_endpoint, null);
  } finally {
    cleanup();
  }
});



