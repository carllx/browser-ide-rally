/**
 * 状态表面 HTML 模板渲染模块 (Surface Template)
 *
 * 领域不变式与规范准则 (#17):
 * 1. 忠实呈现 Status Core 快照投影，不引入第二套可写状态；
 * 2. 独立呈现 Browser 与所有活跃 IDE 端点（支持 Triple NEW 同时可见）；
 * 3. UNKNOWN 显式警告展示（琥珀色/警告），严禁展示为 IDLE 或已同步；
 * 4. 防串台标识：精确可见 binding_id、会话与分支 ID、工作区及仓库身份，不推断主线或 Baton；
 * 5. 独立平面：Human Intervention 与 Action 事实作为独立卡片/区块呈现；
 * 6. Mark Handled 控件严格绑定 exact project 与 exact endpoint_id，仅在 NEW 且受信时可用；
 * 7. 表现层状态（折叠/展开、筛选等）纯粹在浏览器本地 DOM 流转，严禁向后端发起任何规范状态变更。
 */

import { SURFACE_CSS } from './surface-styles.js';
import { ATTENTION_TRAY_CSS } from './attention-styles.js';
import { SURFACE_CLIENT_JS } from './surface-client.js';
import { renderAttentionTrayHtml } from './attention-template.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderBadge(state, unknownReason = null) {
  const safeState = escapeHtml(state);
  if (state === 'NEW') {
    return `<span class="badge badge-new" role="status" aria-label="新结果">NEW</span>`;
  }
  if (state === 'NO_NEW_RESULT') {
    return `<span class="badge badge-caught-up" role="status" aria-label="无新结果">NO_NEW_RESULT</span>`;
  }
  if (state === 'UNKNOWN') {
    const reasonTip = unknownReason ? ` title="${escapeHtml(unknownReason)}"` : '';
    return `<span class="badge badge-unknown"${reasonTip} role="status" aria-label="未知状态 (非空闲)">UNKNOWN${unknownReason ? ` (${escapeHtml(unknownReason)})` : ''}</span>`;
  }
  return `<span class="badge badge-other">${safeState}</span>`;
}

function renderEndpointCard(ep, bindingId, bindingRevision, roleLabel) {
  const isBrowser = ep.role === 'browser';
  const headerTitle = isBrowser ? 'Browser 端点' : `IDE 端点 [${escapeHtml(ep.endpoint_id)}]`;
  const epRevBadge = `<span class="ep-rev-badge">rev ${escapeHtml(ep.endpoint_revision || 1)}</span>`;

  const cursorInfo = `
    <div class="endpoint-meta-grid">
      <div><span class="meta-label">最新完成游标:</span> <code>${escapeHtml(ep.latest_completed_cursor ?? '(无)')}</code></div>
      <div><span class="meta-label">已处理游标:</span> <code class="meta-handled-cursor">${escapeHtml(ep.last_handled_cursor ?? '(无)')}</code></div>
      <div><span class="meta-label">完成时间:</span> <code>${escapeHtml(ep.completed_at ?? '(无)')}</code></div>
      <div><span class="meta-label">结果引用:</span> <code>${escapeHtml(ep.result_ref ?? '(无)')}</code></div>
      <div><span class="meta-label">受信状态:</span> <span>${ep.continuity?.trusted ? '受信 (Trusted)' : '未受信 (Untrusted)'}</span></div>
    </div>
  `;

  let identityDetails = '';
  if (isBrowser) {
    identityDetails = `
      <div class="identity-line">
        <span class="meta-label">Provider:</span> <code>${escapeHtml(ep.provider || 'chatgpt')}</code>
        <span class="meta-label" style="margin-left: 12px;">会话 ID:</span> <code>${escapeHtml(ep.conversation_id || '(未绑定)')}</code>
        <span class="meta-label" style="margin-left: 12px;">分支:</span> <code>${escapeHtml(ep.branch || '(未指定分支)')}</code>
      </div>
    `;
  } else {
    identityDetails = `
      <div class="identity-line">
        <span class="meta-label">会话 ID:</span> <code>${escapeHtml(ep.conversation_id || '(未绑定)')}</code>
      </div>
      <div class="identity-line">
        <span class="meta-label">工作区:</span> <code class="path-code">${escapeHtml(ep.workspace_identity || '-')}</code>
      </div>
      <div class="identity-line">
        <span class="meta-label">代码仓库:</span> <code class="path-code">${escapeHtml(ep.repository_identity || '-')}</code>
      </div>
    `;
  }

  const handledBtnDisabled = !ep.can_mark_handled;
  const handledBtnTitle = handledBtnDisabled
    ? (ep.result_state !== 'NEW' ? '仅在端点处于 NEW 时可处理' : '端点未受信或缺少有效游标')
    : '将当前完成游标标记为已处理';

  const cursorJsonAttr = ep.latest_completed_cursor !== null && ep.latest_completed_cursor !== undefined
    ? `data-expected-cursor-json="${escapeHtml(encodeURIComponent(JSON.stringify(ep.latest_completed_cursor)))}"`
    : '';

  const controlButtons = `
    <div class="control-btn-group">
      <button
        type="button"
        class="btn btn-control btn-focus"
        data-action="open-focus"
        data-binding-id="${escapeHtml(bindingId)}"
        data-binding-revision="${escapeHtml(bindingRevision)}"
        data-endpoint-id="${escapeHtml(ep.endpoint_id)}"
        title="聚焦/打开此目标端点">
        Focus
      </button>
      <button
        type="button"
        class="btn btn-control btn-rebind"
        data-action="rebind"
        data-binding-id="${escapeHtml(bindingId)}"
        data-binding-revision="${escapeHtml(bindingRevision)}"
        data-endpoint-id="${escapeHtml(ep.endpoint_id)}"
        data-role="${escapeHtml(ep.role)}"
        data-conversation-id="${escapeHtml(ep.conversation_id || '')}"
        data-branch="${escapeHtml(ep.branch || '')}"
        data-workspace="${escapeHtml(ep.workspace_identity || '')}"
        data-repo="${escapeHtml(ep.repository_identity || '')}"
        title="安全重绑此端点 (需匹配版本)">
        Rebind
      </button>
      <button
        type="button"
        class="btn btn-control btn-send"
        data-action="safe-send"
        data-binding-id="${escapeHtml(bindingId)}"
        data-binding-revision="${escapeHtml(bindingRevision)}"
        data-endpoint-id="${escapeHtml(ep.endpoint_id)}"
        title="向此端点发送受控 Envelope">
        Send
      </button>
      <button
        type="button"
        class="btn btn-control btn-continue"
        data-action="continue"
        data-binding-id="${escapeHtml(bindingId)}"
        data-binding-revision="${escapeHtml(bindingRevision)}"
        data-target-endpoint="${escapeHtml(ep.endpoint_id)}"
        data-role="${escapeHtml(ep.role)}"
        title="${isBrowser ? '在 Browser 中一键继续' : `在 IDE [${escapeHtml(ep.endpoint_id)}] 中一键继续`}">
        Continue
      </button>
    </div>
  `;

  const handledButton = `
    <button
      type="button"
      class="btn btn-handled"
      data-action="mark-handled"
      data-binding-id="${escapeHtml(bindingId)}"
      data-endpoint-id="${escapeHtml(ep.endpoint_id)}"
      data-expected-cursor="${escapeHtml(ep.latest_completed_cursor ?? '')}"
      ${cursorJsonAttr}
      title="${handledBtnTitle}"
      ${handledBtnDisabled ? 'disabled' : ''}>
      Mark handled
    </button>
  `;

  return `
    <div class="endpoint-card ${isBrowser ? 'endpoint-browser' : 'endpoint-ide'}"
      data-endpoint-id="${escapeHtml(ep.endpoint_id)}"
      data-role="${escapeHtml(ep.role)}"
      data-result-state="${escapeHtml(ep.result_state)}"
      data-latest-cursor="${escapeHtml(ep.latest_completed_cursor ?? '')}"
      data-result-ref="${escapeHtml(ep.result_ref ?? '')}">
      <div class="endpoint-header">
        <div class="endpoint-title">
          <strong>${headerTitle}</strong>
          ${epRevBadge}
        </div>
        <div>
          ${renderBadge(ep.result_state, ep.continuity?.unknown_reason)}
        </div>
      </div>
      <div class="endpoint-body">
        ${identityDetails}
        ${cursorInfo}
        <div class="endpoint-action-bar">
          ${controlButtons}
          ${handledButton}
        </div>
      </div>
    </div>
  `;
}

function renderHumanInterventionSection(human, bindingId, bindingRevision) {
  if (human?.active) {
    return `
      <div class="plane-section human-intervention-active" role="alert">
        <div class="plane-header">
          <span class="badge badge-human">HUMAN INTERVENTION REQUIRED</span>
          <span class="meta-time">${escapeHtml(human.updated_at || '')}</span>
        </div>
        <div class="plane-body">
          <strong>介入原因：</strong> ${escapeHtml(human.reason || '人工核验中')}
        </div>
        <div class="plane-controls" style="margin-top: 8px;">
          <button
            type="button"
            class="btn btn-control btn-clear-human"
            data-action="clear-human-intervention"
            data-binding-id="${escapeHtml(bindingId)}"
            data-binding-revision="${escapeHtml(bindingRevision)}"
            title="解决并清除人工介入标记">
            清除介入 (Clear)
          </button>
        </div>
      </div>
    `;
  }
  return `
    <div class="plane-section human-intervention-inactive">
      <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
        <div>
          <span class="meta-label">人工介入平面：</span>
          <span class="text-muted">无需介入 (None required)</span>
        </div>
        <div>
          <button
            type="button"
            class="btn btn-control btn-assert-human"
            data-action="assert-human-intervention"
            data-binding-id="${escapeHtml(bindingId)}"
            data-binding-revision="${escapeHtml(bindingRevision)}"
            title="显式声明该项目需要人工决策介入">
            声明介入 (Assert)
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderActionsSection(actions = []) {
  if (!actions || actions.length === 0) {
    return `
      <div class="plane-section actions-plane">
        <span class="meta-label">Action 事实平面：</span>
        <span class="text-muted">无活跃或历史动作</span>
      </div>
    `;
  }

  const rows = actions.map(act => {
    const reasonText = act.reason || (typeof act.evidence === 'string' ? act.evidence : act.evidence?.reason || act.evidence?.error) || '';
    const nonceText = act.nonce ? `<code>${escapeHtml(act.nonce.slice(0, 8))}...</code>` : '-';
    return `
    <tr class="action-row stage-row-${escapeHtml(act.stage)}">
      <td><code>${escapeHtml(act.action_id)}</code></td>
      <td><span>${escapeHtml(act.action_type)}</span></td>
      <td><code>${escapeHtml(act.target_endpoint || '-')}</code></td>
      <td><span class="badge badge-stage stage-${escapeHtml(act.stage)}">${escapeHtml(act.stage)}</span></td>
      <td>${nonceText}</td>
      <td class="action-reason-cell">${reasonText ? `<span class="action-reason">${escapeHtml(reasonText)}</span>` : '<span class="text-muted">-</span>'}</td>
      <td class="text-muted">${escapeHtml(act.updated_at || act.created_at || '-')}</td>
    </tr>
  `;
  }).join('');

  return `
    <div class="plane-section actions-plane">
      <div class="plane-header">
        <strong>Action 动作事实 (${actions.length})</strong>
      </div>
      <div class="table-responsive">
        <table class="actions-table">
          <thead>
            <tr>
              <th>Action ID</th>
              <th>类型</th>
              <th>目标端点</th>
              <th>生命周期 Stage</th>
              <th>Nonce</th>
              <th>附注 / 原因</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderProjectCard(proj) {
  const bindingId = proj.binding_id;
  const bRev = proj.binding_revision;
  const isPaused = proj.paused;

  // 跨项目同仓库/工作区防混淆提示
  let disambiguationTags = '';
  if (proj.disambiguation?.shared_repo_with_other_projects) {
    disambiguationTags += `<span class="tag tag-anti-confusion" title="与其他项目共用代码仓库，请依据 binding_id 及会话精确区分">跨项目同名仓库</span>`;
  }
  if (proj.disambiguation?.has_shared_ide_workspace) {
    disambiguationTags += `<span class="tag tag-anti-confusion" title="项目内 IDE 共用工作区，请依据 endpoint_id 及 conversation_id 精确区分">内部共用工作区</span>`;
  }

  const browserCardHtml = renderEndpointCard(proj.browser, bindingId, bRev, 'Browser');
  const ideCardsHtml = (proj.ide_endpoints || []).map(ide => renderEndpointCard(ide, bindingId, bRev, 'IDE')).join('');

  return `
    <article class="project-card" data-binding-id="${escapeHtml(bindingId)}" id="card-${escapeHtml(bindingId)}">
      <header class="project-header">
        <div class="project-identity">
          <h2 class="project-title">${escapeHtml(bindingId)}</h2>
          <span class="badge badge-rev">rev ${escapeHtml(bRev)}</span>
          ${isPaused ? '<span class="badge badge-paused">PAUSED</span>' : ''}
          ${disambiguationTags}
        </div>
        <div class="project-controls">
          <button type="button" class="btn btn-secondary btn-toggle-expand" data-action="toggle-expand" aria-expanded="true">
            折叠 / 展开
          </button>
        </div>
      </header>

      <div class="project-content">
        <section class="endpoints-plane" aria-label="端点状态平面">
          <div class="endpoints-grid">
            ${browserCardHtml}
            ${ideCardsHtml}
          </div>
        </section>

        ${renderHumanInterventionSection(proj.human_intervention, bindingId, bRev)}
        ${renderActionsSection(proj.actions)}
      </div>
    </article>
  `;
}

export function renderStatusSurfaceHtml({ projects = [], attentionTray = null } = {}) {
  const projectCards = projects.map(p => renderProjectCard(p)).join('\n');
  const trayHtml = attentionTray ? renderAttentionTrayHtml(attentionTray) : '';

  // 统计 summary 指标
  let totalNew = 0;
  let totalUnknown = 0;
  for (const p of projects) {
    if (p.browser?.result_state === 'NEW') totalNew++;
    if (p.browser?.result_state === 'UNKNOWN') totalUnknown++;
    for (const ide of p.ide_endpoints || []) {
      if (ide.result_state === 'NEW') totalNew++;
      if (ide.result_state === 'UNKNOWN') totalUnknown++;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rally — Multi-Project Status Surface</title>
  <style>
    ${SURFACE_CSS}
    ${ATTENTION_TRAY_CSS}
  </style>
</head>
<body>
  <header class="app-header">
    <div class="app-title-group">
      <h1>Rally Status Surface</h1>
      <div class="app-subtitle">多项目端点状态监视表面 (Backed by Status Core)</div>
    </div>
    <div class="status-summary-bar">
      <span>项目总数: <strong>${projects.length}</strong></span>
      <span>NEW 端点: <strong style="color: #3fb950;">${totalNew}</strong></span>
      <span>UNKNOWN 端点: <strong style="color: #d29922;">${totalUnknown}</strong></span>
    </div>
  </header>

  <nav class="filter-bar" aria-label="项目筛选器">
    <span class="meta-label">筛选展示:</span>
    <button type="button" class="filter-btn active" data-filter="all">全部 (${projects.length})</button>
    <button type="button" class="filter-btn" data-filter="new">仅含 NEW</button>
    <button type="button" class="filter-btn" data-filter="unknown">仅含 UNKNOWN</button>
  </nav>

  <main class="surface-container">
    ${trayHtml}
    ${projectCards || '<div class="text-muted" style="padding: 40px; text-align: center;">当前无已注册项目</div>'}
  </main>

  <div id="toast-msg"></div>

  <div id="control-modal" class="modal-overlay" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3 id="modal-title">安全控制操作</h3>
        <button type="button" class="btn-close" id="modal-close">&times;</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="modal-cancel">取消</button>
        <button type="button" class="btn btn-primary" id="modal-submit">确认执行</button>
      </div>
    </div>
  </div>

  <script>${SURFACE_CLIENT_JS}</script>
</body>
</html>
`;
}
