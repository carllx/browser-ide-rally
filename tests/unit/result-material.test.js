import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createInitialEndpointFact,
  hydrateEndpointFact,
  formatEndpointSnapshot,
  validateAndNormalizeResultMaterial
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

test('Result Material — 5. Production endpoint observations are durably persisted (Blocker 1)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-registry-rm-'));
  const storagePath = path.join(tmpDir, 'registry.json');

  // 1. create registry with storagePath
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
  // 2. register project (Issue #25 规定 registerProject 在配置了 durable storage 时必须立即真正持久化)
  const core1 = reg1.registerProject({ binding });
  assert.strictEqual(fs.existsSync(storagePath), true, 'registerProject must immediately persist');
  fs.unlinkSync(storagePath);

  // 证明 generation-in-progress 不会触发写盘
  core1.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-persist',
    is_generating: true,
    should_record: false
  });
  assert.strictEqual(fs.existsSync(storagePath), false, 'generation-in-progress must NOT trigger persistence');

  // 证明 stale generation 不会触发写盘
  core1.recordEndpointObservation('ide-main', {
    conversation_id: 'wrong-conv-stale',
    endpoint_revision: 999
  });
  assert.strictEqual(fs.existsSync(storagePath), false, 'stale generation must NOT trigger persistence');

  // 3. call recordEndpointObservation() with trusted cursor + result material
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

  // 4. DO NOT manually call saveToFile()! 自动持久化必须已将文件落盘
  assert.strictEqual(fs.existsSync(storagePath), true, 'Observation must automatically persist via onMutation');

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

  // 5. create a new registry from the same storage path
  const reg2 = createProjectRegistry({ storagePath });
  const core2 = reg2.getProject('proj-persist-rm');
  const snap2 = core2.getSnapshot();

  // 6. prove: cursor survived, result state survived, matching latest_completed_result survived
  assert.strictEqual(snap2.endpoints.browser.latest_completed_cursor, 'br-cur-1');
  assert.strictEqual(snap2.endpoints.browser.result_state, 'NEW');
  assert.deepEqual(snap2.endpoints.browser.latest_completed_result, browserArtifact);

  assert.strictEqual(snap2.endpoints.ide_endpoints['ide-main'].latest_completed_cursor, 'ide-cur-1');
  assert.strictEqual(snap2.endpoints.ide_endpoints['ide-main'].result_state, 'NEW');
  assert.deepEqual(snap2.endpoints.ide_endpoints['ide-main'].latest_completed_result, ideArtifact);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Result Material — 6. malformed result material 必须 fail closed 置为 null 且不破坏状态真值 (Blocker 3)', () => {
  // A. validateAndNormalizeResultMaterial 单元校验
  assert.strictEqual(validateAndNormalizeResultMaterial(null, 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial([], 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial('not-an-object', 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial({ cursor: 'c2', result_ref: 'r', text: 't' }, 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial({ cursor: 'c1', result_ref: '', text: 't' }, 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial({ cursor: 'c1', result_ref: '   ', text: 't' }, 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial({ cursor: 'c1', result_ref: 123, text: 't' }, 'c1'), null);
  assert.strictEqual(validateAndNormalizeResultMaterial({ cursor: 'c1', result_ref: 'r', text: 456 }, 'c1'), null);

  // 合规材料正常归一化
  const norm = validateAndNormalizeResultMaterial(
    { cursor: 'c1', result_ref: ' res_1 ', text: 'ok', captured_at: 'invalid-date' },
    'c1',
    '2026-09-18T10:00:00.000Z'
  );
  assert.strictEqual(norm.cursor, 'c1');
  assert.strictEqual(norm.result_ref, 'res_1');
  assert.strictEqual(norm.text, 'ok');
  assert.strictEqual(norm.captured_at, '2026-09-18T10:00:00.000Z');

  // B. observation 记录 malformed artifact: 必须变为 null，但 NEW 状态保持不受损
  const binding = createBinding({
    binding_id: 'proj-rm-malformed',
    browser: { provider: 'chatgpt', conversation_id: 'conv-1' },
    ide: { conversation_id: 'conv-ide-1', workspace_identity: '/ws', repository_identity: 'org/repo' }
  });
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-1',
    trusted: true,
    latest_completed_cursor: 'cur-valid',
    latest_completed_result: {
      cursor: 'cur-valid',
      result_ref: '', // malformed empty ref
      text: 'Some text'
    }
  });

  const snap = core.getSnapshot();
  assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
  assert.strictEqual(snap.endpoints.browser.latest_completed_cursor, 'cur-valid');
  assert.strictEqual(snap.endpoints.browser.latest_completed_result, null);

  // C. hydration 水合 malformed artifact: 必须变为 null，但状态保持
  const hydrated = hydrateEndpointFact({
    endpoint: 'browser',
    role: 'browser',
    endpoint_revision: 1,
    latest_completed_cursor: 'cur-h',
    last_handled_cursor: null,
    latest_completed_result: {
      cursor: 'cur-h',
      result_ref: 'ref-ok',
      text: 12345 // malformed non-string text
    },
    continuity: { trusted: true, unknown_reason: null }
  }, 'browser', { role: 'browser' });

  assert.strictEqual(hydrated.latest_completed_cursor, 'cur-h');
  assert.strictEqual(hydrated.latest_completed_result, null);
  assert.strictEqual(hydrated.continuity.trusted, true);
});
