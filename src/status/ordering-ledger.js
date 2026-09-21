/**
 * Ordering Ledger — 结果时序证据与最新结果指示器裁决模块
 *
 * 领域不变式与架构契约 (#27, #35):
 * 1. 证据持久化而非 UI 状态：仅持久化 ordering evidence/checkpoint 与 witness sequence，绝不持久化红点等派生视觉字段；
 * 2. 纯函数式派生：Latest Result Indicator (BROWSER_LATEST / IDE_LATEST / UNCERTAIN / NONE) 纯粹从 ordering evidence 派生；
 * 3. 独立于 Attention 事实：markEndpointHandled 绝不改写、清除或移动 ordering evidence；
 * 4. 在线见证优先 (Live Witnessed Priority)：带有 live_witnessed: true 的完成立即建立该端点为最新，并能从 UNCERTAIN 恢复；
 * 5. 观察空白期项目级原子对账 (Project-Atomic Gap Reconciliation)：
 *    - 必须基于当前 Browser + 所有 IDE 游标与 Checkpoint 游标差量做原子裁决；
 *    - 扫描顺序（Browser 先还是 IDE 先）绝不能成为事件顺序，两者必须得出严格一致的裁决；
 *    - 游标均未变 -> 保持先前确定性状态；
 *    - Browser 未变 + IDE 推进 -> IDE_LATEST（记录具体 IDE endpoint）；
 *    - 未见证的 Browser 游标变化（无法排除分支导航） -> Fail-Closed UNCERTAIN；
 *    - 双端并发推进 -> Fail-Closed UNCERTAIN；
 * 6. 多 IDE 隔离与保留：内部持久化保留 exact latest_endpoint identity，Surface 全局指示器折叠为 IDE_LATEST。
 */

export const ALLOWED_CERTAINTIES = ['NONE', 'DEFINITE', 'UNCERTAIN'];
export const ALLOWED_INDICATOR_STATES = ['BROWSER_LATEST', 'IDE_LATEST', 'UNCERTAIN', 'NONE'];
export const ALLOWED_EVIDENCE_TYPES = ['INITIAL', 'LIVE_WITNESSED', 'RECONCILED_IDE_ONLY', 'GAP_UNCERTAIN'];

/**
 * 创建初始结果时序证据对象
 * @param {object} [params]
 * @param {string} [params.updatedAt]
 * @returns {object}
 */
export function createInitialOrderingEvidence({ updatedAt = new Date().toISOString() } = {}) {
  return {
    certainty: 'NONE',
    latest_side: null,
    latest_endpoint: null,
    candidate_endpoints: [],
    checkpoint_cursors: {
      browser: null,
      ide: {}
    },
    witness_seq: 0,
    evidence_type: 'INITIAL',
    updated_at: updatedAt
  };
}

/**
 * 从 Ordering Evidence 纯函数派生最新结果指示器状态
 * @param {object|null} evidence
 * @returns {'BROWSER_LATEST' | 'IDE_LATEST' | 'UNCERTAIN' | 'NONE'}
 */
export function deriveLatestResultIndicator(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return 'NONE';
  }

  const certainty = evidence.certainty || 'NONE';
  if (certainty === 'NONE') {
    return 'NONE';
  }
  if (certainty === 'UNCERTAIN') {
    return 'UNCERTAIN';
  }
  if (certainty === 'DEFINITE') {
    const latest = evidence.latest_endpoint;
    const side = evidence.latest_side;
    if (latest === 'browser' || side === 'browser') {
      return 'BROWSER_LATEST';
    }
    if ((typeof latest === 'string' && latest.trim().length > 0) || side === 'ide') {
      return 'IDE_LATEST';
    }
  }

  return 'NONE';
}

/**
 * 受信水合持久化的 Ordering Evidence
 * 支持旧 schema-v2 缺失字段的平滑降级 (安全默认 NONE)
 * @param {object|null} persistedEvidence
 * @param {object} options
 * @returns {object}
 */
export function hydrateOrderingEvidence(
  persistedEvidence,
  { fallbackUpdatedAt = new Date().toISOString(), initialEndpointsCursors = null } = {}
) {
  if (!persistedEvidence || typeof persistedEvidence !== 'object') {
    const init = createInitialOrderingEvidence({ updatedAt: fallbackUpdatedAt });
    if (initialEndpointsCursors && typeof initialEndpointsCursors === 'object') {
      init.checkpoint_cursors.browser = initialEndpointsCursors.browser ?? null;
      if (initialEndpointsCursors.ide && typeof initialEndpointsCursors.ide === 'object') {
        init.checkpoint_cursors.ide = { ...initialEndpointsCursors.ide };
      }
    }
    return init;
  }

  const certainty = ALLOWED_CERTAINTIES.includes(persistedEvidence.certainty)
    ? persistedEvidence.certainty
    : 'NONE';

  const rawLatest = persistedEvidence.latest_endpoint;
  const latestEndpoint = typeof rawLatest === 'string' && rawLatest.trim() ? rawLatest.trim() : null;

  const rawCp = persistedEvidence.checkpoint_cursors || {};
  const checkpointCursors = {
    browser: typeof rawCp.browser === 'string' ? rawCp.browser : null,
    ide: typeof rawCp.ide === 'object' && rawCp.ide !== null && !Array.isArray(rawCp.ide)
      ? { ...rawCp.ide }
      : {}
  };

  const witnessSeq = Number.isInteger(persistedEvidence.witness_seq) && persistedEvidence.witness_seq >= 0
    ? persistedEvidence.witness_seq
    : 0;

  const evidenceType = ALLOWED_EVIDENCE_TYPES.includes(persistedEvidence.evidence_type)
    ? persistedEvidence.evidence_type
    : 'INITIAL';

  const latestSide = persistedEvidence.latest_side === 'browser' || persistedEvidence.latest_side === 'ide'
    ? persistedEvidence.latest_side
    : (latestEndpoint === 'browser' ? 'browser' : (latestEndpoint ? 'ide' : null));

  const candidateEndpoints = Array.isArray(persistedEvidence.candidate_endpoints)
    ? [...persistedEvidence.candidate_endpoints]
    : (latestEndpoint ? [latestEndpoint] : []);

  return {
    certainty,
    latest_side: certainty === 'DEFINITE' ? latestSide : null,
    latest_endpoint: certainty === 'DEFINITE' ? latestEndpoint : null,
    candidate_endpoints: certainty === 'DEFINITE' ? candidateEndpoints : [],
    checkpoint_cursors: checkpointCursors,
    witness_seq: witnessSeq,
    evidence_type: evidenceType,
    updated_at: persistedEvidence.updated_at || fallbackUpdatedAt
  };
}

/**
 * 记录在线见证的最新完成 (Live Witnessed Completion)
 * 具备因果终结性，立即建立确切的 latest 端点并更新 Checkpoint
 * @param {object} currentEvidence
 * @param {object} params
 * @param {string} params.endpointId - 'browser' 或具体的 ide endpoint_id
 * @param {string|null} params.cursor - 该端点产生的最新有效游标
 * @param {object} params.allCurrentCursors - { browser: string|null, ide: { [id]: string|null } }
 * @param {string} [params.now]
 * @returns {object} 新的 ordering evidence
 */
export function recordLiveWitnessedCompletion(currentEvidence, {
  endpointId,
  cursor,
  allCurrentCursors = {},
  now = new Date().toISOString()
}) {
  if (!endpointId || typeof endpointId !== 'string') {
    return currentEvidence;
  }

  const baseIde = typeof allCurrentCursors.ide === 'object' && allCurrentCursors.ide !== null
    ? { ...allCurrentCursors.ide }
    : {};

  let nextBrowserCp = allCurrentCursors.browser ?? currentEvidence.checkpoint_cursors?.browser ?? null;
  if (endpointId === 'browser') {
    nextBrowserCp = cursor;
  } else {
    baseIde[endpointId] = cursor;
  }

  const nextSeq = (currentEvidence?.witness_seq || 0) + 1;
  const isBrowser = endpointId === 'browser';

  return {
    certainty: 'DEFINITE',
    latest_side: isBrowser ? 'browser' : 'ide',
    latest_endpoint: endpointId,
    candidate_endpoints: [endpointId],
    checkpoint_cursors: {
      browser: nextBrowserCp,
      ide: baseIde
    },
    witness_seq: nextSeq,
    evidence_type: 'LIVE_WITNESSED',
    updated_at: now
  };
}

/**
 * 执行项目级原子观察空白期对账 (Project-Atomic Gap Reconciliation)
 * 
 * 强制契约：
 * 1. 严格原子比较当前全量端点游标集合与 Checkpoint 游标集合；
 * 2. 绝不被各个端点的采集顺序（先扫描 IDE 还是先扫描 Browser）所影响；
 * 3. 严格执行 #35 的四分枝判定。
 * 
 * @param {object} currentEvidence - 当前持久化证据
 * @param {object} params
 * @param {string|null} params.browserCursor - 当前 Browser 端点实际游标
 * @param {object} params.ideCursorsMap - 当前所有 IDE 端点实际游标映射 { [endpoint_id]: cursor|null }
 * @param {string} [params.now]
 * @returns {object} 对账后的 ordering evidence
 */
export function reconcileProjectOrdering(currentEvidence, {
  browserCursor = null,
  ideCursorsMap = {},
  now = new Date().toISOString()
} = {}) {
  const prevCp = currentEvidence?.checkpoint_cursors || { browser: null, ide: {} };
  const prevBrowser = prevCp.browser ?? null;
  const prevIde = prevCp.ide || {};

  const currBrowser = browserCursor ?? null;
  const currIde = typeof ideCursorsMap === 'object' && ideCursorsMap !== null ? ideCursorsMap : {};

  // 1. 计算游标差量
  const browserChanged = currBrowser !== prevBrowser;

  const changedIdeIds = [];
  const allIdeKeys = Array.from(new Set([...Object.keys(prevIde), ...Object.keys(currIde)]));
  for (const id of allIdeKeys) {
    const p = prevIde[id] ?? null;
    const c = currIde[id] ?? null;
    if (c !== p) {
      changedIdeIds.push(id);
    }
  }

  const ideChanged = changedIdeIds.length > 0;

  // 组装最新全量游标快照
  const nextCheckpointCursors = {
    browser: currBrowser,
    ide: { ...currIde }
  };

  const nextSeq = (currentEvidence?.witness_seq || 0) + 1;

  // 2. 四分枝原子裁决
  // 分枝 1: 没有任何端点变动 -> 保持先前确定性 latest 状态与证据
  if (!browserChanged && !ideChanged) {
    return {
      ...currentEvidence,
      updated_at: now
    };
  }

  // 分枝 2: Browser 未变，仅 IDE 推进 (Blocker 1)
  if (!browserChanged && ideChanged) {
    if (changedIdeIds.length === 1) {
      // 恰好 1 个 IDE 端点推进：保留 exact-endpoint DEFINITE 证明
      const targetIdeId = changedIdeIds[0];
      return {
        certainty: 'DEFINITE',
        latest_side: 'ide',
        latest_endpoint: targetIdeId,
        candidate_endpoints: [targetIdeId],
        checkpoint_cursors: nextCheckpointCursors,
        witness_seq: nextSeq,
        evidence_type: 'RECONCILED_IDE_ONLY',
        updated_at: now
      };
    }

    // 多个 IDE 端点在 gap 中同时推进：确认 IDE 端为最新 (side-level)，但绝不伪造 exact endpoint
    const sortedCandidates = [...changedIdeIds].sort();
    return {
      certainty: 'DEFINITE',
      latest_side: 'ide',
      latest_endpoint: null,
      candidate_endpoints: sortedCandidates,
      checkpoint_cursors: nextCheckpointCursors,
      witness_seq: nextSeq,
      evidence_type: 'RECONCILED_IDE_ONLY',
      updated_at: now
    };
  }

  // 分枝 3: 仅 Browser 变动（未见证游标变更，无法排除分支导航） -> Fail-Closed UNCERTAIN
  if (browserChanged && !ideChanged) {
    return {
      certainty: 'UNCERTAIN',
      latest_side: null,
      latest_endpoint: null,
      candidate_endpoints: [],
      checkpoint_cursors: nextCheckpointCursors,
      witness_seq: nextSeq,
      evidence_type: 'GAP_UNCERTAIN',
      updated_at: now
    };
  }

  // 分枝 4: Browser 与 IDE 双端均推进 (跨端物理时序不可比) -> Fail-Closed UNCERTAIN
  return {
    certainty: 'UNCERTAIN',
    latest_side: null,
    latest_endpoint: null,
    candidate_endpoints: [],
    checkpoint_cursors: nextCheckpointCursors,
    witness_seq: nextSeq,
    evidence_type: 'GAP_UNCERTAIN',
    updated_at: now
  };
}

/**
 * 响应拓扑与端点身份生命周期变更，重置并对齐 Ordering Evidence (Blocker 3)
 * 
 * 强制生命周期不变式：
 * 1. 绝不保留已失效端点身份/修订版本的游标或 exact-latest 声明；
 * 2. 变更后的 Checkpoint 游标必须严格对齐 mutation 后的端点集合；
 * 3. 仅当先前的 definite latest exact endpoint 仍然完好存在且未被本次变更废弃时，保留该 latest；
 * 4. 若先前的 latest 端点本身被 rebind 或 remove，旧证据立即失效并 Fail-Closed (若无剩余完成结果则为 NONE，否则为 UNCERTAIN)；
 * 5. 新增空端点绝不错误挪动或改变现有指示器。
 * 
 * @param {object} currentEvidence
 * @param {object} params
 * @param {'REBIND' | 'REMOVE' | 'ADD'} params.mutationType
 * @param {'browser' | 'ide'} params.targetRole
 * @param {string} params.targetId - 'browser' 或具体的 ide endpoint_id
 * @param {object} params.allCurrentCursors - { browser: string|null, ide: { [id]: string|null } }
 * @param {string} [params.now]
 * @returns {object} 新的 ordering evidence
 */
export function rebaselineOrderingOnLifecycle(currentEvidence, {
  mutationType,
  targetRole,
  targetId,
  allCurrentCursors = {},
  now = new Date().toISOString()
}) {
  if (!currentEvidence || typeof currentEvidence !== 'object') {
    return createInitialOrderingEvidence({ updatedAt: now });
  }

  // 1. 基于 mutation 后的最新端点集合更新 checkpoint cursors
  const nextCheckpointCursors = {
    browser: allCurrentCursors.browser ?? null,
    ide: typeof allCurrentCursors.ide === 'object' && allCurrentCursors.ide !== null
      ? { ...allCurrentCursors.ide }
      : {}
  };

  const nextSeq = (currentEvidence.witness_seq || 0) + 1;

  // 检查当前所有端点中是否还有任何非 null 的已完成游标
  const hasRemainingCompletedCursors = Boolean(
    nextCheckpointCursors.browser !== null ||
    Object.values(nextCheckpointCursors.ide).some(c => c !== null && c !== undefined)
  );

  // 2. 检查 prior latest endpoint 是否受到 mutation 影响
  const priorLatest = currentEvidence.latest_endpoint;
  const priorSide = currentEvidence.latest_side;
  const wasDefinite = currentEvidence.certainty === 'DEFINITE';

  // 受影响端点标识
  const affectedEndpointId = targetRole === 'browser' ? 'browser' : targetId;
  const isPriorLatestAffected = wasDefinite && (
    priorLatest === affectedEndpointId ||
    (priorLatest === null && priorSide === 'ide' && targetRole === 'ide')
  );

  if (!wasDefinite) {
    if (!hasRemainingCompletedCursors) {
      return {
        certainty: 'NONE',
        latest_side: null,
        latest_endpoint: null,
        candidate_endpoints: [],
        checkpoint_cursors: nextCheckpointCursors,
        witness_seq: nextSeq,
        evidence_type: 'INITIAL',
        updated_at: now
      };
    }
    return {
      ...currentEvidence,
      checkpoint_cursors: nextCheckpointCursors,
      witness_seq: nextSeq,
      updated_at: now
    };
  }

  // 先前为 DEFINITE 且 latest 端点受损
  if (isPriorLatestAffected) {
    if (!hasRemainingCompletedCursors) {
      return {
        certainty: 'NONE',
        latest_side: null,
        latest_endpoint: null,
        candidate_endpoints: [],
        checkpoint_cursors: nextCheckpointCursors,
        witness_seq: nextSeq,
        evidence_type: 'INITIAL',
        updated_at: now
      };
    }
    return {
      certainty: 'UNCERTAIN',
      latest_side: null,
      latest_endpoint: null,
      candidate_endpoints: [],
      checkpoint_cursors: nextCheckpointCursors,
      witness_seq: nextSeq,
      evidence_type: 'GAP_UNCERTAIN',
      updated_at: now
    };
  }

  // 先前的 latest 端点完好存活（例如添加新空端点，或变更非 latest 端点）
  return {
    ...currentEvidence,
    checkpoint_cursors: nextCheckpointCursors,
    witness_seq: nextSeq,
    updated_at: now
  };
}
