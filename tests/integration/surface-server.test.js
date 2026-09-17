/**
 * 状态表面本地 HTTP 服务集成测试 (Surface Server Integration Tests)
 * 验证 Issue #17 规定的端点隔离、精确处理与只读表面语义
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

describe('Surface Server 集成测试', () => {
  let registry;
  let serverHandle;
  let baseUrl;

  const bindingAlpha = {
    binding_id: 'proj-alpha',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-browser-1' },
    ide_endpoints: [
      {
        endpoint_id: 'ide-a',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-a',
        workspace_identity: '/ws/repo',
        repository_identity: 'github.com/org/repo'
      },
      {
        endpoint_id: 'ide-b',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-b',
        workspace_identity: '/ws/repo',
        repository_identity: 'github.com/org/repo'
      }
    ],
    capabilities: ['read', 'write'],
    paused: false
  };

  before(async () => {
    registry = createProjectRegistry();
    const core = registry.registerProject({ binding: bindingAlpha });

    // 初始化为 Triple NEW
    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cursor-browser-1',
      provider: 'chatgpt',
      conversation_id: 'conv-browser-1',
      endpoint_revision: 1
    });

    core.recordEndpointObservation('ide-a', {
      trusted: true,
      latest_completed_cursor: 'cursor-ide-a-1',
      endpoint_id: 'ide-a',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-a',
      workspace_identity: '/ws/repo',
      repository_identity: 'github.com/org/repo'
    });

    core.recordEndpointObservation('ide-b', {
      trusted: true,
      latest_completed_cursor: 'cursor-ide-b-1',
      endpoint_id: 'ide-b',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-b',
      workspace_identity: '/ws/repo',
      repository_identity: 'github.com/org/repo'
    });

    serverHandle = await startStatusSurfaceServer({ registry, port: 0, host: '127.0.0.1' });
    baseUrl = serverHandle.url;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('1. GET / 成功返回渲染完整的 HTML 页面', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);

    const html = await res.text();
    assert.match(html, /Rally Status Surface/);
    assert.match(html, /proj-alpha/);
    assert.match(html, /Browser 端点/);
    assert.match(html, /IDE 端点 \[ide-a\]/);
    assert.match(html, /IDE 端点 \[ide-b\]/);
    // 验证 Triple NEW 均已渲染在 HTML 中
    const newCount = (html.match(/badge badge-new/g) || []).length;
    assert.equal(newCount >= 3, true);
    // 绝不包含 baton 或 whose turn
    assert.equal(html.includes('baton'), false);
    assert.equal(html.includes('whose turn'), false);
  });

  it('2. GET /api/projects 成功返回机器可读的状态表面模型', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(Array.isArray(json.projects), true);
    assert.equal(json.projects.length, 1);
    const proj = json.projects[0];
    assert.equal(proj.binding_id, 'proj-alpha');
    assert.equal(proj.browser.result_state, 'NEW');
    assert.equal(proj.ide_endpoints[0].result_state, 'NEW');
    assert.equal(proj.ide_endpoints[1].result_state, 'NEW');
  });

  it('3. POST mark handled 精确作用于 Browser 端点，IDE 两端点保持 NEW 不变', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/endpoints/browser/handled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_cursor: 'cursor-browser-1' })
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.handled_cursor, 'cursor-browser-1');

    // 验证底层规范事实：Browser 变为 NO_NEW_RESULT，IDE 端点依然为 NEW
    const core = registry.getProject('proj-alpha');
    const snapshot = core.getSnapshot();
    assert.equal(snapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(snapshot.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
    assert.equal(snapshot.endpoints.ide_endpoints['ide-b'].result_state, 'NEW');
  });

  it('4. POST mark handled 精确作用于 IDE-A 端点，Browser 与 IDE-B 不受干扰', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/endpoints/ide-a/handled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_cursor: 'cursor-ide-a-1' })
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.handled_cursor, 'cursor-ide-a-1');

    const core = registry.getProject('proj-alpha');
    const snapshot = core.getSnapshot();
    assert.equal(snapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(snapshot.endpoints.ide_endpoints['ide-a'].result_state, 'NO_NEW_RESULT');
    // IDE-B 依然保持独立的 NEW
    assert.equal(snapshot.endpoints.ide_endpoints['ide-b'].result_state, 'NEW');
  });

  it('5. 游标失配时拒绝处理，返回 400 且不改写状态', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/endpoints/ide-b/handled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_cursor: 'wrong-cursor' })
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.reason, 'cursor_mismatch');

    // IDE-B 仍然是 NEW
    const core = registry.getProject('proj-alpha');
    const snapshot = core.getSnapshot();
    assert.equal(snapshot.endpoints.ide_endpoints['ide-b'].result_state, 'NEW');
  });

  it('6. 请求不存在的项目返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-nonexistent/endpoints/browser/handled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_cursor: 'any' })
    });
    assert.equal(res.status, 404);
  });

  it('7. 数字游标（如 0 或整数）在 POST mark handled 中精确全等匹配，不因类型强制转换导致 mismatch', async () => {
    // 注册一个包含数字游标的测试项目
    const numBinding = {
      binding_id: 'proj-numeric-cursor',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'conv-num-1' },
      ide_endpoints: [{
        endpoint_id: 'ide-num',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-num',
        workspace_identity: '/ws/num',
        repository_identity: 'github.com/org/num'
      }],
      capabilities: ['read', 'write'],
      paused: false
    };
    const numCore = registry.registerProject({ binding: numBinding });
    numCore.recordEndpointObservation('ide-num', {
      trusted: true,
      latest_completed_cursor: 0, // 数字 0
      endpoint_id: 'ide-num',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-num',
      workspace_identity: '/ws/num',
      repository_identity: 'github.com/org/num'
    });

    const res = await fetch(`${baseUrl}/api/projects/proj-numeric-cursor/endpoints/ide-num/handled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_cursor: 0 })
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.handled_cursor, 0);

    const snapshot = numCore.getSnapshot();
    assert.equal(snapshot.endpoints.ide_endpoints['ide-num'].result_state, 'NO_NEW_RESULT');
    assert.equal(snapshot.endpoints.ide_endpoints['ide-num'].last_handled_cursor, 0);
  });
});
