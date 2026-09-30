/**
 * 状态表面 HTML 模板渲染模块 (Surface Template)
 *
 * 领域不变式与规范准则 (#26):
 * 1. 忠实呈现 Status Core 快照投影，不引入第二套可写状态；
 * 2. 默认首屏为 project-first 紧凑 Operator Surface，消除 routine NEW/NO_NEW_RESULT 等大文本；
 * 3. 语法: Project Identity + Browser + IDE + Latest Result Indicator (红点 ●) + 紧凑当前关注点；
 * 4. 侧级 IDE_LATEST 绝不向任意具体 IDE 端点打红点；
 * 5. UNCERTAIN 醒目可辨，绝无偏向打点，不倾倒原始诊断；
 * 6. 原始 IDs、游标、时间戳与 Action 历史置于 Details/Diagnostics 渐进披露；
 * 7. 诚实的相对观察时间（“观察于 X 分钟前”），精确 ISO 时间留存属性/详情；
 * 8. 不支持的能力在控件中隐藏或禁用 (disabled)；
 * 9. 移除首屏霸占的独立 Attention Tray，将其移至全局诊断折叠区；
 * 10. 表现层状态纯粹在本地客户端 DOM 流转，严禁向后端发起任何规范状态变更。
 */

import { SURFACE_CSS } from './surface-styles.js';
import { OPERATOR_CSS } from './operator-styles.js';
import { ATTENTION_TRAY_CSS } from './attention-styles.js';
import { SURFACE_CLIENT_JS } from './surface-client.js';
import { ATTENTION_CLIENT_JS } from './attention-client.js';
import { renderAttentionTrayHtml } from './attention-template.js';
import { renderAddProjectButtonHtml, renderAddProjectModalHtml } from './onboarding-template.js';
import { ONBOARDING_CLIENT_JS } from './onboarding-client.js';
import { LIVE_REFRESH_CLIENT_JS } from './live-refresh-client.js';
import { renderProjectScanRow, renderProjectDetails, escapeHtml } from './operator-template.js';

function renderProjectCard(proj) {
  const bindingId = proj.binding_id;
  const scanRowHtml = renderProjectScanRow(proj);
  const detailsHtml = renderProjectDetails(proj);

  return `
    <article class="project-card" data-binding-id="${escapeHtml(bindingId)}" id="card-${escapeHtml(bindingId)}">
      ${scanRowHtml}
      ${detailsHtml}
    </article>
  `;
}

export function renderStatusSurfaceHtml({ projects = [], attentionTray = null } = {}) {
  const projectCards = projects.map(p => renderProjectCard(p)).join('\n');
  const trayHtml = attentionTray ? renderAttentionTrayHtml(attentionTray) : '';

  // 统计指标：面向操作者的紧凑汇总，与扫描行可见即时操作信号严格一致 (当前关注 != 历史失败)
  const projectCount = projects.length;
  let attentionCount = 0;
  for (const p of projects) {
    const hasHuman = Boolean(p.human_intervention?.active);
    const hasUncertain = p.latest_result_indicator === 'UNCERTAIN';
    const hasUntrusted = [p.browser, ...(p.ide_endpoints || [])].some(e => e && e.continuity?.trusted === false);
    if (hasHuman || hasUncertain || hasUntrusted) {
      attentionCount++;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rally — 项目状态</title>
  <style>
    ${SURFACE_CSS}
    ${OPERATOR_CSS}
    ${ATTENTION_TRAY_CSS}
  </style>
</head>
<body>
  <header class="app-header">
    <div class="app-title-group">
      <h1>Rally</h1>
      <div class="app-subtitle">多项目协同看板</div>
    </div>
    <div class="header-right-group" style="display: flex; align-items: center; gap: 14px;">
      <div class="status-summary-bar">
        <span>项目总数: <strong>${projectCount}</strong></span>
        <span>需关注: <strong style="color: ${attentionCount > 0 ? '#e3b341' : '#3fb950'};">${attentionCount}</strong></span>
      </div>
      <div id="surface-sync-indicator" class="sync-indicator sync-live" title="与服务端保持实时同步">
        ● 实时已同步
      </div>
    </div>
  </header>

  <nav class="filter-bar" aria-label="项目操作栏" style="display: flex; justify-content: space-between; align-items: center;">
    <div class="filter-group">
      <span class="meta-label">筛选展示:</span>
      <button type="button" class="filter-btn active" data-filter="all">全部 (${projectCount})</button>
      <button type="button" class="filter-btn" data-filter="attention">需关注 (${attentionCount})</button>
    </div>
    <div class="action-group">
      ${renderAddProjectButtonHtml()}
    </div>
  </nav>

  <main class="surface-container">
    <section class="projects-operator-plane" aria-label="项目列表">
      ${projectCards || '<div class="text-muted" style="padding: 40px; text-align: center;">当前无已注册项目</div>'}
    </section>

    <!-- 全局诊断与 Attention Tray 折叠抽屉 (不占据默认扫描首屏) -->
    ${trayHtml ? `
      <details class="diagnostics-global-tray">
        <summary class="diagnostics-tray-toggle">全局 Attention Tray 诊断视图 (${attentionTray?.total_count || 0} 项)</summary>
        <div class="diagnostics-tray-body">
          ${trayHtml}
        </div>
      </details>
    ` : ''}
  </main>

  <div id="toast-msg"></div>

  <div id="control-modal" class="modal-overlay" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3 id="modal-title">操作</h3>
        <button type="button" class="btn-close" id="modal-close">&times;</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
        <button type="button" class="btn btn-primary" id="modal-submit">确认</button>
      </div>
    </div>
  </div>

  ${renderAddProjectModalHtml()}

  <script>${SURFACE_CLIENT_JS}</script>
  <script>${ATTENTION_CLIENT_JS}</script>
  <script>${ONBOARDING_CLIENT_JS}</script>
  <script>${LIVE_REFRESH_CLIENT_JS}</script>
</body>
</html>
`;
}
