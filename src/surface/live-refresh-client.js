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
      updateLatestDot(subSlot, isThisSlotLatest, `最新完成结果: ${epId}`);
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
        uncertainEl.title = '端点完成先后顺序不确定 (UNCERTAIN)';
        uncertainEl.textContent = '? 排序未定';
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
            <span class="badge badge-human">HUMAN INTERVENTION REQUIRED</span>
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
}

/**
 * 更新 Details 诊断区 DOM 元素 (保留 open 状态)
 * @param {Element} details
 * @param {object} proj
 */
function updateDetailsDom(details, proj) {
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

    const cursorVal = epCard.querySelector('.cursor-val');
    if (cursorVal) {
      cursorVal.textContent = ep.latest_completed_cursor !== null && ep.latest_completed_cursor !== undefined
        ? String(ep.latest_completed_cursor)
        : '(none)';
    }

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
}

/**
 * 将规范投影单向更新至 DOM (纯只读消费者)
 * @param {Document} doc
 * @param {Array<object>} projects
 * @param {object} [attentionTray]
 */
export function applyProjectionToDom(doc, projects = [], attentionTray = null) {
  if (!doc) return;

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
      indicator.title = '状态表面与服务端规范快照保持实时同步';
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
    setInterval(fetchAndApplyProjects, 1500);

    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        fetchAndApplyProjects();
      }
    });

    setSurfaceStaleStatus(document, { isStale: false, lastSyncTime: lastSuccessfulSyncTime });
  })();
`;
