/**
 * TDD Seam 4: Mutation request-format seam 测试
 * 验证 Issue #28 规范：
 * 1. mutation endpoints require the intended JSON Content-Type/body contract;
 * 2. wrong Content-Type or malformed JSON fails before mutation;
 * 3. 拒绝请求保证零状态变更 (zero state change)。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

describe('TDD Seam 4: Mutation request-format seam', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let sessionToken;

  const testBinding = {
    binding_id: 'format-test-proj',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-fmt-browser' },
    ide_endpoints: [{
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-fmt-ide',
      workspace_identity: '/ws/format',
      repository_identity: 'github.com/org/format'
    }],
    capabilities: ['read', 'write'],
    paused: false
  };

  before(async () => {
    registry = createProjectRegistry();
    const core = registry.registerProject({ binding: testBinding });
    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-fmt-1',
      provider: 'chatgpt',
      conversation_id: 'conv-fmt-browser',
      endpoint_revision: 1
    });

    serverHandle = await startStatusSurfaceServer({ registry, port: 0 });
    baseUrl = serverHandle.url;
    sessionToken = serverHandle.sessionToken || 'test-session-token';
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('1. 突变路由拒绝 text/plain Content-Type 请求，返回 415 且端点保持 NEW 零突变', async () => {
    const res = await fetch(`${baseUrl}/api/projects/format-test-proj/endpoints/browser/handled`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Rally-Session-Token': sessionToken
      },
      body: JSON.stringify({ expected_cursor: 'cur-fmt-1' })
    });

    assert.equal(res.status, 415);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.reason, /UNSUPPORTED_MEDIA_TYPE_JSON_REQUIRED/);

    // 验证底层规范事实绝对零变更：仍然保持 NEW
    const proj = registry.getProject('format-test-proj').getSnapshot();
    assert.equal(proj.endpoints.browser.result_state, 'NEW');
    assert.equal(proj.endpoints.browser.last_handled_cursor, null);
  });

  it('2. 突变路由拒绝缺失 Content-Type 请求头，返回 415 且零突变', async () => {
    const res = await fetch(`${baseUrl}/api/projects/format-test-proj/endpoints/browser/handled`, {
      method: 'POST',
      headers: {
        'X-Rally-Session-Token': sessionToken
      },
      body: JSON.stringify({ expected_cursor: 'cur-fmt-1' })
    });

    assert.equal(res.status, 415);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.reason, /UNSUPPORTED_MEDIA_TYPE_JSON_REQUIRED/);

    // 验证底层事实仍然保持 NEW
    const proj = registry.getProject('format-test-proj').getSnapshot();
    assert.equal(proj.endpoints.browser.result_state, 'NEW');
  });

  it('3. 突变路由拒绝畸形 JSON 请求体，返回 400 且零突变', async () => {
    const res = await fetch(`${baseUrl}/api/projects/format-test-proj/endpoints/browser/handled`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rally-Session-Token': sessionToken
      },
      body: '{"expected_cursor": "cur-fmt-1", broken json...'
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.reason, /Invalid JSON|invalid_json_body/i);

    // 验证底层事实依然零突变
    const proj = registry.getProject('format-test-proj').getSnapshot();
    assert.equal(proj.endpoints.browser.result_state, 'NEW');
  });

  it('4. 合法 application/json (含 charset) 正确放行并执行突变', async () => {
    const res = await fetch(`${baseUrl}/api/projects/format-test-proj/endpoints/browser/handled`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Rally-Session-Token': sessionToken
      },
      body: JSON.stringify({ expected_cursor: 'cur-fmt-1' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // 验证处理成功
    const proj = registry.getProject('format-test-proj').getSnapshot();
    assert.equal(proj.endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(proj.endpoints.browser.last_handled_cursor, 'cur-fmt-1');
  });
});
