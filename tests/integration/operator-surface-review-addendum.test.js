/**
 * Operator Surface Review Addendum (#43) Regression Tests
 * 针对 Browser Review Comment #5945106549 与 #5945126754 的曝光门禁专项回归测试：
 * 1. closed/default project card: summary 不再显示 raw binding_id 与 binding_revision；
 * 2. open diagnostics: 展开后 raw binding_id 与 binding_revision 完整保留；
 * 3. Add Project / onboarding: 默认使用人类任务语言，核验后 preview 默认仅显示已确认结果，raw IDs/paths 收入折叠详情；
 * 4. global diagnostics: summary 彻底消除 Attention Tray 内部术语；
 * 5. Browser open: transient 状态文案为人性化的“正在打开...”，消除 Focus/聚焦工程术语。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { SURFACE_CLIENT_JS } from '../../src/surface/surface-client.js';
import { ONBOARDING_CLIENT_JS } from '../../src/surface/onboarding-client.js';

describe('Operator Surface Review Addendum (#43) Regressions', () => {
  let serverHandle;
  let baseUrl;
  let registry;

  before(async () => {
    registry = createProjectRegistry();

    // 注册项目
    registry.registerProject({
      binding: {
        binding_id: 'proj-addendum-001',
        display_name: 'Addendum Alpha',
        binding_revision: 3,
        browser: {
          provider: 'chatgpt',
          conversation_id: 'conv-browser-addendum',
          branch: 'main'
        },
        ide_endpoints: [
          {
            endpoint_id: 'ide-addendum-01',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-addendum',
            workspace_identity: '/ws/addendum',
            repository_identity: 'carllx/browser-ide-rally'
          }
        ],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    serverHandle = await startStatusSurfaceServer({
      registry,
      port: 0,
      host: '127.0.0.1'
    });
    baseUrl = `http://127.0.0.1:${serverHandle.port}`;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('1. [Review 5945106549] closed/default project card summary 绝不包含 raw binding ID 与 revision', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const card = doc.getElementById('card-proj-addendum-001');
    assert.ok(card, '必须找到项目卡片');

    const details = card.querySelector('.project-details');
    assert.ok(details, '必须存在 details 元素');
    assert.equal(details.open, false, 'details 默认必须是折叠的 (closed)');

    const summary = details.querySelector('.details-summary-header');
    assert.ok(summary, '必须存在 summary 元素');

    // 验证 summary 仅包含普通用户可理解的入口文案
    assert.equal(summary.textContent.trim(), '详情 / 诊断');
    assert.equal(summary.textContent.includes('proj-addendum-001'), false, 'closed summary 绝不包含 binding_id');
    assert.equal(summary.textContent.includes('rev 3'), false, 'closed summary 绝不包含 binding_revision');

    // 验证默认扫描行也绝对不包含 raw binding ID 或 revision
    const scanRow = card.querySelector('.project-scan-row');
    assert.equal(scanRow.textContent.includes('proj-addendum-001'), false, 'scan-row 绝不显示 binding_id');
    assert.equal(scanRow.textContent.includes('rev 3'), false, 'scan-row 绝不显示 binding_revision');
  });

  it('2. [Review 5945106549] 展开 Diagnostics 后，raw binding ID 与 revision 作为内部证据完整呈现', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const card = doc.getElementById('card-proj-addendum-001');
    const details = card.querySelector('.project-details');

    // 模拟用户主动展开
    details.open = true;

    const diagHeader = details.querySelector('.project-diagnostics-header');
    assert.ok(diagHeader, '展开后必须存在诊断头部信息栏');

    const bindingIdEl = diagHeader.querySelector('.project-binding-id');
    assert.ok(bindingIdEl, '必须存在 binding_id 代码元素');
    assert.equal(bindingIdEl.textContent.trim(), 'proj-addendum-001');

    const revBadge = diagHeader.querySelector('.badge-rev');
    assert.ok(revBadge, '必须存在版本徽章');
    assert.equal(revBadge.textContent.trim(), 'rev 3');
  });

  it('3. [Review 5945126754] Add Project 表单使用人类任务语言，消除工程术语', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const btnAdd = doc.getElementById('btn-open-add-project');
    assert.ok(btnAdd);
    assert.equal(btnAdd.textContent.trim(), '+ 添加项目');
    assert.equal(btnAdd.title, '添加项目');

    const modalTitle = doc.getElementById('onboarding-modal-title');
    assert.equal(modalTitle.textContent.trim(), '添加项目');

    const form = doc.getElementById('onboarding-form');
    assert.ok(form);
    assert.match(form.textContent, /1\.\s*项目名称/);
    assert.match(form.textContent, /2\.\s*ChatGPT 对话网址/);
    assert.match(form.textContent, /3\.\s*Antigravity 会话标识/);

    assert.equal(form.textContent.includes('Project Display Name'), false);
    assert.equal(form.textContent.includes('Add Project'), false);

    const btnVerify = doc.getElementById('btn-onboarding-verify');
    assert.equal(btnVerify.textContent.trim(), '检查');

    const btnCreate = doc.getElementById('btn-onboarding-create');
    assert.equal(btnCreate.textContent.trim(), '创建项目');

    const btnBack = doc.getElementById('btn-onboarding-back');
    assert.equal(btnBack.textContent.trim(), '返回修改');
  });

  it('4. [Review 5945126754] Add Project 核验后默认 preview 仅展示人类结果，raw IDs/paths 收入折叠详情', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    dom.window.eval(ONBOARDING_CLIENT_JS);
    const doc = dom.window.document;

    // 模拟服务端 verify 响应
    dom.window.fetch = async (url) => {
      if (url === '/api/onboarding/verify') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            preview: {
              display_name: '新测试项目',
              browser: {
                conversation_id: 'conv-browser-secret-uuid',
                tab_url: 'https://chatgpt.com/c/conv-browser-secret-uuid'
              },
              ide: {
                conversation_id: 'conv-ide-secret-uuid',
                workspace_identity: '/Users/test/workspace/secret',
                repository_identity: 'github.com/secret/repo'
              }
            }
          })
        };
      }
      return { ok: false };
    };

    doc.getElementById('input-display-name').value = '新测试项目';
    doc.getElementById('input-browser-url').value = 'https://chatgpt.com/c/conv-browser-secret-uuid';
    doc.getElementById('input-ide-conv-id').value = 'conv-ide-secret-uuid';

    const btnVerify = doc.getElementById('btn-onboarding-verify');
    btnVerify.click();
    await new Promise(resolve => setTimeout(resolve, 20));

    const previewEl = doc.getElementById('onboarding-preview');
    assert.equal(previewEl.style.display, 'block', '核验通过后 preview 应显示');

    // 默认可见预览网格
    const previewGrid = previewEl.querySelector('.preview-grid');
    assert.ok(previewGrid);
    assert.match(previewGrid.textContent, /✓\s*ChatGPT 对话已确认/);
    assert.match(previewGrid.textContent, /✓\s*IDE 对话已确认/);

    // 默认可见网格绝不泄漏 raw IDs / paths
    assert.equal(previewGrid.textContent.includes('conv-browser-secret-uuid'), false);
    assert.equal(previewGrid.textContent.includes('conv-ide-secret-uuid'), false);
    assert.equal(previewGrid.textContent.includes('/Users/test/workspace/secret'), false);
    assert.equal(previewGrid.textContent.includes('github.com/secret/repo'), false);

    // 验证这些技术细节被保存在折叠的详情区域中
    const details = previewEl.querySelector('details.preview-diagnostics');
    assert.ok(details, '必须存在折叠的技术详情');
    assert.equal(details.open, false, '技术详情默认处于折叠状态');

    const debugBody = details.querySelector('.preview-diagnostics-body');
    assert.ok(debugBody);
    assert.match(debugBody.textContent, /conv-browser-secret-uuid/);
    assert.match(debugBody.textContent, /conv-ide-secret-uuid/);
    assert.match(debugBody.textContent, /\/Users\/test\/workspace\/secret/);
    assert.match(debugBody.textContent, /github\.com\/secret\/repo/);
  });

  it('5. [Review 5945126754] 全局诊断 summary 彻底消除 Attention Tray 术语', async () => {
    // 构造有人工核验需求的项目产生全局待处理项
    registry.registerProject({
      binding: {
        binding_id: 'proj-attention-demo',
        display_name: 'Attention Demo',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-att-b' },
        ide_endpoints: [{
          endpoint_id: 'ide-att',
          endpoint_revision: 1,
          conversation_id: 'conv-att-i',
          workspace_identity: '/ws/att',
          repository_identity: 'repo/att'
        }],
        capabilities: ['read'],
        paused: false
      }
    });
    const coreAtt = registry.getProject('proj-attention-demo');
    coreAtt.setHumanIntervention({ active: true, reason: '需核验' });

    const resp = await fetch(baseUrl);
    const html = await resp.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const trayToggle = doc.querySelector('.diagnostics-tray-toggle');
    assert.ok(trayToggle, '必须存在全局诊断开关 summary');
    assert.equal(trayToggle.textContent.includes('Attention Tray'), false, '全局诊断 summary 绝不得包含 Attention Tray 术语');
    assert.match(trayToggle.textContent, /全局诊断/);
  });

  it('6. [Review 5945126754] Browser 打开对话 transient wording 为“正在打开...”，消除 Focus/聚焦', async () => {
    const resp = await fetch(baseUrl);
    const html = await resp.text();
    const dom = new JSDOM(html, { runScripts: 'dangerously' });

    let capturedTextDuringFetch = null;
    dom.window.fetch = async () => {
      const openBtn = dom.window.document.querySelector('.endpoint-browser button[data-action="open-focus"]');
      capturedTextDuringFetch = openBtn.textContent;
      return { ok: true, json: async () => ({ success: true }) };
    };

    dom.window.eval(SURFACE_CLIENT_JS);
    const doc = dom.window.document;

    const openBtn = doc.querySelector('.endpoint-browser button[data-action="open-focus"]');
    assert.ok(openBtn);
    openBtn.click();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(capturedTextDuringFetch, '正在打开...', '临时文案必须为“正在打开...”');
    assert.equal(capturedTextDuringFetch.includes('聚焦'), false, '临时文案绝不包含“聚焦”');
    assert.equal(capturedTextDuringFetch.includes('Focus'), false, '临时文案绝不包含“Focus”');
  });
});
