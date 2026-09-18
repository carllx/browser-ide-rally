import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createInitialEndpointFact,
  hydrateEndpointFact,
  formatEndpointSnapshot
} from '../../src/status/endpoint-ledger.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

test('Result Material — 1. initial fact 包含 latest_completed_result: null', () => {
  const fact = createInitialEndpointFact({ endpoint: 'browser', role: 'browser' });
  assert.strictEqual(fact.latest_completed_result, null);
});

test('Result Material — 2. recordEndpointObservation fail-safe 更新规则', () => {
  const binding = createBinding({
    binding_id: 'proj-rm-1',
    browser: { provider: 'chatgpt', conversation_id: 'conv-1' },
    ide: { conversation_id: 'conv-ide-1', workspace_identity: '/ws', repository_identity: 'org/repo' }
  });
  const core = createProjectStatusCore({ binding });

  // 1) trusted observation 首次带匹配 cursor 的 result artifact -> 成功安装
  const artifact1 = {
    cursor: 'cur-1',
    result_ref: 'res_ref_1',
    text: 'Hello from browser turn 1',
    captured_at: '2026-09-18T10:00:00Z'
  };
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-1',
    completed_at: '2026-09-18T10:00:00Z',
    latest_completed_result: artifact1
  });

  let snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.latest_completed_cursor, 'cur-1');
  assert.deepEqual(snap.endpoints.browser.latest_completed_result, artifact1);

  // 2) cursor 未变化，且新 observation 未带 result material -> 保留已有匹配 artifact
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-1',
    completed_at: '2026-09-18T10:00:00Z'
  });
  snap = core.getSnapshot();
  assert.deepEqual(snap.endpoints.browser.latest_completed_result, artifact1);

  // 3) cursor 前进到 cur-2，但新 observation 缺失 result material -> 旧 artifact 必须清除置为 null
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-2',
    completed_at: '2026-09-18T10:05:00Z'
  });
  snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.latest_completed_cursor, 'cur-2');
  assert.strictEqual(snap.endpoints.browser.latest_completed_result, null);
  // NEW 状态依然根据 cursor != handled 推导，不被破坏
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');

  // 4) cursor 前进到 cur-3，但携带的 artifact cursor 不匹配 ('cur-mismatch') -> 必须清除置为 null
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-3',
    completed_at: '2026-09-18T10:10:00Z',
    latest_completed_result: {
      cursor: 'cur-mismatch',
      result_ref: 'res_bad',
      text: 'Bad artifact',
      captured_at: '2026-09-18T10:10:00Z'
    }
  });
  snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.latest_completed_cursor, 'cur-3');
  assert.strictEqual(snap.endpoints.browser.latest_completed_result, null);
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');

  // 5) cursor 保持 cur-3，新 observation 携带了正确的 artifact -> 安装成功
  const artifact3 = {
    cursor: 'cur-3',
    result_ref: 'res_ref_3',
    text: 'Valid artifact for cur-3',
    captured_at: '2026-09-18T10:12:00Z'
  };
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-3',
    completed_at: '2026-09-18T10:12:00Z',
    latest_completed_result: artifact3
  });
  snap = core.getSnapshot();
  assert.deepEqual(snap.endpoints.browser.latest_completed_result, artifact3);
});

test('Result Material — 3. Rebind 与 Add endpoint 正确初始化 latest_completed_result: null', () => {
  const binding = createBinding({
    binding_id: 'proj-rm-rebind',
    browser: { provider: 'chatgpt', conversation_id: 'conv-1' },
    ide: { conversation_id: 'conv-ide-1', workspace_identity: '/ws', repository_identity: 'org/repo' }
  });
  const core = createProjectStatusCore({ binding });

  // 先记录一个完成结果
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-1',
    latest_completed_result: {
      cursor: 'cur-1',
      result_ref: 'ref-1',
      text: 'hello',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });
  assert.ok(core.getSnapshot().endpoints.browser.latest_completed_result);

  // 重新绑定 Browser 端点（需显式确认丢弃 unhandled NEW）
  core.rebindEndpoint({
    endpoint: 'browser',
    identity: { conversation_id: 'conv-2' },
    allow_discard_unhandled: true
  });
  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.latest_completed_result, null);
  assert.strictEqual(snap.endpoints.browser.latest_completed_cursor, null);

  // 添加新 IDE 端点
  core.addIdeEndpoint({
    endpoint_id: 'ide-2',
    identity: {
      conversation_id: 'conv-ide-2',
      workspace_identity: '/ws2',
      repository_identity: 'org/repo'
    }
  });
  const snapAfterAdd = core.getSnapshot();
  assert.strictEqual(snapAfterAdd.endpoints.ide_endpoints['ide-2'].latest_completed_result, null);
});

test('Result Material — 4. hydrateEndpointFact 校验与丢弃游标不匹配的 artifact', () => {
  // 1) 游标完全匹配 -> 成功水合
  const validArtifact = {
    cursor: 'cur-abc',
    result_ref: 'ref_abc',
    text: 'Some content',
    captured_at: '2026-09-18T10:00:00Z'
  };
  const hydratedValid = hydrateEndpointFact({
    endpoint: 'browser',
    role: 'browser',
    endpoint_revision: 1,
    latest_completed_cursor: 'cur-abc',
    last_handled_cursor: null,
    latest_completed_result: validArtifact,
    continuity: { trusted: true, unknown_reason: null }
  }, 'browser', { role: 'browser' });
  assert.deepEqual(hydratedValid.latest_completed_result, validArtifact);

  // 2) 游标不匹配 -> 丢弃为 null，但不影响 latest_completed_cursor 和 trusted 连续性
  const hydratedMismatched = hydrateEndpointFact({
    endpoint: 'browser',
    role: 'browser',
    endpoint_revision: 1,
    latest_completed_cursor: 'cur-abc',
    last_handled_cursor: null,
    latest_completed_result: { ...validArtifact, cursor: 'cur-different' },
    continuity: { trusted: true, unknown_reason: null }
  }, 'browser', { role: 'browser' });
  assert.strictEqual(hydratedMismatched.latest_completed_result, null);
  assert.strictEqual(hydratedMismatched.latest_completed_cursor, 'cur-abc');
  assert.strictEqual(hydratedMismatched.continuity.trusted, true);

  // 3) 端点未受信 -> latest_completed_result 为 null
  const hydratedUntrusted = hydrateEndpointFact({
    endpoint: 'browser',
    role: 'browser',
    endpoint_revision: 1,
    latest_completed_cursor: 'cur-abc',
    last_handled_cursor: null,
    latest_completed_result: validArtifact,
    continuity: { trusted: false, unknown_reason: 'some_err' }
  }, 'browser', { role: 'browser' });
  assert.strictEqual(hydratedUntrusted.latest_completed_result, null);
});

test('Result Material — 5. ProjectRegistry persistence round-trip 验证', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-registry-rm-'));
  const storagePath = path.join(tmpDir, 'registry.json');

  const reg1 = createProjectRegistry({ storagePath });
  const binding = createBinding({
    binding_id: 'proj-persist-rm',
    browser: { provider: 'chatgpt', conversation_id: 'conv-browser-persist' },
    ide_endpoints: [{
      endpoint_id: 'ide-main',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-persist',
      workspace_identity: '/path/ws',
      repository_identity: 'owner/repo'
    }]
  });
  const core1 = reg1.registerProject({ binding });

  const browserArtifact = {
    cursor: 'br-cur-1',
    result_ref: 'res_br_1',
    text: 'Browser generated code for review',
    captured_at: '2026-09-18T10:00:00Z'
  };
  core1.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-persist',
    trusted: true,
    latest_completed_cursor: 'br-cur-1',
    latest_completed_result: browserArtifact
  });

  const ideArtifact = {
    cursor: 'ide-cur-1',
    result_ref: 'res_ide_1',
    text: 'IDE tests passed completely',
    captured_at: '2026-09-18T10:01:00Z'
  };
  core1.recordEndpointObservation('ide-main', {
    conversation_id: 'conv-ide-persist',
    workspace_identity: '/path/ws',
    repository_identity: 'owner/repo',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'ide-cur-1',
    latest_completed_result: ideArtifact
  });

  // 持久化保存
  reg1.saveToFile(storagePath);
  assert.ok(fs.existsSync(storagePath));

  // 重启创建新 Registry 并加载
  const reg2 = createProjectRegistry({ storagePath });
  const core2 = reg2.getProject('proj-persist-rm');
  const snap2 = core2.getSnapshot();

  assert.strictEqual(snap2.endpoints.browser.result_state, 'NEW');
  assert.deepEqual(snap2.endpoints.browser.latest_completed_result, browserArtifact);

  assert.strictEqual(snap2.endpoints.ide_endpoints['ide-main'].result_state, 'NEW');
  assert.deepEqual(snap2.endpoints.ide_endpoints['ide-main'].latest_completed_result, ideArtifact);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
