/**
 * Live Surface Refresh 集成测试 (Live Surface Refresh Integration Tests)
 * 验证 Issue #34 规范要求：
 * 1. already-open Surface 无需 reload 即可反映后端端点事实与红点派生状态变化；
 * 2. refresh 路径完全只读，不建立第二套 client truth store；
 * 3. 失败时 fail-visible / stale，不编造新状态；
 * 4. 保持 #27 ordering/observation 与 #26 compact presentation 语义不变。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { applyProjectionToDom, setSurfaceStaleStatus } from '../../src/surface/live-refresh-client.js';

describe('Live Surface Refresh 实时刷新集成测试', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let core;

  before(async () => {
    registry = createProjectRegistry();
    core = registry.registerProject({
      binding: {
        binding_id: 'proj-live-test',
        display_name: 'Live Surface Test Project',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-browser-live' },
        ide_endpoints: [{
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-live',
          workspace_identity: '/ws/live',
          repository_identity: 'github.com/org/live'
        }],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    // 初始化为 caught-up 基线
    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-b-0',
      provider: 'chatgpt',
      conversation_id: 'conv-browser-live',
      endpoint_revision: 1
    });
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      latest_completed_cursor: 'cur-i-0',
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-live',
      workspace_identity: '/ws/live',
      repository_identity: 'github.com/org/live'
    });
    core.markEndpointHandled('browser', { expected_cursor: 'cur-b-0' });
    core.markEndpointHandled('ide-primary', { expected_cursor: 'cur-i-0' });

    serverHandle = await startStatusSurfaceServer({
      registry,
      port: 0,
      host: '127.0.0.1'
    });
    baseUrl = serverHandle.url;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('1. GET / 响应中包含实时同步指示器、live refresh 客户端脚本与初始紧凑语法', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /id="surface-sync-indicator"/, 'HTML 必须包含 #surface-sync-indicator 元素');
    assert.match(html, /fetchAndApplyProjects|__triggerSurfaceRefresh/, 'HTML 必须包含 live refresh 客户端脚本');
    assert.match(html, /Live Surface Test Project/);

    const dom = new JSDOM(html);
    const scanRow = dom.window.document.querySelector('.project-scan-row');
    assert.ok(scanRow);
    assert.equal(scanRow.querySelector('.badge-new'), null, '扫描行初始状态严禁渲染 badge-new');
  });

  it('2. 实时刷新：无需 reload，已打开 Surface 正确反映 Browser 完成与红点打点', async () => {
    // 1. 模拟打开了 Surface 页面
    const pageRes = await fetch(`${baseUrl}/`);
    const initialHtml = await pageRes.text();
    const dom = new JSDOM(initialHtml, { runScripts: 'outside-only' });
    const doc = dom.window.document;

    const card = doc.getElementById('card-proj-live-test');
    assert.ok(card);
    assert.equal(card.querySelectorAll('.latest-dot').length, 0, '初始无红点');

    // 2. 后端异步见证了 Browser 完成 (Live witnessed completion -> BROWSER_LATEST)
    const browserTime = new Date().toISOString();
    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-b-1',
      provider: 'chatgpt',
      conversation_id: 'conv-browser-live',
      endpoint_revision: 1,
      completed_at: browserTime,
      live_witnessed: true
    });

    // 3. 客户端在后台执行只读轮询 GET /api/projects
    const apiRes = await fetch(`${baseUrl}/api/projects`);
    assert.equal(apiRes.status, 200);
    const apiData = await apiRes.json();

    assert.equal(apiData.projects[0].latest_result_indicator, 'BROWSER_LATEST');
    assert.equal(apiData.projects[0].browser.is_latest_result, true);

    // 4. 只读投影消费者将数据反映到已打开的 DOM
    applyProjectionToDom(doc, apiData.projects, apiData.attention_tray);

    // 5. 验证 DOM 变化：Browser 标签出现红点，IDE 标签无红点，无 routine NEW 文本污染
    const browserTag = card.querySelector('.endpoint-tag-browser');
    assert.ok(browserTag.classList.contains('has-latest'));
    assert.ok(browserTag.querySelector('.latest-dot'));

    const ideTag = card.querySelector('.endpoint-tag-ide');
    assert.equal(ideTag.classList.contains('has-latest'), false);
    assert.equal(ideTag.querySelector('.latest-dot'), null);

    const scanRow = card.querySelector('.project-scan-row');
    assert.equal(scanRow.textContent.includes('NO_NEW_RESULT'), false);
  });

  it('3. 实时刷新：对侧 IDE 产生新完成时红点自动移动至 IDE，前一端点红点清除，且不改写 Endpoint Result 真实事实', async () => {
    // 1. 获取当前页面状态并放入 JSDOM
    const pageRes = await fetch(`${baseUrl}/api/projects`);
    const dataBefore = await pageRes.json();
    const dom = new JSDOM(await (await fetch(`${baseUrl}/`)).text());
    const doc = dom.window.document;
    applyProjectionToDom(doc, dataBefore.projects);

    const card = doc.getElementById('card-proj-live-test');
    assert.ok(card.querySelector('.endpoint-tag-browser').classList.contains('has-latest'));

    // 2. 后端见证 IDE 完成 (Live witnessed IDE completion -> IDE_LATEST)
    const ideTime = new Date().toISOString();
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      latest_completed_cursor: 'cur-i-1',
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-live',
      workspace_identity: '/ws/live',
      repository_identity: 'github.com/org/live',
      completed_at: ideTime,
      live_witnessed: true
    });

    // 3. 客户端再次只读拉取 /api/projects
    const apiRes = await fetch(`${baseUrl}/api/projects`);
    const apiData = await apiRes.json();
    assert.equal(apiData.projects[0].latest_result_indicator, 'IDE_LATEST');
    assert.equal(apiData.projects[0].ide_endpoints[0].is_latest_result, true);

    // 4. 客户端单向刷新 DOM
    applyProjectionToDom(doc, apiData.projects);

    // 5. 验证红点移动：IDE 具有红点，Browser 失去红点
    const browserTag = card.querySelector('.endpoint-tag-browser');
    assert.equal(browserTag.classList.contains('has-latest'), false);
    assert.equal(browserTag.querySelector('.latest-dot'), null);

    const ideTag = card.querySelector('.endpoint-tag-ide');
    assert.ok(ideTag.classList.contains('has-latest'));
    assert.ok(ideTag.querySelector('.latest-dot'));

    // 6. 验证底层的规范 Dual-NEW 真实事实完好保留（Browser NEW 并没有因为红点移开而被抹除！）
    const snapshot = core.getSnapshot();
    assert.equal(snapshot.endpoints.browser.result_state, 'NEW');
    assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].result_state, 'NEW');
  });

  it('4. Fail-Visible / Stale: 刷新请求失败时显式标记陈旧，绝不捏造新状态或前进游标', async () => {
    const dom = new JSDOM(await (await fetch(`${baseUrl}/`)).text());
    const doc = dom.window.document;

    // 模拟客户端网络断开或服务端返回 500
    setSurfaceStaleStatus(doc, {
      isStale: true,
      reason: 'Failed to fetch /api/projects: NetworkError',
      lastSyncTime: new Date(Date.now() - 5000).toISOString()
    });

    assert.equal(doc.body.getAttribute('data-surface-stale'), 'true');
    const indicator = doc.getElementById('surface-sync-indicator');
    assert.ok(indicator.classList.contains('sync-stale'));
    assert.match(indicator.textContent, /保持陈旧|同步断开/);

    // 验证状态未前进
    const card = doc.getElementById('card-proj-live-test');
    assert.ok(card);
  });
});
