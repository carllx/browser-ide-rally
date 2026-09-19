/**
 * Attention Tray 渲染模块 (Attention Tray Rendering Template)
 *
 * 领域不变式与规范准则 (#20):
 * 1. 忠实渲染 Attention Tray 派生条目，不引入第二套状态存储；
 * 2. 区分呈现 Human Intervention、Endpoint NEW 以及 Action 异常注意力条目；
 * 3. 清楚暴露 exact project binding_id 与 exact target endpoint，防止跨项目/跨端点串台；
 * 4. 严禁渲染任何 Baton、Turn Owner 或 Next Actor 提示；
 * 5. 表现层操作（如折叠/筛选）纯在客户端本地处理，绝不修改规范事实。
 */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderAttentionBadge(classification) {
  switch (classification) {
    case 'HUMAN_INTERVENTION_REQUIRED':
      return `<span class="badge badge-human">HUMAN INTERVENTION</span>`;
    case 'ENDPOINT_NEW_RESULT':
      return `<span class="badge badge-new">NEW RESULT</span>`;
    case 'TARGET_AMBIGUITY':
      return `<span class="badge badge-unknown" style="background: rgba(210, 153, 34, 0.25); color: #e3b341;">TARGET AMBIGUITY</span>`;
    case 'REBIND_BLOCKED_UNHANDLED':
      return `<span class="badge badge-stage stage-BLOCKED">REBIND BLOCKED (UNHANDLED)</span>`;
    case 'ACTION_BLOCKED':
      return `<span class="badge badge-stage stage-BLOCKED">ACTION BLOCKED</span>`;
    case 'ACTION_FAILED':
      return `<span class="badge badge-stage stage-FAILED">ACTION FAILED</span>`;
    case 'ACTION_UNKNOWN':
      return `<span class="badge badge-stage stage-UNKNOWN">ACTION UNKNOWN</span>`;
    default:
      return `<span class="badge badge-other">${escapeHtml(classification)}</span>`;
  }
}

function renderTrayItem(item) {
  const bindingId = item.binding_id;
  const classificationBadge = renderAttentionBadge(item.attention_classification);

  let detailsHtml = '';
  if (item.source_kind === 'HUMAN_INTERVENTION') {
    detailsHtml = `
      <div class="tray-item-detail">
        <span class="meta-label">决策需求:</span> <strong>${escapeHtml(item.reason || '人工核验介入')}</strong>
      </div>
      <div class="tray-item-actions">
        <button
          type="button"
          class="btn btn-control btn-clear-human"
          data-action="clear-human-intervention"
          data-binding-id="${escapeHtml(bindingId)}"
          data-binding-revision="${escapeHtml(item.binding_revision)}"
          title="解决并清除人工介入标记">
          清除介入 (Clear)
        </button>
      </div>
    `;
  } else if (item.source_kind === 'ENDPOINT') {
    const isBrowser = item.role === 'browser';
    const endpointLabel = isBrowser ? 'Browser' : `IDE [${escapeHtml(item.target_endpoint)}]`;
    const cursorInfo = item.cursor ? `游标: <code>${escapeHtml(item.cursor)}</code>` : '';
    const convInfo = item.conversation_id ? `会话: <code>${escapeHtml(item.conversation_id)}</code>` : '';
    const refInfo = item.result_ref ? `引用: <code>${escapeHtml(item.result_ref)}</code>` : '';

    detailsHtml = `
      <div class="tray-item-detail">
        <span class="meta-label">来源端点:</span> <strong>${endpointLabel}</strong>
        ${cursorInfo ? `<span style="margin-left: 8px;">${cursorInfo}</span>` : ''}
        ${convInfo ? `<span style="margin-left: 8px;">${convInfo}</span>` : ''}
        ${refInfo ? `<span style="margin-left: 8px;">${refInfo}</span>` : ''}
      </div>
      <div class="tray-item-actions">
        <a href="#card-${escapeHtml(bindingId)}" class="btn btn-control btn-jump" title="定位到项目卡片">
          定位项目卡片 &rarr;
        </a>
      </div>
    `;
  } else if (item.source_kind === 'ACTION') {
    const targetInfo = item.target_endpoint ? `目标: <code>${escapeHtml(item.target_endpoint)}</code>` : '';
    const evidenceInfo = item.evidence ? `凭据/原因: <em>${escapeHtml(item.evidence)}</em>` : '';

    detailsHtml = `
      <div class="tray-item-detail">
        <span class="meta-label">动作 ID:</span> <code>${escapeHtml(item.action_id)}</code>
        <span class="meta-label" style="margin-left: 8px;">类型:</span> <span>${escapeHtml(item.action_type)}</span>
        ${targetInfo ? `<span style="margin-left: 8px;">${targetInfo}</span>` : ''}
        ${evidenceInfo ? `<div style="margin-top: 4px;">${evidenceInfo}</div>` : ''}
      </div>
      <div class="tray-item-actions">
        <a href="#card-${escapeHtml(bindingId)}" class="btn btn-control btn-jump" title="查看项目详情">
          查看项目 &rarr;
        </a>
      </div>
    `;
  }

  return `
    <li class="tray-item source-${escapeHtml(item.source_kind.toLowerCase())}" data-item-id="${escapeHtml(item.item_id)}">
      <div class="tray-item-header">
        <div class="tray-item-title-group">
          <span class="tray-project-title"><code>${escapeHtml(bindingId)}</code></span>
          <span class="badge badge-rev">rev ${escapeHtml(item.binding_revision)}</span>
          ${classificationBadge}
        </div>
        <span class="meta-time">${escapeHtml(item.updated_at || item.created_at || item.completed_at || '')}</span>
      </div>
      <div class="tray-item-body">
        ${detailsHtml}
      </div>
    </li>
  `;
}

/**
 * 渲染 Attention Tray 组件 HTML
 * @param {object} tray - deriveAttentionTray(...) 派生的结构
 * @returns {string} HTML 片段
 */
export function renderAttentionTrayHtml(tray) {
  if (!tray || !Array.isArray(tray.items)) {
    return '';
  }

  const items = tray.items;
  const count = tray.total_count || 0;
  const counts = tray.counts_by_kind || {};

  if (count === 0) {
    if (tray.has_unknown_endpoints || (tray.unknown_endpoint_count && tray.unknown_endpoint_count > 0)) {
      return `
      <section class="attention-tray-container" aria-label="Attention Tray (存在未知端点状态)">
        <header class="tray-header">
          <div class="tray-title-group">
            <h2 class="tray-title">Attention Tray</h2>
            <span class="badge badge-unknown">端点状态未知 (UNKNOWN)</span>
          </div>
        </header>
        <div class="tray-empty text-warning" style="color: #e3b341;">
          No Attention Tray items; endpoint state remains UNKNOWN — inspect project cards.
        </div>
      </section>
    `;
    }

    return `
      <section class="attention-tray-container" aria-label="Attention Tray (无需关注)">
        <header class="tray-header">
          <div class="tray-title-group">
            <h2 class="tray-title">Attention Tray</h2>
            <span class="badge badge-caught-up">全部就绪 (All Caught Up)</span>
          </div>
        </header>
        <div class="tray-empty text-muted">
          当前跨项目无待关注的 NEW 结果、待决的人工介入或受阻/异常动作。
        </div>
      </section>
    `;
  }

  const itemsHtml = items.map(renderTrayItem).join('\n');

  return `
    <section class="attention-tray-container" aria-label="Attention Tray (${count} 项待关注)">
      <header class="tray-header">
        <div class="tray-title-group">
          <h2 class="tray-title">Attention Tray</h2>
          <span class="badge badge-attention-count">${count} 项待关注</span>
          ${counts.HUMAN_INTERVENTION ? `<span class="badge badge-human">${counts.HUMAN_INTERVENTION} 人工介入</span>` : ''}
          ${counts.ENDPOINT ? `<span class="badge badge-new">${counts.ENDPOINT} 端点结果</span>` : ''}
          ${counts.ACTION ? `<span class="badge badge-stage stage-BLOCKED">${counts.ACTION} 动作异常</span>` : ''}
        </div>
        <div class="tray-controls">
          <button type="button" class="btn btn-secondary btn-tray-toggle" data-action="toggle-tray-expand" aria-expanded="true">
            折叠 / 展开托盘
          </button>
        </div>
      </header>
      <div class="tray-content">
        <ul class="tray-item-list">
          ${itemsHtml}
        </ul>
      </div>
    </section>
  `;
}
