/**
 * Operator 渐进式披露诊断与历史事实渲染模块 (Operator Diagnostics Template)
 *
 * 领域不变式与规范准则 (#26):
 * 1. 深度详细阅读属于 Agent，通过 API / 结构化快照 / 诊断折叠区获取；
 * 2. 原始 IDs、版本号 (binding_revision)、游标、精确时间戳与历史 Action 集中披露；
 * 3. 严格遵循能力防御 (capabilities guard)，不支持的操作禁用或隐藏。
 */

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 渲染单个端点的详细诊断卡片
 * @param {object} ep - 端点投影
 * @param {object} projectContext - 项目上下文 { bindingId, bindingRevision, capabilities }
 * @returns {string} HTML 片段
 */
export function renderEndpointDiagnosticCard(ep, projectContext) {
  const { bindingId, bindingRevision } = projectContext;
  const isBrowser = ep.role === 'browser';
  const headerTitle = isBrowser ? 'Browser 端点' : `IDE 端点 [${escapeHtml(ep.endpoint_id)}]`;
  const epRevBadge = `<span class="ep-rev-badge">rev ${escapeHtml(ep.endpoint_revision || 1)}</span>`;

  const unknownReasonHtml = !ep.continuity?.trusted && ep.continuity?.unknown_reason
    ? `<div><span class="meta-label">未受信原因:</span> <code class="untrusted-reason">${escapeHtml(ep.continuity.unknown_reason)}</code></div>`
    : '';

  const cursorInfo = `
    <div class="endpoint-meta-grid">
      <div><span class="meta-label">最新完成游标:</span> <code>${escapeHtml(ep.latest_completed_cursor ?? '(无)')}</code></div>
      <div><span class="meta-label">已处理游标:</span> <code class="meta-handled-cursor">${escapeHtml(ep.last_handled_cursor ?? '(无)')}</code></div>
      <div><span class="meta-label">完成时间:</span> <code>${escapeHtml(ep.completed_at ?? '(无)')}</code></div>
      <div><span class="meta-label">结果引用:</span> <code>${escapeHtml(ep.result_ref ?? '(无)')}</code></div>
      <div><span class="meta-label">受信状态:</span> <span>${ep.continuity?.trusted ? '受信 (Trusted)' : '未受信 (Untrusted)'}</span></div>
      ${unknownReasonHtml}
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
    <div class="endpoint-diagnostic-card endpoint-card ${isBrowser ? 'endpoint-browser' : 'endpoint-ide'}"
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
        <div class="endpoint-diagnostic-state">
          ${ep.result_state === 'NEW' ? '<span class="badge badge-new" role="status">NEW</span>' : ''}
          ${ep.result_state === 'NO_NEW_RESULT' ? '<span class="badge badge-caught-up" role="status">NO_NEW_RESULT</span>' : ''}
          ${ep.result_state === 'UNKNOWN' ? `<span class="badge badge-unknown" role="status">UNKNOWN${ep.continuity?.unknown_reason ? ` (${escapeHtml(ep.continuity.unknown_reason)})` : ''}</span>` : ''}
          <code>状态: ${escapeHtml(ep.result_state)}${ep.continuity?.unknown_reason ? ` (${escapeHtml(ep.continuity.unknown_reason)})` : ''}</code>
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

/**
 * 渲染 Action 事实表格
 */
export function renderActionsTable(actions = []) {
  if (!actions || actions.length === 0) {
    return `<div class="text-muted" style="font-size: 0.85rem; padding: 6px 0;">无活跃或历史动作事实</div>`;
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
  `;
}
