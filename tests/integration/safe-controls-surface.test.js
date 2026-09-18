/**
 * 状态表面安全控制集成测试 (Safe Controls Surface Integration Tests)
 * 验证 Issue #18 规范：
 * 1. bind/rebind, open/focus, safe send 均受 expected_binding_revision 守卫保护；
 * 2. 任何 revision mismatch 或端点校验失败，必须 Fail-Closed 为 BLOCKED 且无目标副作用；
 * 3. Safe Send 支持 <RALLY_HANDOFF> 严格信封，拒绝泛化 bound_ide；
 * 4. Action 事实独立演进，生命周期 stages 正确流转且跨持久化存在；
 * 5. Blocked controls 绝不影响只读表面投影和端点 NEW / UNKNOWN 状态渲染。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

describe('Safe Controls Surface 集成测试', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let mockBrowserAdapter;
  let mockIdeAdapters;
  let ideCalls;

  const bindingAlpha = {
    binding_id: 'proj-alpha',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-browser-1', branch: 'feat/alpha' },
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

    // 初始化为 NEW 状态
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

    mockBrowserAdapter = {
      focusCalls: [],
      sendCalls: [],
      focusConversationTab(convId) {
        this.focusCalls.push(convId);
        return { focused: true, windowIndex: 1, tabIndex: 2 };
      },
      checkComposerPreflight(convId) {
        return { ready: true };
      },
      sendTextPrompt(convId, text) {
        this.sendCalls.push({ convId, text });
        return { accepted: true, textLength: text.length };
      }
    };

    ideCalls = [];
    mockIdeAdapters = new Map([
      ['ide-a', {
        verifyTargetIdentity(expected) {
          return { verified: true };
        },
        focusWindow() {
          return { focused: true, ide: 'ide-a' };
        },
        dispatchControlledTask(task) {
          ideCalls.push({ ide: 'ide-a', task });
          return { accepted: true, taskId: 'task-001' };
        }
      }],
      ['ide-b', {
        verifyTargetIdentity(expected) {
          return { verified: true };
        },
        focusWindow() {
          return { focused: true, ide: 'ide-b' };
        },
        dispatchControlledTask(task) {
          ideCalls.push({ ide: 'ide-b', task });
          return { accepted: true, taskId: 'task-002' };
        }
      }]
    ]);

    serverHandle = await startStatusSurfaceServer({
      registry,
      browserAdapter: mockBrowserAdapter,
      ideAdapters: mockIdeAdapters,
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

  it('1. GET / 渲染包含安全控制按钮与模态框', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /data-action="open-focus"/);
    assert.match(html, /data-action="rebind"/);
    assert.match(html, /data-action="safe-send"/);
    assert.match(html, /id="control-modal"/);
  });

  it('2. POST /controls/open-focus 成功聚焦 Browser 端点并记录 TARGET_COMPLETED Action', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/open-focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        target_endpoint: 'browser'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.stage, 'TARGET_COMPLETED');
    assert.equal(mockBrowserAdapter.focusCalls.length, 1);
    assert.equal(mockBrowserAdapter.focusCalls[0], 'conv-browser-1');

    // 检查 GET /api/projects 中已存在该 Action 事实
    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    const actions = pData.projects[0].actions;
    const act = actions.find(a => a.action_id === data.action_id);
    assert.ok(act);
    assert.equal(act.stage, 'TARGET_COMPLETED');
    assert.equal(act.action_type, 'open_focus');
  });

  it('3. POST /controls/open-focus 版本失配时返回 409 BLOCKED 且绝不调用适配器', async () => {
    const prevCalls = mockBrowserAdapter.focusCalls.length;
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/open-focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 999, // 错误版本
        target_endpoint: 'browser'
      })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'BLOCKED');
    assert.match(data.reason, /STALE_OR_MISSING_BINDING_REVISION|Binding revision mismatch/i);
    assert.equal(mockBrowserAdapter.focusCalls.length, prevCalls); // 无副作用
  });

  it('4. POST /controls/rebind 未处理 NEW 事实默认拒绝为 409 BLOCKED', async () => {
    // browser 端点目前有未处理 NEW (cursor-browser-1)
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        target_endpoint: 'browser',
        new_identity: {
          conversation_id: 'conv-browser-2',
          branch: 'feat/beta'
        },
        allow_replace_unhandled: false
      })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'BLOCKED');
    assert.match(data.reason, /unhandled NEW/);
  });

  it('5. POST /controls/rebind 显式 allow_replace_unhandled 成功递增 revision 并作用于 Action 记录', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        target_endpoint: 'browser',
        new_identity: {
          conversation_id: 'conv-browser-2',
          branch: 'feat/beta'
        },
        allow_replace_unhandled: true
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.stage, 'TARGET_COMPLETED');
    assert.equal(data.new_binding_revision, 2);

    // 验证当前项目版本已变为 2
    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    assert.equal(pData.projects[0].binding_revision, 2);
    assert.equal(pData.projects[0].browser.conversation_id, 'conv-browser-2');
    assert.equal(pData.projects[0].browser.branch, 'feat/beta');
  });

  it('6. POST /controls/send 成功格式化受控 Envelope 并在目标适配器上派发 (与客户端 JSON 结构一致)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 2,
        target_endpoint: 'browser',
        envelope: {
          op: 'rally.prompt',
          payload: { text: 'Hello from Surface Client exact JSON' }
        }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    // 本地提交成功严格停留在 SUBMITTED_LOCALLY
    assert.equal(data.stage, 'SUBMITTED_LOCALLY');
    assert.ok(data.nonce);
    assert.equal(mockBrowserAdapter.sendCalls.length, 1);
    const lastSend = mockBrowserAdapter.sendCalls[0];
    assert.equal(lastSend.convId, 'conv-browser-2');
    assert.match(lastSend.text, /<RALLY_HANDOFF/);
    assert.match(lastSend.text, /"binding_revision":\s*2/);
    assert.match(lastSend.text, /Hello from Surface Client exact JSON/);
  });

  it('7. POST /controls/send 严禁通用 bound_ide，必须按 exact endpoint_id 寻址', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 2,
        target_endpoint: 'bound_ide', // 禁止泛化
        envelope: {
          op: 'rally.prompt',
          payload: { text: 'Generic IDE dispatch' }
        }
      })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'BLOCKED');
    assert.match(data.reason, /generic.*prohibited|not found/i);
  });

  it('8. POST /controls/send 发送给 IDE 端点 ide-a 精确派发且不干扰 ide-b', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 2,
        target_endpoint: 'ide-a',
        envelope: {
          op: 'rally.prompt',
          payload: { text: 'Task for IDE-A' }
        }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.stage, 'SUBMITTED_LOCALLY');
    assert.equal(ideCalls.length, 1);
    assert.equal(ideCalls[0].ide, 'ide-a');
    assert.equal(ideCalls[0].task.envelope.payload.text, 'Task for IDE-A');
  });

  it('9. Blocked controls 绝不影响状态表面只读端点展示与 Mark handled 控件', async () => {
    // 制造一个 BLOCKED 的控制请求
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1, // 过期版本，导致 BLOCKED
        target_endpoint: 'ide-a',
        envelope: {
          op: 'rally.prompt',
          body: 'Outdated call'
        }
      })
    });
    assert.equal(res.status, 409);

    // 检查 GET / HTML 页面依然完好展示，且 Actions 列表中存在该 BLOCKED 事实
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();

    assert.match(html, /stage-BLOCKED/);
    assert.match(html, /STALE_OR_MISSING_BINDING_REVISION|Binding revision mismatch/i);
    // 只读端点依然正常展示
    assert.match(html, /IDE 端点 \[ide-a\]/);
    assert.match(html, /IDE 端点 \[ide-b\]/);
  });

  it('10. IDE Rebind: 目标端点处于 NEW 时无确认拦截为 409 BLOCKED', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 2,
        target_endpoint: 'ide-a',
        new_identity: {
          conversation_id: 'conv-ide-a-rebind-unconf',
          workspace_identity: '/ws/repo',
          repository_identity: 'github.com/org/repo'
        },
        allow_replace_unhandled: false
      })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'BLOCKED');
    assert.match(data.reason, /unhandled NEW/);
  });

  it('11. IDE Rebind: 目标端点处于 NEW 时显式 NEW 确认 (allow_replace_unhandled) 成功更新规范字段', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 2,
        target_endpoint: 'ide-a',
        new_identity: {
          conversation_id: 'conv-ide-a-rebound',
          workspace_identity: '/ws/repo-new',
          repository_identity: 'github.com/org/repo-new'
        },
        allow_replace_unhandled: true
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.stage, 'TARGET_COMPLETED');
    assert.equal(data.new_binding_revision, 3);

    // 验证快照中规范 IDE 字段与 endpoint_revision 递增
    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    const epA = pData.projects[0].ide_endpoints.find(e => e.endpoint_id === 'ide-a');
    assert.ok(epA);
    assert.equal(epA.conversation_id, 'conv-ide-a-rebound');
    assert.equal(epA.workspace_identity, '/ws/repo-new');
    assert.equal(epA.repository_identity, 'github.com/org/repo-new');
    assert.equal(epA.endpoint_revision, 2);
  });

  it('12. IDE Rebind: 目标端点处于 UNKNOWN 时无确认拦截为 409 BLOCKED', async () => {
    // ide-b 目前处于初始 UNKNOWN 状态
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 3,
        target_endpoint: 'ide-b',
        new_identity: {
          conversation_id: 'conv-ide-b-rebind-unconf',
          workspace_identity: '/ws/repo',
          repository_identity: 'github.com/org/repo'
        },
        allow_replace_unknown: false,
        allow_replace_unhandled: false
      })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'BLOCKED');
    assert.match(data.reason, /UNKNOWN/);
  });

  it('13. IDE Rebind: 目标端点处于 UNKNOWN 时仅勾选 allow_replace_unknown 独立授权成功', async () => {
    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 3,
        target_endpoint: 'ide-b',
        new_identity: {
          conversation_id: 'conv-ide-b-rebound',
          workspace_identity: '/ws/repo-b',
          repository_identity: 'github.com/org/repo-b'
        },
        allow_replace_unknown: true,
        allow_replace_unhandled: false
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.stage, 'TARGET_COMPLETED');
    assert.equal(data.new_binding_revision, 4);

    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    const epB = pData.projects[0].ide_endpoints.find(e => e.endpoint_id === 'ide-b');
    assert.ok(epB);
    assert.equal(epB.conversation_id, 'conv-ide-b-rebound');
    assert.equal(epB.workspace_identity, '/ws/repo-b');
    assert.equal(epB.repository_identity, 'github.com/org/repo-b');
  });

  it('14. Focus 失败 (显式失败结果)：HTTP 响应与 Action 事实一致为 FAILED 且无二次流转', async () => {
    // 注入一个返回显式失败的 mock adapter
    mockIdeAdapters.set('ide-a', {
      verifyTargetIdentity: () => ({ verified: true }),
      focusWindow: () => ({ focused: false, reason: 'Target IDE display disconnected' })
    });

    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/open-focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 4,
        target_endpoint: 'ide-a'
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'FAILED');
    assert.match(data.reason, /Target IDE display disconnected/);

    // 检查项目底层的 Action 事实，确认严格记录且仅记录一次 FAILED 终态
    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    const actions = pData.projects[0].actions;
    const lastAction = actions[actions.length - 1];
    assert.equal(lastAction.stage, 'FAILED');
    assert.match(lastAction.evidence, /Target IDE display disconnected/);
  });

  it('15. Focus 失败 (执行器抛错)：HTTP 响应与 Action 事实一致为 FAILED 且无二次流转', async () => {
    mockIdeAdapters.set('ide-a', {
      verifyTargetIdentity: () => ({ verified: true }),
      focusWindow: () => {
        throw new Error('OS window activation exception');
      }
    });

    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/open-focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 4,
        target_endpoint: 'ide-a'
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'FAILED');
    assert.match(data.reason, /OS window activation exception/);

    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    const actions = pData.projects[0].actions;
    const lastAction = actions[actions.length - 1];
    assert.equal(lastAction.stage, 'FAILED');
    assert.match(lastAction.evidence, /OS window activation exception/);
  });

  it('16. Production IDE Focus: 发现 Provider 会话聚焦能力不可用时返回 409 BLOCKED 且 Action 严格为 BLOCKED', async () => {
    mockIdeAdapters.set('ide-a', {
      verifyTargetIdentity: () => ({ verified: true }),
      focusWindow: () => {
        throw new Error('FOCUS_NOT_AVAILABLE: provider-side exact IDE conversation focus is not available at the existing seam');
      }
    });

    const res = await fetch(`${baseUrl}/api/projects/proj-alpha/controls/open-focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 4,
        target_endpoint: 'ide-a'
      })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.stage, 'BLOCKED');
    assert.match(data.reason, /FOCUS_NOT_AVAILABLE/);
    assert.match(data.reason, /provider-side exact IDE conversation focus is not available at the existing seam/);

    const pRes = await fetch(`${baseUrl}/api/projects`);
    const pData = await pRes.json();
    const actions = pData.projects[0].actions;
    const lastAction = actions[actions.length - 1];
    assert.equal(lastAction.stage, 'BLOCKED');
    assert.match(lastAction.evidence, /provider-side exact IDE conversation focus is not available at the existing seam/);
  });
});
