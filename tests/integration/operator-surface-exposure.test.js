/**
 * Issue #43 User Exposure Necessity Gate Operator Surface 集成测试
 * 
 * 验证 Issue #43 规范与 Browser Mission Contract 5913105814:
 * 1. 默认扫描视图消除内部 IDs、revisions、action stages 与状态机字面量 (NEW, UNKNOWN, NO_NEW_RESULT)；
 * 2. 排序未定使用人类后果语言（“暂时无法确定最新结果顺序”），消除字面量 UNCERTAIN；
 * 3. 普通 Browser 切换对话模态框仅要求 ChatGPT URL/ID，隐藏 endpoint_id、revision 与 branch 字段；
 * 4. 普通 IDE 切换对话模态框仅要求目标会话 ID，隐藏 endpoint_id 与工作区/代码仓库技术大文本；
 * 5. 切换会话失败时技术细节收起在 <details> 标签中按需查看；
 * 6. 控制表面隐藏 Phase-2 原型传输控件 (Send / Continue / Envelope / Allowlisted Op)；
 * 7. 移除不支持的 IDE Focus 按钮，仅在支持实际打开的 Browser 端点渲染“打开对话”；
 * 8. 工程术语重命名为“切换对话”与“已查看”，且“已查看”仅在端点可处理时呈现（无 disabled 死控件）；
 * 9. Details / Diagnostics 内部完整保留所有底层规范技术事实。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { SURFACE_CLIENT_JS } from '../../src/surface/surface-client.js';

describe('Issue #43 Operator Surface Exposure Gate 集成测试', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let coreUncertain;
  let coreActive;

  before(async () => {
    registry = createProjectRegistry();

    // 1. 构造一个包含 UNCERTAIN 排序状态的项目
    coreUncertain = registry.registerProject({
      binding: {
        binding_id: 'proj-uncertain-exposure',
        display_name: 'Uncertain Project',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-unc-browser' },
        ide_endpoints: [{
          endpoint_id: 'ide-main',
          endpoint_revision: 1,
          conversation_id: 'conv-unc-ide',
          workspace_identity: '/ws/unc',
          repository_identity: 'github.com/org/unc'
        }],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    // 建立基准游标
    coreUncertain.recordEndpointObservation('browser', {
      conversation_id: 'conv-unc-browser',
      trusted: true,
      latest_completed_cursor: 'b_init',
      live_witnessed: true
    });
    coreUncertain.recordEndpointObservation('ide-main', {
      endpoint_id: 'ide-main',
      conversation_id: 'conv-unc-ide',
      trusted: true,
      latest_completed_cursor: 'i_init'
    });

    // 模拟 gap 双端推进并对账，产生 UNCERTAIN 裁决
    coreUncertain.recordEndpointObservation('browser', {
      conversation_id: 'conv-unc-browser',
      trusted: true,
      latest_completed_cursor: 'b_advanced'
    });
    coreUncertain.recordEndpointObservation('ide-main', {
      endpoint_id: 'ide-main',
      conversation_id: 'conv-unc-ide',
      trusted: true,
      latest_completed_cursor: 'i_advanced'
    });
    coreUncertain.reconcileProjectOrdering();

    // 2. 构造一个端点均受信正常、有新结果的项目
    coreActive = registry.registerProject({
      binding: {
        binding_id: 'proj-active-exposure',
        display_name: 'Active Project',
        binding_revision: 2,
        browser: { provider: 'chatgpt', conversation_id: 'conv-act-browser', branch: 'feat/exp' },
        ide_endpoints: [{
          endpoint_id: 'ide-worker',
          endpoint_revision: 2,
          conversation_id: 'conv-act-ide',
          workspace_identity: '/ws/active',
          repository_identity: 'github.com/org/active'
        }],
        capabilities: ['rally.echo', 'read'],
        paused: false
      }
    });

    coreActive.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-b-act',
      provider: 'chatgpt',
      conversation_id: 'conv-act-browser',
      endpoint_revision: 2,
      completed_at: new Date(Date.now() - 60000).toISOString()
    });

    serverHandle = await startStatusSurfaceServer({
      registry,
      port: 0,
      host: '127.0.0.1'
    });
    baseUrl = `http://127.0.0.1:${serverHandle.port}`;
  });

  after(async () => {
    if (serverHandle?.close) {
      await serverHandle.close();
    }
  });

  it('1. 默认扫描视图不暴露内部 ID、revisions、action stages 与状态机字面量', async () => {
    const resp = await fetch(baseUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();

    const dom = new JSDOM(html);
    const scanRows = dom.window.document.querySelectorAll('.project-scan-row');
    assert.ok(scanRows.length >= 2, '必须渲染至少两个项目的扫描行');

    for (const row of scanRows) {
      const text = row.textContent;
      // 扫描行中不得暴露 canonical 状态机状态字面量
      assert.equal(text.includes('NO_NEW_RESULT'), false, '扫描行不暴露 NO_NEW_RESULT');
      assert.equal(text.includes('UNKNOWN'), false, '扫描行不暴露 UNKNOWN');
      // 扫描行不得暴露内部端点 revision、action stage
      assert.equal(text.includes('rev 1'), false, '扫描行不暴露 rev 1');
      assert.equal(text.includes('rev 2'), false, '扫描行不暴露 rev 2');
      assert.equal(text.includes('ACCEPTED_OR_DELIVERED'), false, '扫描行不暴露 action stage');
      assert.equal(text.includes('cur-b-'), false, '扫描行不暴露游标 ID');
    }
  });

  it('2. 排序未定 (Uncertain Ordering) 使用人类后果语言，消除字面量 UNCERTAIN', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html);
    const uncCard = dom.window.document.getElementById('card-proj-uncertain-exposure');
    assert.ok(uncCard, '必须存在 uncertain 项目卡片');

    const uncScanRow = uncCard.querySelector('.project-scan-row');
    assert.ok(uncScanRow);

    // 验证包含人类后果语言：“暂时无法确定最新结果顺序”与“排序未定”
    const uncIndicator = uncScanRow.querySelector('.indicator-uncertain');
    assert.ok(uncIndicator, '必须渲染排序未定指示器元素');
    assert.match(uncIndicator.textContent, /排序未定/);
    assert.match(uncIndicator.title, /暂时无法确定最新结果顺序/);
    // 验证扫描行完全消除了字面量 "(UNCERTAIN)"
    assert.equal(uncScanRow.textContent.includes('UNCERTAIN'), false, '扫描行绝不出现 UNCERTAIN 字面量');
  });

  it('3. 普通 Browser 切换对话模态框仅要求 ChatGPT URL/ID，无 endpoint/revision/branch 字段', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    dom.window.eval(SURFACE_CLIENT_JS);

    const doc = dom.window.document;
    const actCard = doc.getElementById('card-proj-active-exposure');
    const browserRebindBtn = actCard.querySelector('.endpoint-browser button[data-action="rebind"]');
    assert.ok(browserRebindBtn, 'Browser 端点卡片必须有切换对话按钮');

    // 触发点击切换对话
    browserRebindBtn.click();

    const modalTitle = doc.getElementById('modal-title');
    assert.equal(modalTitle.textContent, '切换 Browser 对话');

    const modalBody = doc.getElementById('modal-body');
    // 验证存在 ChatGPT URL 或会话 ID 输入框 (m-conv-id)
    const convInput = doc.getElementById('m-conv-id');
    assert.ok(convInput, '必须存在会话输入框');
    assert.match(modalBody.textContent, /ChatGPT 对话网址/);

    // 验证移除了目标端点只读框与 revision
    assert.equal(modalBody.textContent.includes('目标端点:'), false, '模态框不展示目标端点只读技术字段');
    assert.equal(modalBody.textContent.includes('rev 2'), false, '模态框不展示 revision');
    // 验证移除了普通 Browser 分支输入框
    assert.equal(doc.getElementById('m-rebind-branch'), null, '普通 Browser 切换模态框绝不暴露分支输入框');

    // 验证提交按钮为人性化文案“确认切换”
    const submitBtn = doc.getElementById('modal-submit');
    assert.equal(submitBtn.textContent, '确认切换');
  });

  it('4. 普通 IDE 切换对话模态框仅要求目标会话 ID，无 endpoint/revision 与工作区大段技术说明', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    dom.window.eval(SURFACE_CLIENT_JS);

    const doc = dom.window.document;
    const actCard = doc.getElementById('card-proj-active-exposure');
    const ideRebindBtn = actCard.querySelector('.endpoint-ide button[data-action="rebind"]');
    assert.ok(ideRebindBtn, 'IDE 端点卡片必须有切换对话按钮');

    // 触发点击 IDE 切换对话
    ideRebindBtn.click();

    const modalTitle = doc.getElementById('modal-title');
    assert.equal(modalTitle.textContent, '切换 IDE 对话');

    const modalBody = doc.getElementById('modal-body');
    const convInput = doc.getElementById('m-conv-id');
    assert.ok(convInput, '必须存在目标会话 ID 输入框');

    // 验证移除了目标端点只读框
    assert.equal(modalBody.textContent.includes('目标端点:'), false, '模态框不展示目标端点技术字段');
    // 验证移除了大段工作区/代码仓库说明
    assert.equal(modalBody.textContent.includes('保持当前工作区与代码仓库不变'), false, '模态框不展示工作区冗余技术说明');
  });

  it('5. 切换会话失败时技术细节收起在 <details> 中按需查看', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    // 模拟 fetch 返回 BLOCKED 且带有具体技术细节
    dom.window.fetch = async () => ({
      ok: false,
      json: async () => ({
        success: false,
        stage: 'BLOCKED',
        reason: 'target active in another project: proj-other (endpoint ide-worker conversation conv-clash)'
      })
    });
    dom.window.eval(SURFACE_CLIENT_JS);

    const doc = dom.window.document;
    const actCard = doc.getElementById('card-proj-active-exposure');
    const ideRebindBtn = actCard.querySelector('.endpoint-ide button[data-action="rebind"]');
    ideRebindBtn.click();

    const convInput = doc.getElementById('m-conv-id');
    assert.ok(convInput, '必须获取到输入框');
    convInput.value = 'conv-clash';

    const submitBtn = doc.getElementById('modal-submit');
    submitBtn.click();
    await new Promise(resolve => setTimeout(resolve, 20));

    const alertBox = doc.getElementById('m-error-alert');
    assert.ok(alertBox, '必须渲染错误提示容器');
    assert.equal(alertBox.style.display, 'block');

    // 人类指导文案清晰易懂
    assert.match(alertBox.textContent, /已被其他项目占用/);
    assert.match(alertBox.textContent, /防止跨项目会话串线/);

    // 技术细节收起在 <details> 标签中
    const detailsEl = alertBox.querySelector('details');
    assert.ok(detailsEl, '错误提示必须包含 details 折叠标签');
    const summaryEl = detailsEl.querySelector('summary');
    assert.match(summaryEl.textContent, /查看技术详情 ▾/);
    assert.match(detailsEl.textContent, /target active in another project/);
  });

  it('6. 日常控制表面隐藏 Phase-2 原型传输控件 (Send / Continue / Envelope)', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // 默认控制表面绝无 safe-send、continue 按钮
    assert.equal(doc.querySelector('button[data-action="safe-send"]'), null, '日常控制表面绝不暴露 safe-send 原型按钮');
    assert.equal(doc.querySelector('button[data-action="continue"]'), null, '日常控制表面绝不暴露 continue 原型按钮');

    // 检查卡片内容与控制按钮区域无 Allowlisted Op 或 Envelope 泄露
    const cards = doc.querySelectorAll('.endpoint-card');
    for (const card of cards) {
      assert.equal(card.textContent.includes('Allowlisted Op'), false, '卡片中绝不暴露 Allowlisted Op 字符');
      assert.equal(card.textContent.includes('Safe Send'), false, '卡片中绝不暴露 Safe Send');
    }
  });

  it('7. 移除不支持的 IDE Focus 按钮，仅在支持实际打开的 Browser 端点渲染“打开对话”', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Browser 端点必须有“打开对话”按钮
    const browserCard = doc.querySelector('.endpoint-browser');
    const openFocusBtn = browserCard.querySelector('button[data-action="open-focus"]');
    assert.ok(openFocusBtn, 'Browser 端点卡片必须有打开对话按钮');
    assert.match(openFocusBtn.textContent, /打开对话/);

    // IDE 端点绝不渲染任何 Focus / open-focus 按钮
    const ideCards = doc.querySelectorAll('.endpoint-ide');
    for (const ideCard of ideCards) {
      assert.equal(ideCard.querySelector('button[data-action="open-focus"]'), null, 'IDE 端点绝不得渲染打开/Focus死控件');
    }
  });

  it('8. “已查看”按钮仅在端点处于可处理状态时呈现，不可处理时不渲染任何 disabled 死控件', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // proj-active-exposure 的 Browser 端点有新结果且未被处理，can_mark_handled 为 true
    const activeCard = doc.getElementById('card-proj-active-exposure');
    const browserHandledBtn = activeCard.querySelector('.endpoint-browser button[data-action="mark-handled"]');
    assert.ok(browserHandledBtn, '可处理的 Browser 端点必须渲染已查看按钮');
    assert.match(browserHandledBtn.textContent, /已查看/);
    assert.equal(browserHandledBtn.disabled, false);

    // 将该 Browser 端点标为 handled
    coreActive.markEndpointHandled('browser', { expected_cursor: 'cur-b-act' });

    // 重新请求并验证已无 handled 按钮（绝不保留 disabled 死控件）
    const resp2 = await fetch(baseUrl);
    const html2 = await resp2.text();
    const dom2 = new JSDOM(html2);
    const activeCard2 = dom2.window.document.getElementById('card-proj-active-exposure');
    const handledBtn2 = activeCard2.querySelector('.endpoint-browser button[data-action="mark-handled"]');
    assert.equal(handledBtn2, null, '端点处理完毕后已查看按钮彻底消失，不残留 disabled 死控件');
  });

  it('9. Details / Diagnostics 内部完整保留所有底层规范技术事实', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();

    const dom = new JSDOM(html);
    const details = dom.window.document.querySelector('.project-details');
    assert.ok(details, '必须存在 Details 展开折叠区域');

    const detailsText = details.textContent;
    // 包含技术事实
    assert.match(detailsText, /proj-uncertain-exposure|proj-active-exposure/);
    assert.match(detailsText, /ide-main|ide-worker/);
    assert.match(detailsText, /rev 1|rev 2/);
    assert.match(detailsText, /b_advanced|i_advanced/);
  });
});
