/**
 * Attention Tray 投影派生模块 (Attention Tray Projection)
 *
 * 领域不变式与规范准则 (#20):
 * 1. 唯一真实数据源：纯函数派生自 ProjectRegistry 规范事实快照，严禁建立第二套持久状态库或 work queue；
 * 2. 独立端点呈现：保留 Browser NEW、IDE-A NEW、IDE-B NEW 各自独立的 exact-source 条目；
 * 3. 独立平面隔离：Human Intervention 与 Action 事实作为独立类别呈现，互不遮蔽；
 * 4. 动作注意力过滤：仅 BLOCKED、FAILED、UNKNOWN 状态动作纳入注意力托盘，常规中继流转动作不进入；
 * 5. 确定性机器证据分类：如多匹配歧义（TARGET_LOOKUP_FAIL 等）或阻断的 rebind 进行确定性分类，不推断自然语言意图；
 * 6. 严禁 Baton / Owner / Next Actor 字段与推断；
 * 7. 只读纯度：派生 Tray 与展示绝对不修改规范事实，不触发 handled、clear 或 action 迁移；
 * 8. 数据最小化：不携带未过滤的完整对话正文与内部私有转录。
 */

/**
 * 提取 Action 的凭据/原因字符串
 * @param {object|null} action
 * @returns {string}
 */
export function extractActionEvidenceString(action) {
  if (!action) return '';
  if (typeof action.evidence === 'string') return action.evidence;
  return action.evidence?.reason || action.evidence?.error || '';
}

/**
 * 判断动作是否包含目标歧义证据
 * @param {object} action - Action 事实
 * @returns {boolean}
 */
export function isTargetAmbiguityAction(action) {
  if (!action) return false;
  const evidenceStr = extractActionEvidenceString(action);
  return (
    evidenceStr.includes('AMBIGUOUS_MATCHES') ||
    evidenceStr.includes('Ambiguous match') ||
    evidenceStr.includes('AMBIGUOUS_CONVERSATION_TAB') ||
    evidenceStr.includes('target ambiguity')
  );
}

/**
 * 判断动作是否为因 unhandled NEW/UNKNOWN 受阻的 Rebind
 * @param {object} action - Action 事实
 * @returns {boolean}
 */
export function isRebindBlockedAction(action) {
  if (!action || action.action_type !== 'rebind' || action.stage !== 'BLOCKED') {
    return false;
  }
  const evidenceStr = extractActionEvidenceString(action);
  return (
    evidenceStr.includes('unhandled NEW') ||
    evidenceStr.includes('unhandled UNKNOWN') ||
    evidenceStr.includes('without explicit confirmation')
  );
}

/**
 * 确定 Action 注意力条目的确定性分类
 * @param {object} action
 * @returns {string}
 */
export function classifyActionAttention(action) {
  if (isTargetAmbiguityAction(action)) {
    return 'TARGET_AMBIGUITY';
  }
  if (isRebindBlockedAction(action)) {
    return 'REBIND_BLOCKED_UNHANDLED';
  }
  if (action.stage === 'BLOCKED') {
    return 'ACTION_BLOCKED';
  }
  if (action.stage === 'FAILED') {
    return 'ACTION_FAILED';
  }
  if (action.stage === 'UNKNOWN') {
    return 'ACTION_UNKNOWN';
  }
  return 'ACTION_ATTENTION';
}

/**
 * 派生单个项目的注意力条目列表
 * @param {object} snapshot - 单个项目的 Status Core 快照
 * @returns {Array<object>}
 */
export function deriveProjectAttentionItems(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.binding) {
    return [];
  }

  const { binding, endpoints = {}, human_intervention = {}, actions = [] } = snapshot;
  const bindingId = binding.binding_id;
  const bindingRev = binding.binding_revision;
  const items = [];

  // 1. Human Intervention 条目 (独立平面)
  if (human_intervention?.active) {
    items.push({
      item_id: `human:${bindingId}:${bindingRev}`,
      binding_id: bindingId,
      binding_revision: bindingRev,
      source_plane: 'human_intervention',
      source_kind: 'HUMAN_INTERVENTION',
      source_id: 'human_intervention',
      source_state: 'ACTIVE',
      source_timestamp: human_intervention.updated_at || null,
      attention_classification: 'HUMAN_INTERVENTION_REQUIRED',
      reason: human_intervention.reason || 'Human decision required',
      updated_at: human_intervention.updated_at || null,
      target_endpoint: null
    });
  }

  // 2. Browser NEW 端点条目
  const browserFact = endpoints.browser;
  if (browserFact?.result_state === 'NEW') {
    items.push({
      item_id: `endpoint:${bindingId}:browser:${browserFact.latest_completed_cursor ?? ''}`,
      binding_id: bindingId,
      binding_revision: bindingRev,
      source_plane: 'endpoint',
      source_kind: 'ENDPOINT',
      source_id: 'browser',
      source_state: 'NEW',
      source_timestamp: browserFact.completed_at ?? null,
      attention_classification: 'ENDPOINT_NEW_RESULT',
      target_endpoint: 'browser',
      role: 'browser',
      provider: binding.browser?.provider || null,
      conversation_id: binding.browser?.conversation_id || null,
      branch: binding.browser?.branch || null,
      cursor: browserFact.latest_completed_cursor ?? null,
      completed_at: browserFact.completed_at ?? null,
      result_ref: browserFact.latest_completed_result?.result_ref || null
    });
  }

  // 3. 多 IDE NEW 端点条目 (每个独立保留 exact source)
  const ideMap = endpoints.ide_endpoints || (endpoints.ide ? { ide: endpoints.ide } : {});
  const ideConfigs = Array.isArray(binding.ide_endpoints)
    ? binding.ide_endpoints
    : (binding.ide ? [{ endpoint_id: 'ide', ...binding.ide }] : []);

  for (const epConfig of ideConfigs) {
    const epId = epConfig.endpoint_id;
    const epFact = ideMap[epId];
    if (epFact?.result_state === 'NEW') {
      items.push({
        item_id: `endpoint:${bindingId}:${epId}:${epFact.latest_completed_cursor ?? ''}`,
        binding_id: bindingId,
        binding_revision: bindingRev,
        source_plane: 'endpoint',
        source_kind: 'ENDPOINT',
        source_id: epId,
        source_state: 'NEW',
        source_timestamp: epFact.completed_at ?? null,
        attention_classification: 'ENDPOINT_NEW_RESULT',
        target_endpoint: epId,
        role: 'ide',
        conversation_id: epConfig.conversation_id || null,
        workspace_identity: epConfig.workspace_identity || null,
        repository_identity: epConfig.repository_identity || null,
        cursor: epFact.latest_completed_cursor ?? null,
        completed_at: epFact.completed_at ?? null,
        result_ref: epFact.latest_completed_result?.result_ref || null
      });
    }
  }

  // 4. Action 注意力条目 (仅 BLOCKED、FAILED、UNKNOWN)
  for (const act of actions) {
    const stage = act.stage;
    if (stage === 'BLOCKED' || stage === 'FAILED' || stage === 'UNKNOWN') {
      const classification = classifyActionAttention(act);
      const evidenceStr = extractActionEvidenceString(act) || null;

      items.push({
        item_id: `action:${bindingId}:${act.action_id}`,
        binding_id: bindingId,
        binding_revision: act.binding_revision ?? bindingRev,
        source_plane: 'action',
        source_kind: 'ACTION',
        source_id: act.action_id,
        source_state: act.stage,
        source_stage: act.stage,
        source_timestamp: act.updated_at || act.created_at || null,
        attention_classification: classification,
        action_id: act.action_id,
        action_type: act.action_type || 'action',
        target_endpoint: act.target_endpoint || null,
        stage: act.stage,
        evidence: evidenceStr,
        created_at: act.created_at || null,
        updated_at: act.updated_at || null
      });
    }
  }

  return items;
}

/**
 * 派生整个注册表或快照列表的 Attention Tray 模型
 * @param {import('../registry/project-registry.js').ProjectRegistry | Array<object>} registryOrSnapshots
 * @returns {object} 只读 Attention Tray 结构
 */
export function deriveAttentionTray(registryOrSnapshots) {
  let snapshots = [];
  if (Array.isArray(registryOrSnapshots)) {
    snapshots = registryOrSnapshots;
  } else if (registryOrSnapshots && typeof registryOrSnapshots.listProjects === 'function') {
    snapshots = registryOrSnapshots.listProjects();
  } else {
    throw new Error('ProjectRegistry instance or snapshot array is required for deriveAttentionTray');
  }

  const allItems = [];
  let unknownEndpointCount = 0;

  for (const snap of snapshots) {
    const projItems = deriveProjectAttentionItems(snap);
    allItems.push(...projItems);

    // 统计 UNKNOWN 端点（保持不收录进 items 列表）
    const endpoints = snap?.endpoints || {};
    if (endpoints.browser?.result_state === 'UNKNOWN') {
      unknownEndpointCount++;
    }
    const ideMap = endpoints.ide_endpoints || (endpoints.ide ? { ide: endpoints.ide } : {});
    for (const epId of Object.keys(ideMap)) {
      if (ideMap[epId]?.result_state === 'UNKNOWN') {
        unknownEndpointCount++;
      }
    }
  }

  // 统计各类别条目数量 (纯展示统计)
  const countsByKind = {
    HUMAN_INTERVENTION: 0,
    ENDPOINT: 0,
    ACTION: 0
  };

  for (const item of allItems) {
    if (countsByKind[item.source_kind] !== undefined) {
      countsByKind[item.source_kind]++;
    }
  }

  return {
    items: allItems,
    total_count: allItems.length,
    counts_by_kind: countsByKind,
    unknown_endpoint_count: unknownEndpointCount,
    has_unknown_endpoints: unknownEndpointCount > 0
  };
}
