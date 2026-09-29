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

    const mockAgentApiExecutor = (bin, args) => {
      if (args[0] === 'get-conversation-metadata') {
        return JSON.stringify({
          response: {
            conversationMetadata: {
              metadata: {
                workspaces: [
                  {
                    workspaceFolderAbsoluteUri: 'file:///ws/rebound-path',
                    repository: { computedName: 'github.com/org/rebound-repo' }
                  }
                ]
              }
            }
          }
        });
      }
      throw new Error(`Unsupported command: ${args.join(' ')}`);
    };

    serverHandle = await startStatusSurfaceServer({
      registry,
      agentApiExecutor: mockAgentApiExecutor,
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

  it('5. [Issue #37] 规范版本推进至 N+1 后，已打开页面在下次 Rebind 中自动携带 N+1 且成功呈现新身份', async () => {
    // 1. 获取已打开的页面 DOM
    const initialHtml = await (await fetch(`${baseUrl}/`)).text();
    const dom = new JSDOM(initialHtml, { runScripts: 'outside-only' });
    const doc = dom.window.document;
    const card = doc.getElementById('card-proj-live-test');
    assert.ok(card);

    // 初始版本为 rev 1
    const rebindBtnBefore = card.querySelector('button[data-action="rebind"][data-endpoint-id="ide-primary"]');
    assert.equal(rebindBtnBefore.getAttribute('data-binding-revision'), '1');

    // 2. 服务端规范绑定因某种原因推进至 rev 2 (例如更新能力或通过其他控制器修改)
    const snapshotBefore = core.getSnapshot();
    core.updateBinding({
      ...snapshotBefore.binding,
      binding_revision: snapshotBefore.binding.binding_revision + 1,
      display_name: 'Live Surface Test Project Renamed'
    });
    const snapshotAfterUpdate = core.getSnapshot();
    assert.equal(snapshotAfterUpdate.binding.binding_revision, 2);

    // 3. 客户端平滑拉取最新 /api/projects 并单向应用
    const projectsRes = await fetch(`${baseUrl}/api/projects`);
    const { projects } = await projectsRes.json();
    applyProjectionToDom(doc, projects);

    // 4. 断言：无需用户 reload，Rebind 按钮上的 data-binding-revision 已自动变为 2
    const rebindBtnAfter = card.querySelector('button[data-action="rebind"][data-endpoint-id="ide-primary"]');
    assert.equal(rebindBtnAfter.getAttribute('data-binding-revision'), '2');

    // 5. 使用更新后的版本号提交 Rebind 请求（携带 N+1，即 2）
    const targetRev = parseInt(rebindBtnAfter.getAttribute('data-binding-revision'), 10);
    assert.equal(targetRev, 2);

    const rebindRes = await fetch(`${baseUrl}/api/projects/proj-live-test/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: targetRev,
        target_endpoint: 'ide-primary',
        new_identity: {
          conversation_id: 'conv-rebound-live-999',
          workspace_identity: '/ws/rebound-path',
          repository_identity: 'github.com/org/rebound-repo'
        },
        allow_replace_unhandled: true,
        allow_replace_unknown: true
      })
    });
    const rebindData = await rebindRes.json();
    assert.equal(rebindRes.status, 200);
    assert.equal(rebindData.success, true);
    assert.equal(rebindData.new_binding_revision, 3);

    // 6. 客户端平滑消费更新后的投影
    const refreshedProjects = (await (await fetch(`${baseUrl}/api/projects`)).json()).projects;
    applyProjectionToDom(doc, refreshedProjects);

    // 7. 断言：已打开页面无需 reload，卡片正文中已可见新的会话 ID、工作区和仓库
    const ideCard = card.querySelector('.endpoint-card[data-endpoint-id="ide-primary"]');
    assert.ok(ideCard);
    assert.match(ideCard.textContent, /conv-rebound-live-999/);
    assert.match(ideCard.textContent, /\/ws\/rebound-path/);
    assert.match(ideCard.textContent, /github\.com\/org\/rebound-repo/);

    // 并且 Rebind 按钮属性也同步推进至新版本 rev 3
    assert.equal(rebindBtnAfter.getAttribute('data-binding-revision'), '3');
    assert.equal(rebindBtnAfter.getAttribute('data-conversation-id'), 'conv-rebound-live-999');
  });

  it('6. [Issue #37] 阻断的 Rebind 事实 (BLOCKED) 实时呈现于已打开页面的诊断历史表格，Toast 消失后仍清晰可见', async () => {
    const initialHtml = await (await fetch(`${baseUrl}/`)).text();
    const dom = new JSDOM(initialHtml, { runScripts: 'outside-only' });
    const doc = dom.window.document;
    const card = doc.getElementById('card-proj-live-test');

    const currentBindingRev = core.getSnapshot().binding.binding_revision;

    // 故意提交一个未显式确认替换 UNKNOWN 的 Rebind 请求 -> 触发服务端安全阻断 (BLOCKED 409)
    const blockedRes = await fetch(`${baseUrl}/api/projects/proj-live-test/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: currentBindingRev,
        target_endpoint: 'ide-primary',
        new_identity: {
          conversation_id: 'conv-blocked-attempt',
          workspace_identity: '/ws/blocked',
          repository_identity: 'github.com/org/blocked'
        },
        allow_replace_unhandled: false,
        allow_replace_unknown: false
      })
    });
    assert.equal(blockedRes.status, 409);
    const blockedData = await blockedRes.json();
    assert.equal(blockedData.success, false);
    assert.equal(blockedData.stage, 'BLOCKED');
    assert.match(blockedData.reason, /Cannot replace ide-primary endpoint with unhandled UNKNOWN result/);

    // 客户端平滑拉取最新 /api/projects
    const { projects } = await (await fetch(`${baseUrl}/api/projects`)).json();
    applyProjectionToDom(doc, projects);

    // 断言：诊断区 Actions 表格中清晰渲染出该条 BLOCKED 记录及其具体原因
    const actionsPlane = card.querySelector('.actions-history-plane');
    assert.ok(actionsPlane);
    const blockedRow = actionsPlane.querySelector('.action-row.stage-row-BLOCKED');
    assert.ok(blockedRow, '应存在 stage-row-BLOCKED 表格行');
    assert.match(blockedRow.textContent, /rebind/);
    assert.match(blockedRow.textContent, /BLOCKED/);
    assert.match(blockedRow.textContent, /Cannot replace ide-primary endpoint with unhandled UNKNOWN result/);
  });

  it('7. [Issue #37] 结构拓扑变更（如动态 onboarding 新项目）时拒绝增量假同步，并触发受控全页重载', async () => {
    // 1. 模拟已打开页面（当前注册表仅有 proj-live-test 单项目）
    const initialHtml = await (await fetch(`${baseUrl}/`)).text();
    const dom = new JSDOM(initialHtml, { runScripts: 'outside-only' });
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('.project-card').length, 1);

    // 2. 服务端动态 onboarding 注册新项目 proj-second
    registry.registerProject({
      binding: {
        binding_id: 'proj-second',
        display_name: 'Second Onboarded Project',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-b-second' },
        ide_endpoints: [{
          endpoint_id: 'ide-second-1',
          endpoint_revision: 1,
          conversation_id: 'conv-i-second',
          workspace_identity: '/ws/second',
          repository_identity: 'github.com/org/second'
        }],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    // 3. 后台轮询获取到包含 2 个项目的最新规范投影
    const apiRes = await fetch(`${baseUrl}/api/projects`);
    const { projects } = await apiRes.json();
    assert.equal(projects.length, 2);

    // 4. 客户端消费投影：拓扑前置校验捕获到 DOM 缺少 proj-second
    let reloadTriggered = false;
    const result = applyProjectionToDom(doc, projects, null, {
      onStructuralMismatch: () => {
        reloadTriggered = true;
      }
    });

    // 必须拒绝增量假同步，触发重载通知
    assert.equal(result.success, false);
    assert.equal(result.reloaded, true);
    assert.equal(result.reason, 'topology_mismatch');
    assert.equal(reloadTriggered, true, '动态拓扑变化时必须触发重载回调');

    // 模拟客户端脚本中的 stale 状态设置（绝不显示实时已同步）
    setSurfaceStaleStatus(doc, { isStale: true, reason: '检测到项目或端点结构拓扑变更，正在自动重新加载...' });
    const indicator = doc.getElementById('surface-sync-indicator');
    assert.ok(indicator.classList.contains('sync-stale'));
    assert.match(indicator.textContent, /保持陈旧|同步断开/);
    assert.equal(indicator.classList.contains('sync-live'), false, '结构失配时绝不得显示实时已同步');

    // 5. 模拟重载完成：浏览器重新加载最新 HTML
    const reloadedHtml = await (await fetch(`${baseUrl}/`)).text();
    const reloadedDom = new JSDOM(reloadedHtml, { runScripts: 'outside-only' });
    const reloadedDoc = reloadedDom.window.document;
    assert.equal(reloadedDoc.querySelectorAll('.project-card').length, 2, '重载后 DOM 具备完整的 2 个项目卡片');

    // 6. 重载后新轮询周期：拓扑再次匹配，平滑应用且显示实时已同步
    let subsequentReloadTriggered = false;
    const reloadedResult = applyProjectionToDom(reloadedDoc, projects, null, {
      onStructuralMismatch: () => {
        subsequentReloadTriggered = true;
      }
    });
    assert.equal(reloadedResult.success, true);
    assert.equal(reloadedResult.reloaded, false);
    assert.equal(subsequentReloadTriggered, false);

    setSurfaceStaleStatus(reloadedDoc, { isStale: false, lastSyncTime: new Date().toISOString() });
    const reloadedIndicator = reloadedDoc.getElementById('surface-sync-indicator');
    assert.ok(reloadedIndicator.classList.contains('sync-live'));
    assert.match(reloadedIndicator.textContent, /实时已同步/);
  });
});


