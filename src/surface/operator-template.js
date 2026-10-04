/**
 * Operator 紧凑项目行与渐进式披露模板模块 (Operator Compact Template)
 *
 * 领域不变式与规范准则 (#26):
 * 1. 默认扫描视图首屏紧凑 (project-first compact scan view)，消除 routine NEW/NO_NEW_RESULT 等大文本；
 * 2. 语法: Project Identity + Browser + IDE + Latest Result Indicator (红点 ●) + 紧凑当前关注点；
 * 3. 红点严格从 latest_result_indicator / ordering_evidence 派生，不创建可写状态；
 * 4. 侧级 IDE_LATEST 绝不向任意具体 IDE 端点打红点；
 * 5. UNCERTAIN 醒目可辨，绝无偏向打点，不倾倒原始诊断；
 * 6. 原始 IDs、版本号、游标、时间戳与 Action 历史置于 Details/Diagnostics 渐进披露；
 * 7. 诚实的相对观察时间（“观察于 X 分钟前”），精确 ISO 时间留存属性/详情；
 * 8. 不支持的能力在控件中隐藏或禁用 (disabled)。
 */

import { formatHonestObservationTime } from './time-format.js';
import { renderEndpointDiagnosticCard, renderActionsTable, escapeHtml } from './operator-diagnostics.js';

export { escapeHtml };

/**
 * 辅助生成一致的红点 HTML 片段
 * @param {string} title - 悬浮提示文本
 * @returns {string} HTML 片段
 */
function renderLatestDot(title) {
  return `<span class="latest-dot" title="${escapeHtml(title)}">●</span>`;
}

/**
 * 渲染紧凑的项目首屏扫描行 (Project Scan Row)
 */
export function renderProjectScanRow(proj) {
  const bindingId = proj.binding_id;
  const bRev = proj.binding_revision;
  const isPaused = proj.paused;
  const displayName = proj.display_name || bindingId;
  const isCustomName = Boolean(proj.display_name && proj.display_name !== bindingId);

  // 1. 防混淆微型标签
  let disambiguationTags = '';
  if (proj.disambiguation?.shared_repo_with_other_projects) {
    disambiguationTags += `<span class="tag tag-anti-confusion" title="与其他项目共用代码仓库">跨项目同名仓库</span>`;
  }
  if (proj.disambiguation?.has_shared_ide_workspace) {
    disambiguationTags += `<span class="tag tag-anti-confusion" title="项目内 IDE 共用工作区">内部共用工作区</span>`;
  }

  // 2. 状态指示器推导
  const indicator = proj.latest_result_indicator || 'NONE';
  const orderingEvidence = proj.ordering_evidence || null;
  const latestEndpoint = orderingEvidence?.latest_endpoint || null;

  // Browser 标签及红点
  const isBrowserLatest = indicator === 'BROWSER_LATEST' && (!latestEndpoint || latestEndpoint === 'browser' || proj.browser?.is_latest_result);
  const browserDot = isBrowserLatest ? renderLatestDot('最新完成结果: Browser') : '';
  const browserTag = `<span class="endpoint-tag endpoint-tag-browser ${isBrowserLatest ? 'has-latest' : ''}">Browser${browserDot ? ' ' + browserDot : ''}</span>`;

  // IDE 标签及红点
  const ideSlots = proj.ide_endpoints || [];
  let ideTagsHtml = '';

  if (ideSlots.length <= 1) {
    const singleIde = ideSlots[0] || proj.ide || { endpoint_id: 'ide' };
    const isIdeLatest = indicator === 'IDE_LATEST' && (singleIde.is_latest_result || latestEndpoint === singleIde.endpoint_id || !latestEndpoint);
    const ideDot = isIdeLatest ? renderLatestDot('最新完成结果: IDE') : '';
    ideTagsHtml = `<span class="endpoint-tag endpoint-tag-ide ${isIdeLatest ? 'has-latest' : ''}" data-endpoint-id="${escapeHtml(singleIde.endpoint_id)}">IDE${ideDot ? ' ' + ideDot : ''}</span>`;
  } else {
    // 多 IDE 端点情况
    const isSideLevelIdeLatest = indicator === 'IDE_LATEST' && (!latestEndpoint || !ideSlots.some(e => e.endpoint_id === latestEndpoint));
    const sideDot = isSideLevelIdeLatest ? renderLatestDot('最新完成结果: IDE (侧级)') : '';

    const ideGroupHeader = `<span class="ide-group-indicator"><span class="endpoint-tag endpoint-tag-ide-group ${isSideLevelIdeLatest ? 'has-latest' : ''}">IDE${sideDot ? ' ' + sideDot : ''}</span></span>`;

    const subSlotsHtml = ideSlots.map((ide, idx) => {
      // 侧级最新时绝不向子端点打红点
      const isThisSlotLatest = !isSideLevelIdeLatest && indicator === 'IDE_LATEST' && (ide.is_latest_result || latestEndpoint === ide.endpoint_id);
      const humanLabel = ide.display_name || ide.alias || `IDE ${idx + 1}`;
      const slotDot = isThisSlotLatest ? renderLatestDot(`最新完成结果: ${humanLabel}`) : '';
      return `<span class="endpoint-tag endpoint-tag-ide ${isThisSlotLatest ? 'has-latest' : ''}" data-endpoint-id="${escapeHtml(ide.endpoint_id)}">${escapeHtml(humanLabel)}${slotDot ? ' ' + slotDot : ''}</span>`;
    }).join(' ');

    ideTagsHtml = `${ideGroupHeader} <span class="ide-sub-slots">(${subSlotsHtml})</span>`;
  }

  // 排序未定指示器 (以人类后果语言呈现，消除字面量 UNCERTAIN 与技术表达)
  let uncertainHtml = '';
  if (indicator === 'UNCERTAIN') {
    uncertainHtml = `<span class="indicator-uncertain" title="两端完成时间相近或未确立明确先后，暂时无法判断哪边更新得更晚">暂时无法判断哪边更新得更晚</span>`;
  }

  // 3. 诚实相对观察时间：仅依赖端点 observation/completion 时间戳，绝不以 project updated_at 冒充
  const browserTime = proj.browser?.completed_at;
  const ideTimes = ideSlots.map(e => e.completed_at).filter(Boolean);
  const candidateTimes = [browserTime, ...ideTimes].filter(Boolean).sort().reverse();
  const mostRecentObservationTime = candidateTimes[0] || null;
  const { text: relTimeText, iso: relTimeIso } = formatHonestObservationTime(mostRecentObservationTime);

  // 4. 当前项目本地 Actionable Attention
  let localAttentionHtml = '';
  if (proj.human_intervention?.active) {
    localAttentionHtml += `
      <span class="scan-attention-tag attention-human" role="alert">
        <span class="badge badge-human">需要人工核验</span>
        <span>${escapeHtml(proj.human_intervention.reason || '人工核验介入')}</span>
        <button
          type="button"
          class="btn btn-control btn-clear-human btn-xs"
          data-action="clear-human-intervention"
          data-binding-id="${escapeHtml(bindingId)}"
          data-binding-revision="${escapeHtml(bRev)}"
          title="解决并清除人工介入">
          清除
        </button>
      </span>
    `;
  }

  // 检查是否有未受信 (continuity lost) 端点：默认行只显示固定紧凑提示，绝不倾倒原始 reason
  const untrustedSlot = [proj.browser, ...ideSlots].find(e => e && e.continuity?.trusted === false);
  if (untrustedSlot && !proj.human_intervention?.active) {
    localAttentionHtml += `
      <span class="scan-attention-tag attention-unknown" title="状态不确定 / 需检查 (详情见诊断)">
        ⚠️ 状态不确定 / 需检查
      </span>
    `;
  }

  // 5. 扫描行渲染 (不泄露版本号、具体游标及 canonical binding_id)
  return `
    <div class="project-scan-row">
      <div class="scan-cell-identity">
        <h2 class="scan-display-name">${escapeHtml(displayName)}</h2>
        ${isPaused ? '<span class="badge badge-paused">已暂停</span>' : ''}
        ${disambiguationTags}
      </div>

      <div class="scan-cell-endpoints">
        ${browserTag}
        ${ideTagsHtml}
        ${uncertainHtml}
      </div>

      <div class="scan-cell-time">
        <time class="relative-time" ${relTimeIso ? `datetime="${escapeHtml(relTimeIso)}" title="最新观察时间: ${escapeHtml(relTimeIso)}"` : ''}>${escapeHtml(relTimeText)}</time>
      </div>

      <div class="scan-cell-attention">
        ${localAttentionHtml}
      </div>

      <div class="scan-cell-controls">
        <button type="button" class="btn btn-secondary btn-details-toggle" data-action="toggle-project-details" aria-expanded="false">
          详情 / 诊断 ▾
        </button>
      </div>
    </div>
    <!-- /project-scan-row -->
  `;
}

/**
 * 渲染渐进式披露的 Details/Diagnostics 区块
 */
export function renderProjectDetails(proj) {
  const bindingId = proj.binding_id;
  const bRev = proj.binding_revision;
  const capabilities = proj.capabilities || ['read', 'write'];
  const projectContext = { bindingId, bindingRevision: bRev, capabilities };

  const browserDiagHtml = renderEndpointDiagnosticCard(proj.browser, projectContext);
  const ideDiagsHtml = (proj.ide_endpoints || []).map(ide => renderEndpointDiagnosticCard(ide, projectContext)).join('');

  return `
    <details class="project-details" id="details-${escapeHtml(bindingId)}">
      <summary class="details-summary-header">
        <span>详情 / 诊断</span>
      </summary>
      <div class="project-details-body">
        <div class="project-diagnostics-header" style="margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
          <span class="text-muted" style="font-size: 0.85rem;">内部标识:</span>
          <code class="project-binding-id" style="font-size: 0.82rem; color: #8b949e;">${escapeHtml(bindingId)}</code>
          <span class="badge badge-rev">rev ${escapeHtml(bRev)}</span>
        </div>
        <section class="endpoints-diagnostic-plane" aria-label="端点详细诊断">
          <div class="endpoints-grid">
            ${browserDiagHtml}
            ${ideDiagsHtml}
          </div>
        </section>

        <section class="details-section human-intervention-plane">
          <div class="section-title"><strong>人工决策控制</strong></div>
          <div style="display: flex; gap: 12px; align-items: center; margin-top: 8px;">
            <button
              type="button"
              class="btn btn-control btn-assert-human"
              data-action="assert-human-intervention"
              data-binding-id="${escapeHtml(bindingId)}"
              data-binding-revision="${escapeHtml(bRev)}"
              title="显式声明该项目需要人工决策介入">
              声明介入 (Assert)
            </button>
            <span class="text-muted" style="font-size: 0.82rem;">若需暂停自动化流转或进行关键决策，可声明人工介入。</span>
          </div>
        </section>

        <section class="details-section actions-history-plane">
          <div class="section-title"><strong>Action 动作事实记录 (${(proj.actions || []).length})</strong></div>
          <div style="margin-top: 8px;">
            ${renderActionsTable(proj.actions)}
          </div>
        </section>

        <section class="details-section project-lifecycle-plane">
          <div class="section-title"><strong>项目操作</strong></div>
          <div style="display: flex; gap: 12px; align-items: center; margin-top: 8px;">
            <button
              type="button"
              class="btn btn-secondary btn-remove-project"
              data-action="remove-project"
              data-binding-id="${escapeHtml(bindingId)}"
              data-binding-revision="${escapeHtml(bRev)}"
              title="只从 Rally 项目列表中移出，不会删除对话或代码仓库">
              移出项目
            </button>
            <span class="text-muted" style="font-size: 0.82rem;">只从 Rally 项目列表中移出，不会删除对话或代码仓库。</span>
          </div>
        </section>
      </div>
    </details>
  `;
}
