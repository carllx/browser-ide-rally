/**
 * 状态表面只读实时平滑刷新客户端模块 (Live Refresh Client Module)
 *
 * 领域不变式与规范准则 (#34):
 * 1. 唯一真实数据源：纯只读消费 GET /api/projects 投影，绝不建立第二套客户端 truth store；
 * 2. 状态呈现隔离：红点 (●) 严格从 latest_result_indicator / ordering_evidence 派生，移动不改写 Endpoint Result 事实；
 * 3. 故障显式化 (Fail-Visible): 网络断开或服务故障时显式标为陈旧 (stale)，绝不捏造新结果；
 * 4. 交互保护：后台静默刷新时严格保持已展开的详情 (<details open>) 与操作焦点；
 * 5. 侧级 IDE_LATEST 绝不向任意具体 IDE 端点打红点；
 * 6. UNCERTAIN 醒目可辨，绝无偏向打点。
 */

import { checkStructuralTopologyMatches } from './live-refresh-topology.js';

export { checkStructuralTopologyMatches };

/**
 * 客户端诚实相对时间格式化
 * @param {string|null} isoTimestamp
 * @returns {string}
 */
export function formatHonestRelativeTimeClient(isoTimestamp) {
  if (!isoTimestamp) {
    return '暂无观察时间';
  }
  const date = new Date(isoTimestamp);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return '时间无效';
  }
  const diffMs = Date.now() - time;
  if (diffMs < 0) {
    return '刚刚';
  }
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return '刚刚';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `观察于 ${diffMin} 分钟前`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `观察于 ${diffHour} 小时前`;
  }
  const diffDay = Math.floor(diffHour / 24);
  return `观察于 ${diffDay} 天前`;
}

function escapeText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 更新或创建红点元素
 * @param {Element} container
 * @param {boolean} shouldHaveDot
 * @param {string} title
 */
function updateLatestDot(container, shouldHaveDot, title) {
  if (!container) return;
  const existingDot = container.querySelector('.latest-dot');
  if (shouldHaveDot) {
    container.classList.add('has-latest');
    if (!existingDot) {
      const dot = container.ownerDocument.createElement('span');
      dot.className = 'latest-dot';
      dot.title = title;
      dot.textContent = '●';
      container.appendChild(container.ownerDocument.createTextNode(' '));
      container.appendChild(dot);
    } else {
      existingDot.title = title;
    }
  } else {
    container.classList.remove('has-latest');
    if (existingDot) {
      existingDot.remove();
    }
  }
}

/**
 * 更新扫描行 DOM 元素
 * @param {Element} scanRow
 * @param {object} proj
 */
function updateScanRowDom(scanRow, proj) {
  const indicator = proj.latest_result_indicator || 'NONE';
  const orderingEvidence = proj.ordering_evidence || null;
  const latestEndpoint = orderingEvidence?.latest_endpoint || null;

  // A. Browser 标签与红点
  const browserTag = scanRow.querySelector('.endpoint-tag-browser');
  const isBrowserLatest = indicator === 'BROWSER_LATEST' && (!latestEndpoint || latestEndpoint === 'browser' || proj.browser?.is_latest_result);
  updateLatestDot(browserTag, isBrowserLatest, '最新完成结果: Browser');

  // B. IDE 标签与红点
  const ideSlots = proj.ide_endpoints || [];
  if (ideSlots.length <= 1) {
    const singleIde = ideSlots[0] || { endpoint_id: 'ide' };
    const ideTag = scanRow.querySelector('.endpoint-tag-ide');
    const isIdeLatest = indicator === 'IDE_LATEST' && (singleIde.is_latest_result || latestEndpoint === singleIde.endpoint_id || !latestEndpoint);
    updateLatestDot(ideTag, isIdeLatest, '最新完成结果: IDE');
  } else {
    const isSideLevelIdeLatest = indicator === 'IDE_LATEST' && (!latestEndpoint || !ideSlots.some(e => e.endpoint_id === latestEndpoint));
    const ideGroup = scanRow.querySelector('.endpoint-tag-ide-group');
    updateLatestDot(ideGroup, isSideLevelIdeLatest, '最新完成结果: IDE (侧级)');

    const subSlots = scanRow.querySelectorAll('.ide-sub-slots .endpoint-tag-ide');
    subSlots.forEach(subSlot => {
      const epId = subSlot.getAttribute('data-endpoint-id');
      const slotData = ideSlots.find(e => e.endpoint_id === epId);
      const isThisSlotLatest = !isSideLevelIdeLatest && indicator === 'IDE_LATEST' && (slotData?.is_latest_result || latestEndpoint === epId);
      const slotLabel = subSlot.textContent.replace('●', '').trim() || epId;
      updateLatestDot(subSlot, isThisSlotLatest, `最新完成结果: ${slotLabel}`);
    });
  }

  // C. UNCERTAIN 标记更新
  const endpointsCell = scanRow.querySelector('.scan-cell-endpoints');
  if (endpointsCell) {
    let uncertainEl = endpointsCell.querySelector('.indicator-uncertain');
    if (indicator === 'UNCERTAIN') {
      if (!uncertainEl) {
        uncertainEl = scanRow.ownerDocument.createElement('span');
        uncertainEl.className = 'indicator-uncertain';
        uncertainEl.title = '两端完成时间相近或未确立明确先后，暂时无法判断哪边更新得更晚';
        uncertainEl.textContent = '暂时无法判断哪边更新得更晚';
        endpointsCell.appendChild(uncertainEl);
      }
    } else if (uncertainEl) {
      uncertainEl.remove();
    }
  }

  // D. 诚实相对观察时间更新
  const timeCell = scanRow.querySelector('.scan-cell-time time.relative-time');
  if (timeCell) {
    const browserTime = proj.browser?.completed_at;
    const ideTimes = ideSlots.map(e => e.completed_at).filter(Boolean);
    const candidateTimes = [browserTime, ...ideTimes].filter(Boolean).sort().reverse();
    const mostRecentTime = candidateTimes[0] || null;
    const relText = formatHonestRelativeTimeClient(mostRecentTime);
    timeCell.textContent = relText;
    if (mostRecentTime) {
      timeCell.setAttribute('datetime', mostRecentTime);
      timeCell.setAttribute('title', `最新观察时间: ${mostRecentTime}`);
    } else {
      timeCell.removeAttribute('datetime');
      timeCell.removeAttribute('title');
    }
  }

  // E. Actionable Attention 更新
  const attentionCell = scanRow.querySelector('.scan-cell-attention');
  if (attentionCell) {
    const hasHuman = Boolean(proj.human_intervention?.active);
    const untrustedSlot = [proj.browser, ...ideSlots].find(e => e && e.continuity?.trusted === false);

    if (hasHuman) {
      let humanTag = attentionCell.querySelector('.attention-human');
      if (!humanTag) {
        attentionCell.innerHTML = `
          <span class="scan-attention-tag attention-human" role="alert">
            <span class="badge badge-human">需要人工核验</span>
            <span>${escapeText(proj.human_intervention.reason || '人工核验介入')}</span>
            <button
              type="button"
              class="btn btn-control btn-clear-human btn-xs"
              data-action="clear-human-intervention"
              data-binding-id="${escapeText(proj.binding_id)}"
              data-binding-revision="${escapeText(proj.binding_revision)}"
              title="解决并清除人工介入">
              清除
            </button>
          </span>
        `;
      }
    } else if (untrustedSlot) {
      let unknownTag = attentionCell.querySelector('.attention-unknown');
      if (!unknownTag) {
        attentionCell.innerHTML = `
          <span class="scan-attention-tag attention-unknown" title="状态不确定 / 需检查 (详情见诊断)">
            ⚠️ 状态不确定 / 需检查
          </span>
        `;
      }
    } else {
      attentionCell.innerHTML = '';
    }
  }

  // 同步更新清除介入按钮上的 binding_revision
  const clearBtn = scanRow.querySelector('.btn-clear-human');
  if (clearBtn && proj.binding_revision !== undefined) {
    clearBtn.setAttribute('data-binding-revision', String(proj.binding_revision));
  }
}

/**
 * 客户端 Action 事实表格渲染函数 (与服务端模板结构严格一致)
 * @param {Array<object>} actions
 * @returns {string} HTML 字符串
 */
function renderActionsTableClient(actions) {
  if (!actions || actions.length === 0) {
    return '<div class="text-muted" style="font-size: 0.85rem; padding: 6px 0;">无活跃或历史动作事实</div>';
  }

  const rows = actions.map(act => {
    const reasonText = act.reason || (typeof act.evidence === 'string' ? act.evidence : act.evidence?.reason || act.evidence?.error) || '';
    const nonceText = act.nonce ? `<code>${escapeText(act.nonce.slice(0, 8))}...</code>` : '-';
    return `
      <tr class="action-row stage-row-${escapeText(act.stage)}">
        <td><code>${escapeText(act.action_id)}</code></td>
        <td><span>${escapeText(act.action_type)}</span></td>
        <td><code>${escapeText(act.target_endpoint || '-')}</code></td>
        <td><span class="badge badge-stage stage-${escapeText(act.stage)}">${escapeText(act.stage)}</span></td>
        <td>${nonceText}</td>
        <td class="action-reason-cell">${reasonText ? `<span class="action-reason">${escapeText(reasonText)}</span>` : '<span class="text-muted">-</span>'}</td>
        <td class="text-muted">${escapeText(act.updated_at || act.created_at || '-')}</td>
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

/**
 * 更新 Details 诊断区 DOM 元素 (保留 open 状态与焦点)
 * @param {Element} details
 * @param {object} proj
 */
function updateDetailsDom(details, proj) {
  const bRev = proj.binding_revision;

  // 1. 同步更新摘要头部的 binding_revision badge
  if (bRev !== undefined) {
    const revBadge = details.querySelector('.badge-rev');
    if (revBadge) {
      revBadge.textContent = `rev ${bRev}`;
    }

    // 2. 同步更新 Details 内所有控制按钮的 data-binding-revision 属性
    const revButtons = details.querySelectorAll('button[data-binding-revision]');
    revButtons.forEach(btn => {
      btn.setAttribute('data-binding-revision', String(bRev));
    });
  }

  // 3. 同步更新所有端点卡片
  const allEndpoints = [proj.browser, ...(proj.ide_endpoints || [])].filter(Boolean);

  for (const ep of allEndpoints) {
    const epId = ep.endpoint_id || ep.endpoint;
    const epCard = details.querySelector(`.endpoint-card[data-endpoint-id="${epId}"]`);
    if (!epCard) continue;

    epCard.setAttribute('data-result-state', ep.result_state || 'UNKNOWN');
    if (ep.latest_completed_cursor !== undefined) {
      epCard.setAttribute('data-latest-cursor', ep.latest_completed_cursor || '');
    }
    if (ep.latest_completed_result?.result_ref) {
      epCard.setAttribute('data-result-ref', ep.latest_completed_result.result_ref);
    }

    // A. 端点版本 badge (rev X)
    const epRevBadge = epCard.querySelector('.ep-rev-badge');
    if (epRevBadge) {
      epRevBadge.textContent = `rev ${ep.endpoint_revision || 1}`;
    }

    // B. 状态 badge
    const badge = epCard.querySelector('.endpoint-header .badge');
    if (badge) {
      badge.className = 'badge';
      if (ep.result_state === 'NEW') {
        badge.classList.add('badge-new');
        badge.textContent = 'NEW';
      } else if (ep.result_state === 'NO_NEW_RESULT') {
        badge.classList.add('badge-caught-up');
        badge.textContent = 'NO_NEW_RESULT';
      } else {
        badge.classList.add('badge-unknown');
        badge.textContent = ep.result_state || 'UNKNOWN';
      }
    }

    // C. 游标与处理状态展示
    const cursorVal = epCard.querySelector('.cursor-val');
    if (cursorVal) {
      cursorVal.textContent = ep.latest_completed_cursor !== null && ep.latest_completed_cursor !== undefined
        ? String(ep.latest_completed_cursor)
        : '(none)';
    }

    const handledCursorVal = epCard.querySelector('.meta-handled-cursor');
    if (handledCursorVal) {
      handledCursorVal.textContent = ep.last_handled_cursor !== null && ep.last_handled_cursor !== undefined
        ? String(ep.last_handled_cursor)
        : '(无)';
    }

    // D. Rebind 按钮携带的最新身份属性同步
    const rebindBtn = epCard.querySelector('button[data-action="rebind"]');
    if (rebindBtn) {
      if (bRev !== undefined) {
        rebindBtn.setAttribute('data-binding-revision', String(bRev));
      }
      rebindBtn.setAttribute('data-conversation-id', ep.conversation_id || '');
      rebindBtn.setAttribute('data-branch', ep.branch || '');
      rebindBtn.setAttribute('data-workspace', ep.workspace_identity || '');
      rebindBtn.setAttribute('data-repo', ep.repository_identity || '');
    }

    // E. 端点卡片身份展示文本同步 (.identity-line)
    const identityLines = epCard.querySelectorAll('.identity-line');
    identityLines.forEach(line => {
      const labels = line.querySelectorAll('.meta-label');
      labels.forEach(label => {
        const labelText = label.textContent || '';
        const codeSibling = label.nextElementSibling;
        if (!codeSibling || codeSibling.tagName !== 'CODE') return;

        if (labelText.includes('会话 ID')) {
          codeSibling.textContent = ep.conversation_id || '(未绑定)';
        } else if (labelText.includes('分支')) {
          codeSibling.textContent = ep.branch || '(未指定分支)';
        } else if (labelText.includes('工作区')) {
          codeSibling.textContent = ep.workspace_identity || '-';
        } else if (labelText.includes('代码仓库')) {
          codeSibling.textContent = ep.repository_identity || '-';
        } else if (labelText.includes('Provider')) {
          codeSibling.textContent = ep.provider || 'chatgpt';
        }
      });
    });

    // F. Mark handled 按钮状态
    const handledBtn = epCard.querySelector('button[data-action="mark-handled"]');
    if (handledBtn) {
      const isNew = ep.result_state === 'NEW';
      const hasCursor = ep.latest_completed_cursor !== null && ep.latest_completed_cursor !== undefined;
      const isTrusted = ep.continuity?.trusted !== false;

      handledBtn.disabled = !isNew || !hasCursor || !isTrusted;
      if (hasCursor) {
        handledBtn.setAttribute('data-expected-cursor', String(ep.latest_completed_cursor));
        handledBtn.setAttribute('data-expected-cursor-json', encodeURIComponent(JSON.stringify(ep.latest_completed_cursor)));
      } else {
        handledBtn.removeAttribute('data-expected-cursor');
        handledBtn.removeAttribute('data-expected-cursor-json');
      }
    }
  }

  // 4. Action 历史事实表格与错误证据同步
  const actionsPlane = details.querySelector('.actions-history-plane');
  if (actionsPlane) {
    const actions = Array.isArray(proj.actions) ? proj.actions : [];
    const countStrong = actionsPlane.querySelector('.section-title strong');
    if (countStrong) {
      countStrong.textContent = `Action 动作事实记录 (${actions.length})`;
    }
    const containerDiv = actionsPlane.querySelector('div[style*="margin-top"]') || actionsPlane.querySelector('.table-responsive');
    if (containerDiv) {
      containerDiv.innerHTML = renderActionsTableClient(actions);
    }
  }
}

/**
 * 将规范投影单向更新至 DOM (纯只读消费者)
 * @param {Document} doc
 * @param {Array<object>} projects
 * @param {object} [attentionTray]
 * @param {object} [options]
 * @param {Function} [options.onStructuralMismatch]
 * @returns {{ success: boolean, reloaded: boolean, reason?: string }}
 */
export function applyProjectionToDom(doc, projects = [], attentionTray = null, { onStructuralMismatch = null } = {}) {
  if (!doc) return { success: false, reloaded: false };

  // 0. 结构拓扑前置校验：若当前 DOM 与规范投影拓扑不一致，拒绝增量假同步 (Blocker #37)
  const isTopologyMatch = checkStructuralTopologyMatches(doc, projects);
  if (!isTopologyMatch) {
    if (typeof onStructuralMismatch === 'function') {
      onStructuralMismatch();
    }
    return { success: false, reloaded: true, reason: 'topology_mismatch' };
  }

  const totalProjects = projects.length;
  let attentionCount = 0;
  for (const p of projects) {
    const hasHuman = Boolean(p.human_intervention?.active);
    const hasUncertain = p.latest_result_indicator === 'UNCERTAIN';
    const hasUntrusted = [p.browser, ...(p.ide_endpoints || [])].some(e => e && e.continuity?.trusted === false);
    if (hasHuman || hasUncertain || hasUntrusted) {
      attentionCount++;
    }
  }

  const summaryBar = doc.querySelector('.status-summary-bar');
  if (summaryBar) {
    const strongs = summaryBar.querySelectorAll('strong');
    if (strongs.length >= 2) {
      strongs[0].textContent = String(totalProjects);
      strongs[1].textContent = String(attentionCount);
      strongs[1].style.color = attentionCount > 0 ? '#e3b341' : '#3fb950';
    }
  }

  const allFilterBtn = doc.querySelector('.filter-btn[data-filter="all"]');
  if (allFilterBtn) {
    allFilterBtn.textContent = `全部 (${totalProjects})`;
  }
  const attentionFilterBtn = doc.querySelector('.filter-btn[data-filter="attention"]');
  if (attentionFilterBtn) {
    attentionFilterBtn.textContent = `需关注 (${attentionCount})`;
  }

  for (const proj of projects) {
    const bindingId = proj.binding_id;
    const card = doc.getElementById(`card-${bindingId}`);
    if (!card) continue;

    const scanRow = card.querySelector('.project-scan-row');
    if (scanRow) {
      updateScanRowDom(scanRow, proj);
    }

    const details = card.querySelector('.project-details');
    if (details) {
      updateDetailsDom(details, proj);
    }
  }

  return { success: true, reloaded: false };
}

/**
 * 设置表面同步与陈旧状态 (Fail-Visible)
 * @param {Document} doc
 * @param {object} options
 * @param {boolean} options.isStale
 * @param {string} [options.reason]
 * @param {string} [options.lastSyncTime]
 */
export function setSurfaceStaleStatus(doc, { isStale, reason = '', lastSyncTime = '' } = {}) {
  if (!doc) return;

  if (doc.body) {
    doc.body.setAttribute('data-surface-stale', isStale ? 'true' : 'false');
  }

  let indicator = doc.getElementById('surface-sync-indicator');
  if (!indicator) {
    const header = doc.querySelector('.app-header');
    if (header) {
      indicator = doc.createElement('div');
      indicator.id = 'surface-sync-indicator';
      header.appendChild(indicator);
    }
  }

  if (indicator) {
    indicator.className = 'sync-indicator ' + (isStale ? 'sync-stale' : 'sync-live');
    const timeStr = lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString() : '刚刚';
    if (isStale) {
      indicator.textContent = `⚠️ 保持陈旧 / 同步断开 (${timeStr})`;
      indicator.title = reason || '未能连接到状态服务器，呈现只读陈旧事实';
    } else {
      indicator.textContent = `● 实时已同步 (${timeStr})`;
      indicator.title = '与服务端保持实时同步';
    }
  }
}

/**
 * 客户端内联执行脚本常量 (注入到 HTML 页面底部)
 */
export const LIVE_REFRESH_CLIENT_JS = `
  (function() {
    ${formatHonestRelativeTimeClient.toString()}
    ${escapeText.toString()}
    ${updateLatestDot.toString()}
    ${renderActionsTableClient.toString()}
    ${checkStructuralTopologyMatches.toString()}
    ${updateScanRowDom.toString()}
    ${updateDetailsDom.toString()}
    ${applyProjectionToDom.toString()}
    ${setSurfaceStaleStatus.toString()}

    var lastSuccessfulSyncTime = new Date().toISOString();
    var isRefreshing = false;

    async function fetchAndApplyProjects() {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        var resp = await fetch('/api/projects', {
          headers: { 'Accept': 'application/json' },
          cache: 'no-store'
        });
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        var data = await resp.json();
        if (data && Array.isArray(data.projects)) {
          var isTopologyMatch = checkStructuralTopologyMatches(document, data.projects);
          if (!isTopologyMatch) {
            setSurfaceStaleStatus(document, { isStale: true, reason: '检测到项目或端点结构拓扑变更，正在自动重新加载...' });
            if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
              window.location.reload();
            }
            return;
          }

          lastSuccessfulSyncTime = new Date().toISOString();
          applyProjectionToDom(document, data.projects, data.attention_tray);
          setSurfaceStaleStatus(document, { isStale: false, lastSyncTime: lastSuccessfulSyncTime });
        }
      } catch (err) {
        setSurfaceStaleStatus(document, { isStale: true, reason: err.message, lastSyncTime: lastSuccessfulSyncTime });
      } finally {
        isRefreshing = false;
      }
    }

    window.__triggerSurfaceRefresh = fetchAndApplyProjects;

    var isHttpPage = Boolean(window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:'));
    if (isHttpPage) {
      var refreshTimer = setInterval(fetchAndApplyProjects, 1500);
      if (typeof refreshTimer !== 'undefined' && refreshTimer && typeof refreshTimer.unref === 'function') {
        try { refreshTimer.unref(); } catch (_) {}
      }
      window.__stopSurfaceRefresh = function() {
        if (refreshTimer) clearInterval(refreshTimer);
      };
      document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
          fetchAndApplyProjects();
        }
      });
    }

    setSurfaceStaleStatus(document, { isStale: false, lastSyncTime: lastSuccessfulSyncTime });
  })();
`;
