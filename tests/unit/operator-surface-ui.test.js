/**
 * Issue #26 Operator UI 层次与紧凑项目首屏单元测试
 * (Operator Surface UI Unit Tests)
 * 验证 Issue #26 规定的紧凑项目首屏、红点指示器、诚实时间与渐进式披露
 * 包含针对 Browser Review (Comment 5861467012) Blockers 1-5 的全部专项回归测试
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStatusSurfaceHtml } from '../../src/surface/surface-template.js';
import { formatHonestObservationTime } from '../../src/surface/time-format.js';
import { SURFACE_CLIENT_JS } from '../../src/surface/surface-client.js';

describe('Issue #26 Operator Surface UI 紧凑首屏测试', () => {
  // 辅助构造一个基础投影对象
  function makeProjection({
    bindingId = 'proj-alpha',
    displayName = null,
    latestResultIndicator = 'NONE',
    latestEndpoint = null,
    browserState = 'NO_NEW_RESULT',
    browserCursor = 'cur-b-1',
    browserTime = '2026-09-27T14:00:00.000Z',
    browserTrusted = true,
    browserUnknownReason = null,
    ideEndpoints = [
      {
        endpoint_id: 'ide-main',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-1',
        workspace_identity: '/ws/alpha',
        repository_identity: 'github.com/org/alpha',
        result_state: 'NO_NEW_RESULT',
        latest_completed_cursor: 'cur-ide-1',
        last_handled_cursor: 'cur-ide-1',
        completed_at: '2026-09-27T13:50:00.000Z',
        continuity: { trusted: true, unknown_reason: null },
        can_mark_handled: false,
        is_latest_result: false
      }
    ],
    humanIntervention = { active: false, reason: null },
    actions = [],
    capabilities = ['rally.echo']
  } = {}) {
    const isBrowserLatest = latestResultIndicator === 'BROWSER_LATEST' && (!latestEndpoint || latestEndpoint === 'browser');
    const orderingEvidence = latestResultIndicator === 'NONE' ? null : {
      certainty: latestResultIndicator === 'UNCERTAIN' ? 'UNCERTAIN' : 'DEFINITE',
      latest_endpoint: latestEndpoint,
      latest_side: latestResultIndicator === 'BROWSER_LATEST' ? 'browser' : (latestResultIndicator === 'IDE_LATEST' ? 'ide' : null),
      reason: 'test'
    };

    const ides = ideEndpoints.map(ide => ({
      ...ide,
      is_latest_result: Boolean(latestResultIndicator === 'IDE_LATEST' && latestEndpoint === ide.endpoint_id)
    }));

    return {
      binding_id: bindingId,
      display_name: displayName,
      binding_revision: 1,
      paused: false,
      capabilities,
      browser: {
        endpoint_id: 'browser',
        role: 'browser',
        provider: 'chatgpt',
        conversation_id: 'conv-b-1',
        branch: 'feat/test',
        result_state: browserState,
        latest_completed_cursor: browserCursor,
        last_handled_cursor: browserCursor,
        completed_at: browserTime,
        continuity: { trusted: browserTrusted, unknown_reason: browserUnknownReason },
        can_mark_handled: browserState === 'NEW' && browserTrusted,
        is_latest_result: isBrowserLatest
      },
      ide_endpoints: ides,
      ide: ides.length === 1 ? ides[0] : null,
      latest_result_indicator: latestResultIndicator,
      ordering_evidence: orderingEvidence,
      human_intervention: humanIntervention,
      actions,
      disambiguation: {},
      updated_at: '2026-09-27T14:05:00.000Z'
    };
  }

  it('1. 默认扫描视图不暴露 routine NEW、NO_NEW_RESULT 或 新结果/无新结果 文本', () => {
    const proj = makeProjection({
      browserState: 'NEW',
      latestResultIndicator: 'BROWSER_LATEST',
      latestEndpoint: 'browser'
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    // 默认项目卡片/行主扫描区内不得渲染常规的 NEW / NO_NEW_RESULT / 新结果 / 无新结果 徽章或文本
    const scanRowMatch = html.match(/<div class="project-scan-row"[\s\S]*?<\/div>\s*<!-- \/project-scan-row -->/);
    assert.ok(scanRowMatch, '应当包含紧凑的 project-scan-row');
    const scanRowHtml = scanRowMatch[0];

    assert.equal(scanRowHtml.includes('badge-new'), false, '默认扫描行不得渲染 badge-new');
    assert.equal(scanRowHtml.includes('badge-caught-up'), false, '默认扫描行不得渲染 badge-caught-up');
    assert.equal(scanRowHtml.includes('>NEW<'), false, '默认扫描行不得直接暴露 >NEW<');
    assert.equal(scanRowHtml.includes('>NO_NEW_RESULT<'), false, '默认扫描行不得暴露 >NO_NEW_RESULT<');
    assert.equal(scanRowHtml.includes('新结果'), false, '默认扫描行不得出现中文“新结果”');
    assert.equal(scanRowHtml.includes('无新结果'), false, '默认扫描行不得出现中文“无新结果”');
  });

  it('2. [Blocker 1 回归] 默认首屏整页绝不暴露 canonical 状态词与扫描行 binding_id', () => {
    const proj = makeProjection({
      bindingId: 'rally-internal-repo',
      displayName: 'Rally Main Project',
      browserState: 'NEW'
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    // 1. 扫描行突出展示 Display Name
    assert.match(html, /Rally Main Project/);

    // 2. 扫描行不得暴露 canonical binding_id
    const scanRowMatch = html.match(/<div class="project-scan-row"[\s\S]*?<\/div>\s*<!-- \/project-scan-row -->/);
    assert.ok(scanRowMatch);
    assert.equal(scanRowMatch[0].includes('rally-internal-repo'), false, '扫描行不得直接显示 canonical binding_id');

    // 3. canonical binding_id 必须移入 Details/Diagnostics 渐进披露
    const detailsMatch = html.match(/<details class="project-details"[\s\S]*?<\/details>/);
    assert.ok(detailsMatch);
    assert.ok(detailsMatch[0].includes('rally-internal-repo'), 'Details 折叠抽屉中必须保留 canonical binding_id');

    // 4. 整页首屏的汇总与筛选栏绝不得包含 NEW 端点 / UNKNOWN 端点 / 仅含 NEW / 仅含 UNKNOWN
    // 检查 header 与 nav 区域
    const headerNavMatch = html.match(/<header class="app-header"[\s\S]*?<\/nav>/);
    assert.ok(headerNavMatch);
    const headerNavHtml = headerNavMatch[0];
    assert.equal(headerNavHtml.includes('NEW 端点'), false, '首屏汇总不得包含 NEW 端点');
    assert.equal(headerNavHtml.includes('UNKNOWN 端点'), false, '首屏汇总不得包含 UNKNOWN 端点');
    assert.equal(headerNavHtml.includes('仅含 NEW'), false, '筛选器不得包含 仅含 NEW');
    assert.equal(headerNavHtml.includes('仅含 UNKNOWN'), false, '筛选器不得包含 仅含 UNKNOWN');
    // 应呈现面向操作者的筛选器，例如“全部”与“需关注”
    assert.match(headerNavHtml, /data-filter="all"/);
    assert.match(headerNavHtml, /data-filter="attention"/);
  });

  it('3. Latest Result Indicator: Browser Latest 时在 Browser 旁打红点，IDE 不打红点', () => {
    const proj = makeProjection({
      latestResultIndicator: 'BROWSER_LATEST',
      latestEndpoint: 'browser'
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    const browserSlotMatch = html.match(/<span class="[^"]*endpoint-tag-browser[^"]*"[\s\S]*?<\/span>/);
    assert.ok(browserSlotMatch);
    assert.match(browserSlotMatch[0], /latest-dot/);

    const ideSlotMatch = html.match(/<span class="[^"]*endpoint-tag-ide[^"]*"[\s\S]*?<\/span>/);
    assert.ok(ideSlotMatch);
    assert.equal(ideSlotMatch[0].includes('latest-dot'), false);
  });

  it('4. Latest Result Indicator: Exact IDE Latest 时在对应 IDE 端点旁打红点', () => {
    const proj = makeProjection({
      latestResultIndicator: 'IDE_LATEST',
      latestEndpoint: 'ide-worker',
      ideEndpoints: [
        {
          endpoint_id: 'ide-worker',
          result_state: 'NEW',
          continuity: { trusted: true },
          can_mark_handled: true
        },
        {
          endpoint_id: 'ide-idle',
          result_state: 'NO_NEW_RESULT',
          continuity: { trusted: true },
          can_mark_handled: false
        }
      ]
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    assert.match(html, /data-endpoint-id="ide-worker"[^>]*>[\s\S]*?latest-dot/);
    const idleSlot = html.match(/data-endpoint-id="ide-idle"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
    assert.equal(idleSlot.includes('latest-dot'), false);
  });

  it('5. Latest Result Indicator: Side-level IDE Latest 绝不向任意具体 IDE 端点打红点，而是作用于 IDE 组', () => {
    const proj = makeProjection({
      latestResultIndicator: 'IDE_LATEST',
      latestEndpoint: null,
      ideEndpoints: [
        {
          endpoint_id: 'ide-1',
          result_state: 'NEW',
          continuity: { trusted: true }
        },
        {
          endpoint_id: 'ide-2',
          result_state: 'NEW',
          continuity: { trusted: true }
        }
      ]
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    const ep1Match = html.match(/data-endpoint-id="ide-1"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '';
    const ep2Match = html.match(/data-endpoint-id="ide-2"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '';
    assert.equal(ep1Match.includes('latest-dot'), false, 'ide-1 不应独立拥有红点');
    assert.equal(ep2Match.includes('latest-dot'), false, 'ide-2 不应独立拥有红点');

    assert.match(html, /class="[^"]*ide-group-indicator[^"]*"[\s\S]*?latest-dot/);
  });

  it('6. Latest Result Indicator: UNCERTAIN 清晰可见且不给任何一侧打红点', () => {
    const proj = makeProjection({
      latestResultIndicator: 'UNCERTAIN',
      latestEndpoint: null
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    assert.equal(html.includes('class="latest-dot"'), false);
    assert.match(html, /indicator-uncertain/);
    assert.match(html, /暂时无法判断哪边更新得更晚|排序未定|UNCERTAIN/);
  });

  it('7. 原始 ID、游标与 Action 历史移入 Details/Diagnostics 渐进披露', () => {
    const proj = makeProjection({
      bindingId: 'proj-secret-details',
      actions: [
        {
          action_id: 'act-999',
          action_type: 'relay',
          target_endpoint: 'ide-main',
          stage: 'REQUESTED',
          evidence: 'test-evidence'
        }
      ]
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    const scanRowMatch = html.match(/<div class="project-scan-row"[\s\S]*?<\/div>\s*<!-- \/project-scan-row -->/);
    assert.ok(scanRowMatch);
    const scanRowHtml = scanRowMatch[0];
    assert.equal(scanRowHtml.includes('conv-ide-1'), false, '默认扫描行不含原始会话 ID');
    assert.equal(scanRowHtml.includes('cur-ide-1'), false, '默认扫描行不含游标');
    assert.equal(scanRowHtml.includes('act-999'), false, '默认扫描行不含 action_id');

    const detailsMatch = html.match(/<details class="project-details"[\s\S]*?<\/details>/);
    assert.ok(detailsMatch, '应当提供 project-details 渐进披露折叠');
    const detailsHtml = detailsMatch[0];
    assert.ok(detailsHtml.includes('conv-ide-1'));
    assert.ok(detailsHtml.includes('cur-ide-1'));
    assert.ok(detailsHtml.includes('act-999'));
  });

  it('8. 当前 Actionable Attention 在受影响的项目本地紧凑展示，首屏无独立 Attention Tray', () => {
    const proj1 = makeProjection({
      bindingId: 'proj-with-human',
      humanIntervention: { active: true, reason: '数据库迁移确认' }
    });
    const proj2 = makeProjection({
      bindingId: 'proj-normal'
    });

    const html = renderStatusSurfaceHtml({ projects: [proj1, proj2] });

    assert.equal(html.includes('<section class="attention-tray-container"'), false);

    const card1 = html.match(/<article[^>]*id="card-proj-with-human"[\s\S]*?<\/article>/)?.[0] || '';
    assert.match(card1, /数据库迁移确认/);
    assert.match(card1, /btn-clear-human/);

    const card2 = html.match(/<article[^>]*id="card-proj-normal"[\s\S]*?<\/article>/)?.[0] || '';
    assert.equal(card2.includes('btn-clear-human'), false);
  });

  it('9. 诚实相对观察时间：渲染如“观察于 X 分钟前”或“刚刚”，ISO 时间在 title / 详情中', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const proj = makeProjection({
      browserTime: fiveMinutesAgo
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    assert.match(html, /观察于\s*5\s*分钟前|刚刚/);
    assert.ok(html.includes(fiveMinutesAgo));
  });

  it('10. [Blocker 2 回归] 长/provider-shaped unknown_reason 绝不直接倾倒到扫描行，只显示固定紧凑提示', () => {
    const providerLongError = 'provider_session_timeout: connection dropped by remote peer [504 Gateway Timeout at /api/conversation/401] with internal trace ID 98234-abc';
    const proj = makeProjection({
      browserTrusted: false,
      browserUnknownReason: providerLongError
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    const scanRowMatch = html.match(/<div class="project-scan-row"[\s\S]*?<\/div>\s*<!-- \/project-scan-row -->/);
    assert.ok(scanRowMatch);
    const scanRowHtml = scanRowMatch[0];

    // 默认行只呈现固定、紧凑的人类提示
    assert.match(scanRowHtml, /状态不确定|需检查/);
    // 绝不直接倾倒原始错误长字符串
    assert.equal(scanRowHtml.includes(providerLongError), false, '默认扫描行绝不倾倒原始 provider 错误');

    // 原始长错误保留在 Details 诊断中
    const detailsMatch = html.match(/<details class="project-details"[\s\S]*?<\/details>/);
    assert.ok(detailsMatch);
    assert.ok(detailsMatch[0].includes('provider_session_timeout'), 'Details 诊断中应保留完整错误');
  });

  it('11. [Blocker 3 回归] 端点卡片具备稳定 .endpoint-card 类名与 data-endpoint-id 选择器缝隙', () => {
    const proj = makeProjection({
      browserState: 'NEW',
      ideEndpoints: [
        {
          endpoint_id: 'ide-agent-1',
          result_state: 'NEW',
          latest_completed_cursor: 'cur-ide-agent-1',
          result_ref: 'ref-ide-1',
          continuity: { trusted: true }
        }
      ]
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    // 验证诊断卡片同时保留 .endpoint-card 类名和 data-endpoint-id 属性
    const ideCardMatch = html.match(/<div class="[^"]*endpoint-card[^"]*"[^>]*data-endpoint-id="ide-agent-1"[\s\S]*?>/);
    assert.ok(ideCardMatch, 'IDE 端点诊断卡片必须具有 endpoint-card 类名与 data-endpoint-id');
    assert.match(ideCardMatch[0], /data-result-state="NEW"/);
    assert.match(ideCardMatch[0], /data-latest-cursor="cur-ide-agent-1"/);
    assert.match(ideCardMatch[0], /data-result-ref="ref-ide-1"/);

    const browserCardMatch = html.match(/<div class="[^"]*endpoint-card[^"]*"[^>]*data-endpoint-id="browser"[\s\S]*?>/);
    assert.ok(browserCardMatch, 'Browser 端点诊断卡片必须具有 endpoint-card 类名与 data-endpoint-id');
  });

  it('12. [Issue #43 / Blocker 4 回归] 默认控制表面隐藏 Phase-2 原型控件 (Send/Continue)，且可用操作员控件保持启用', () => {
    // 使用权威默认 capability ['rally.echo']
    const proj = makeProjection({
      capabilities: ['rally.echo'],
      browserState: 'NEW',
      browserTrusted: true
    });

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    // 根据 Issue #43 门禁，未完成的 Phase-2 原型控件 (Send / Continue) 不得在日常操作表面渲染
    const sendBtnMatch = html.match(/<button[^>]*data-action="safe-send"[\s\S]*?>/);
    assert.equal(sendBtnMatch, null, '日常控制表面绝不暴露 safe-send 原型控件');

    const continueBtnMatch = html.match(/<button[^>]*data-action="continue"[\s\S]*?>/);
    assert.equal(continueBtnMatch, null, '日常控制表面绝不暴露 continue 原型控件');

    // 真正支持的操作员控件（如“切换对话”与“打开对话”）保持可用，不被虚构 write 禁用
    const rebindBtnMatch = html.match(/<button[^>]*data-action="rebind"[\s\S]*?>/);
    assert.ok(rebindBtnMatch, '日常控制表面应包含切换对话控件');
    assert.equal(rebindBtnMatch[0].includes('disabled'), false, '默认 capability 项目的切换对话按钮不得被禁用');

    const openChatBtnMatch = html.match(/<button[^>]*data-action="open-focus"[\s\S]*?>/);
    assert.ok(openChatBtnMatch, 'Browser 端点应包含打开对话控件');
    assert.equal(openChatBtnMatch[0].includes('disabled'), false, '默认 capability 项目的打开对话按钮不得被禁用');
  });

  it('13. [Blocker 5 回归] 缺少端点 observation 时不得以 project updated_at 冒充观察时间', () => {
    // 构造一个端点完成时间均为空、但项目 updated_at 很新的项目
    const proj = makeProjection({
      browserTime: null,
      ideEndpoints: [
        {
          endpoint_id: 'ide-main',
          completed_at: null,
          result_state: 'UNKNOWN',
          continuity: { trusted: false }
        }
      ]
    });
    // 设置项目 updated_at 为刚刚
    proj.updated_at = new Date().toISOString();

    const html = renderStatusSurfaceHtml({ projects: [proj] });

    const scanRowMatch = html.match(/<div class="project-scan-row"[\s\S]*?<\/div>\s*<!-- \/project-scan-row -->/);
    assert.ok(scanRowMatch);
    const scanRowHtml = scanRowMatch[0];

    // 绝不能显示“刚刚观察到”或“观察于”
    assert.equal(scanRowHtml.includes('刚刚观察到'), false, '端点无完成时间时不得显示刚刚观察到');
    assert.equal(scanRowHtml.includes('观察于'), false, '端点无完成时间时不得显示观察于');
    // 应该显示中立诚实的“暂无可靠观察时间”
    assert.match(scanRowHtml, /暂无可靠观察时间/);
  });

  it('14. [Review 5862085979 Blocker 2 回归] 历史终态失败 Action 绝不永久污染需关注计数与筛选器', () => {
    // 构造一个端点完全受信正常、但历史上存在多个 BLOCKED 或 FAILED Action 的项目
    const projWithHistoricalFailures = makeProjection({
      bindingId: 'proj-with-history-fail',
      displayName: 'Clean Normal Project',
      browserState: 'NO_NEW_RESULT',
      browserTrusted: true
    });
    projWithHistoricalFailures.actions = [
      { action_id: 'act-fail-1', action_type: 'rebind', stage: 'BLOCKED', evidence: 'revision mismatch' },
      { action_id: 'act-fail-2', action_type: 'send', stage: 'FAILED', evidence: 'timeout' }
    ];

    const html = renderStatusSurfaceHtml({ projects: [projWithHistoricalFailures] });

    // 1. 顶部 Header 派生的“需关注”必须为 0，不能被历史 action 终态失败污染
    assert.match(html, /需关注:\s*<strong[^>]*>0<\/strong>/, '仅有历史失败动作时需关注计数必须为 0');

    // 2. 扫描行内无任何 scan-attention-tag
    const cardMatch = html.match(/<article[^>]*id="card-proj-with-history-fail"[\s\S]*?<\/article>/)?.[0] || '';
    assert.equal(cardMatch.includes('scan-attention-tag'), false, '正常项目扫描行无 attention tag');

    // 3. 在客户端 DOM 筛选逻辑下，该卡片在 attention 筛选下不会被呈现
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    dom.window.eval(SURFACE_CLIENT_JS);
    const attentionBtn = dom.window.document.querySelector('.filter-btn[data-filter="attention"]');
    assert.ok(attentionBtn);
    attentionBtn.click();
    const cardEl = dom.window.document.getElementById('card-proj-with-history-fail');
    assert.equal(cardEl.style.display, 'none', '在 attention 筛选模式下历史失败项目必须隐藏');
  });

  it('15. [Review 5862085979 Blocker 3 回归] 严重未来时间戳与非法时间戳不得显示为“刚刚”或原样倾倒', () => {
    const fixedNow = new Date('2026-09-28T12:00:00.000Z').getTime();

    // a. 超过容差的未来时间戳 (未来 2 小时)
    const farFutureIso = new Date('2026-09-28T14:00:00.000Z').toISOString();
    const futureResult = formatHonestObservationTime(farFutureIso, fixedNow);
    assert.equal(futureResult.text.includes('刚刚观察到'), false, '未来时间戳严禁冒充刚刚观察到');
    assert.match(futureResult.text, /观察时间异常\s*\/\s*待核验/);

    // b. 极微小未来时间戳 (未来 10 秒，在 30 秒容差内) -> 正常显示“刚刚观察到”
    const slightFutureIso = new Date('2026-09-28T12:00:10.000Z').toISOString();
    const slightFutureResult = formatHonestObservationTime(slightFutureIso, fixedNow);
    assert.equal(slightFutureResult.text, '刚刚观察到');

    // c. 非法时间戳字符串 (如恶意注入或不可解析的脏字符)
    const invalidIso = '<script>alert("hack")</script>';
    const invalidResult = formatHonestObservationTime(invalidIso, fixedNow);
    assert.equal(invalidResult.text.includes('<script>'), false, '非法字符串绝不原样倾倒');
    assert.equal(invalidResult.text, '观察时间无效');

    // d. 页面级渲染验证：非法时间戳的项目扫描行内显示“观察时间无效”，脏字符串不进入扫描行
    const projWithInvalidTime = makeProjection({
      browserTime: 'not-a-valid-date-string'
    });
    const html = renderStatusSurfaceHtml({ projects: [projWithInvalidTime] });
    const scanRowMatch = html.match(/<div class="project-scan-row"[\s\S]*?<!-- \/project-scan-row -->/);
    assert.ok(scanRowMatch);
    const scanRowHtml = scanRowMatch[0];
    assert.match(scanRowHtml, /观察时间无效/);
    assert.equal(scanRowHtml.includes('not-a-valid-date-string'), false, '扫描行不直接暴露未经验证的脏字符串');
    assert.ok(html.includes('not-a-valid-date-string'), '原始脏字符串仅在 Details 诊断中留存供 Agent 排错');
  });

  it('16. [Review 5862085979 Evidence Gap 回归] Browser-target Continue 客户端逻辑测试：单 IDE 自动绑定与多 IDE 行内选择派发', async () => {
    // 1. 单 IDE -> Browser Continue 行为验证
    const singleIdeProj = makeProjection({
      bindingId: 'proj-single-ide',
      browserState: 'NO_NEW_RESULT',
      ideEndpoints: [
        {
          endpoint_id: 'ide-unique',
          endpoint_revision: 2,
          result_state: 'NEW',
          latest_completed_cursor: 'cur-ide-unique-123',
          result_ref: 'ref-res-unique-456',
          continuity: { trusted: true }
        }
      ]
    });

    const singleHtml = renderStatusSurfaceHtml({ projects: [singleIdeProj] });
    const singleDom = new JSDOM(singleHtml, { runScripts: 'dangerously' });

    let singleFetchCall = null;
    singleDom.window.fetch = async (url, options) => {
      singleFetchCall = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ success: true, stage: 'ACCEPTED_OR_DELIVERED' }) };
    };
    singleDom.window.eval(SURFACE_CLIENT_JS);

    // 找到 Browser 端点诊断卡片并挂载 continue 触发按钮（Issue #43 默认界面隐藏此原型按钮）
    const singleBrowserCard = singleDom.window.document.querySelector('.endpoint-browser');
    assert.ok(singleBrowserCard, '必须存在 Browser 诊断卡片');
    const singleContinueBtn = singleDom.window.document.createElement('button');
    singleContinueBtn.setAttribute('data-action', 'continue');
    singleContinueBtn.setAttribute('data-endpoint-id', 'browser');
    singleContinueBtn.setAttribute('data-target-endpoint', 'browser');
    singleContinueBtn.setAttribute('data-role', 'browser');
    singleContinueBtn.setAttribute('data-binding-id', 'proj-single-ide');
    singleContinueBtn.setAttribute('data-binding-revision', '1');
    singleBrowserCard.querySelector('.endpoint-action-bar').appendChild(singleContinueBtn);

    // 模拟点击 Continue
    singleContinueBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(singleFetchCall, '点击后必须发出 fetch 请求');
    assert.equal(singleFetchCall.url, '/api/projects/proj-single-ide/controls/continue');
    assert.equal(singleFetchCall.body.target_endpoint, 'browser');
    assert.equal(singleFetchCall.body.source_endpoint, 'ide-unique', '单 IDE 场景自动选择唯一的 IDE 端点作为 source');
    assert.equal(singleFetchCall.body.expected_source_result_state, 'NEW');
    assert.equal(singleFetchCall.body.expected_source_cursor, 'cur-ide-unique-123');
    assert.equal(singleFetchCall.body.expected_source_result_ref, 'ref-res-unique-456');

    // 2. 多 IDE -> Browser Continue 行为验证 (行内 picker 显式选择)
    const multiIdeProj = makeProjection({
      bindingId: 'proj-multi-ide',
      browserState: 'NO_NEW_RESULT',
      ideEndpoints: [
        {
          endpoint_id: 'ide-first',
          endpoint_revision: 1,
          result_state: 'NO_NEW_RESULT',
          latest_completed_cursor: 'cur-ide-1',
          result_ref: 'ref-1',
          continuity: { trusted: true }
        },
        {
          endpoint_id: 'ide-second',
          endpoint_revision: 1,
          result_state: 'NEW',
          latest_completed_cursor: 'cur-ide-2-chosen',
          result_ref: 'ref-2-chosen',
          continuity: { trusted: true }
        }
      ]
    });

    const multiHtml = renderStatusSurfaceHtml({ projects: [multiIdeProj] });
    const multiDom = new JSDOM(multiHtml, { runScripts: 'dangerously' });

    let multiFetchCall = null;
    multiDom.window.fetch = async (url, options) => {
      multiFetchCall = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ success: true, stage: 'ACCEPTED_OR_DELIVERED' }) };
    };
    multiDom.window.eval(SURFACE_CLIENT_JS);

    const multiBrowserCard = multiDom.window.document.querySelector('.endpoint-browser');
    const multiContinueBtn = multiDom.window.document.createElement('button');
    multiContinueBtn.setAttribute('data-action', 'continue');
    multiContinueBtn.setAttribute('data-endpoint-id', 'browser');
    multiContinueBtn.setAttribute('data-target-endpoint', 'browser');
    multiContinueBtn.setAttribute('data-role', 'browser');
    multiContinueBtn.setAttribute('data-binding-id', 'proj-multi-ide');
    multiContinueBtn.setAttribute('data-binding-revision', '1');
    multiBrowserCard.querySelector('.endpoint-action-bar').appendChild(multiContinueBtn);

    // 第一次点击：多 IDE 时不应立即发送 fetch，而是展开行内 source picker
    multiContinueBtn.click();
    assert.equal(multiFetchCall, null, '多 IDE 时首次点击不能盲目发送请求');

    const picker = multiContinueBtn.parentElement.querySelector('.inline-source-picker');
    assert.ok(picker, '多 IDE 点击后必须在行内展开 source picker');

    const selectEl = picker.querySelector('.sel-source-id');
    assert.ok(selectEl, 'picker 内必须有 IDE 下拉选项框');
    // 切换选中第二个 IDE
    selectEl.value = 'ide-second';

    // 点击确认按钮
    const confirmBtn = picker.querySelector('.btn-confirm-continue');
    assert.ok(confirmBtn, 'picker 内必须有确认按钮');
    confirmBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(multiFetchCall, '确认后必须发出 fetch 请求');
    assert.equal(multiFetchCall.url, '/api/projects/proj-multi-ide/controls/continue');
    assert.equal(multiFetchCall.body.target_endpoint, 'browser');
    assert.equal(multiFetchCall.body.source_endpoint, 'ide-second', '请求必须准确携带操作者选中的 ide-second');
    assert.equal(multiFetchCall.body.expected_source_result_state, 'NEW');
    assert.equal(multiFetchCall.body.expected_source_cursor, 'cur-ide-2-chosen');
    assert.equal(multiFetchCall.body.expected_source_result_ref, 'ref-2-chosen');
  });
});
