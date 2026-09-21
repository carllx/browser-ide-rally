/**
 * 状态表面投影模块 (Surface Projection)
 *
 * 领域不变式与规范准则 (#17):
 * 1. 唯一真实数据源：直接从 ProjectRegistry / Status Core 快照派生只读投影，绝不建立第二套可写状态存储；
 * 2. 独立端点呈现：保留 Browser 与所有活跃 IDE 端点独立的 NEW / NO_NEW_RESULT / UNKNOWN 状态；
 * 3. 严格拒绝闲置伪造：UNKNOWN 严禁展示为 IDLE 或与 NO_NEW_RESULT 混淆；
 * 4. 身份防串台可见性：精确暴露 binding_id、binding_revision、Browser 与各 IDE 的会话身份与工作区/仓库身份；
 * 5. 独立平面隔离：Human Intervention 与 Action 事实属于独立平面，不混同为端点状态或泛化为单一 "sent"；
 * 6. 精确端点处理资格：计算 can_mark_handled，仅当端点受信且处于 NEW 并持有有效完成游标时方可触发。
 */

import { deriveLatestResultIndicator } from '../status/ordering-ledger.js';

export { deriveLatestResultIndicator };

/**
 * 计算端点是否具备调用 Mark Handled 的资格
 * @param {object|null} fact - 端点规范事实
 * @returns {boolean}
 */
export function canEndpointMarkHandled(fact) {
  if (!fact || typeof fact !== 'object') return false;
  return Boolean(
    fact.continuity?.trusted &&
    fact.result_state === 'NEW' &&
    fact.latest_completed_cursor !== null &&
    fact.latest_completed_cursor !== undefined
  );
}

/**
 * 投影单个项目的状态表面数据
 * @param {object} snapshot - Status Core 导出的规范快照 (core.getSnapshot())
 * @returns {object} 只读状态表面投影模型
 */
export function projectStatusSurface(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.binding) {
    throw new Error('Valid project status snapshot is required for surface projection');
  }

  const { binding, endpoints = {}, human_intervention = {}, actions = [], updated_at, ordering_evidence = null } = snapshot;

  const orderingEvidence = ordering_evidence;
  const latestResultIndicator = deriveLatestResultIndicator(orderingEvidence);
  const isBrowserLatest = Boolean(orderingEvidence?.certainty === 'DEFINITE' && orderingEvidence?.latest_endpoint === 'browser');

  // 1. Browser 端点投影（显式呈现会话与分支标识，不推断主线或 Baton）
  const browserFact = endpoints.browser || null;
  const browserState = browserFact?.result_state || 'UNKNOWN';
  const browserTrusted = Boolean(browserFact?.continuity?.trusted);
  const browserLatestCursor = browserFact?.latest_completed_cursor ?? null;
  const browserHandledCursor = browserFact?.last_handled_cursor ?? null;
  const browserBranch = binding.browser?.branch || binding.browser?.branch_name || null;

  const browserSlot = {
    endpoint_id: 'browser',
    role: 'browser',
    provider: binding.browser?.provider || null,
    conversation_id: binding.browser?.conversation_id || null,
    branch: browserBranch,
    result_state: browserState,
    latest_completed_cursor: browserLatestCursor,
    last_handled_cursor: browserHandledCursor,
    completed_at: browserFact?.completed_at ?? null,
    result_ref: browserFact?.latest_completed_result?.result_ref || null,
    continuity: {
      trusted: browserTrusted,
      unknown_reason: browserFact?.continuity?.unknown_reason ?? null
    },
    can_mark_handled: canEndpointMarkHandled(browserFact),
    is_latest_result: isBrowserLatest
  };

  // 2. 多 IDE 端点投影
  const rawIdeConfigs = Array.isArray(binding.ide_endpoints)
    ? binding.ide_endpoints
    : (binding.ide ? [{ endpoint_id: 'ide', endpoint_revision: 1, ...binding.ide }] : []);

  const ideEndpointsMap = endpoints.ide_endpoints || (endpoints.ide ? { ide: endpoints.ide } : {});

  // 检查同项目内 IDE 是否共享工作区或仓库
  const workspaceSet = new Set();
  const repoSet = new Set();
  let hasSharedIdeWorkspace = false;
  let hasSharedIdeRepo = false;

  for (const ep of rawIdeConfigs) {
    if (ep.workspace_identity) {
      if (workspaceSet.has(ep.workspace_identity)) hasSharedIdeWorkspace = true;
      workspaceSet.add(ep.workspace_identity);
    }
    if (ep.repository_identity) {
      if (repoSet.has(ep.repository_identity)) hasSharedIdeRepo = true;
      repoSet.add(ep.repository_identity);
    }
  }

  const ideSlots = rawIdeConfigs.map(epConfig => {
    const epId = epConfig.endpoint_id;
    const epFact = ideEndpointsMap[epId] || null;
    const epState = epFact?.result_state || 'UNKNOWN';
    const epTrusted = Boolean(epFact?.continuity?.trusted);
    const epLatestCursor = epFact?.latest_completed_cursor ?? null;
    const epHandledCursor = epFact?.last_handled_cursor ?? null;

    return {
      endpoint_id: epId,
      endpoint_revision: epConfig.endpoint_revision || epFact?.endpoint_revision || 1,
      conversation_id: epConfig.conversation_id || null,
      workspace_identity: epConfig.workspace_identity || null,
      repository_identity: epConfig.repository_identity || null,
      result_state: epState,
      latest_completed_cursor: epLatestCursor,
      last_handled_cursor: epHandledCursor,
      completed_at: epFact?.completed_at ?? null,
      result_ref: epFact?.latest_completed_result?.result_ref || null,
      continuity: {
        trusted: epTrusted,
        unknown_reason: epFact?.continuity?.unknown_reason ?? null
      },
      can_mark_handled: canEndpointMarkHandled(epFact),
      is_latest_result: Boolean(orderingEvidence?.certainty === 'DEFINITE' && orderingEvidence?.latest_endpoint === epId)
    };
  });

  // 3. 人工介入事实平面（独立平面）
  const humanInterventionPlane = {
    active: Boolean(human_intervention?.active),
    reason: human_intervention?.reason ?? null,
    updated_at: human_intervention?.updated_at ?? null
  };

  // 4. Action 动作事实平面（独立平面，保持细粒度生命周期 stage）
  const actionFactsPlane = (Array.isArray(actions) ? actions : []).map(act => ({
    action_id: act.action_id,
    action_type: act.action_type || 'action',
    target_endpoint: act.target_endpoint,
    stage: act.stage || 'UNKNOWN',
    binding_revision: act.binding_revision ?? binding.binding_revision,
    evidence: act.evidence ?? null,
    created_at: act.created_at ?? null,
    updated_at: act.updated_at ?? null
  }));

  return {
    binding_id: binding.binding_id,
    display_name: binding.display_name !== undefined ? binding.display_name : null,
    binding_revision: binding.binding_revision,
    paused: Boolean(binding.paused),
    capabilities: Array.isArray(binding.capabilities) ? [...binding.capabilities] : [],
    browser: browserSlot,
    ide_endpoints: ideSlots,
    ide: ideSlots.length === 1 ? ideSlots[0] : null,
    latest_result_indicator: latestResultIndicator,
    ordering_evidence: orderingEvidence ? { ...orderingEvidence } : null,
    human_intervention: humanInterventionPlane,
    actions: actionFactsPlane,
    disambiguation: {
      has_shared_ide_workspace: hasSharedIdeWorkspace,
      has_shared_ide_repository: hasSharedIdeRepo
    },
    updated_at: updated_at || new Date().toISOString()
  };
}

/**
 * 投影整个注册表的多项目状态表面数据
 * @param {import('../registry/project-registry.js').ProjectRegistry | Array<object>} registryOrSnapshots - 注册表实例或规范快照列表
 * @returns {Array<object>} 具备跨项目防串台注解的多项目状态表面投影列表
 */
export function projectRegistrySurface(registryOrSnapshots) {
  let snapshots = [];
  if (Array.isArray(registryOrSnapshots)) {
    snapshots = registryOrSnapshots;
  } else if (registryOrSnapshots && typeof registryOrSnapshots.listProjects === 'function') {
    snapshots = registryOrSnapshots.listProjects();
  } else {
    throw new Error('ProjectRegistry instance or snapshot array is required for surface projection');
  }

  const projectedList = snapshots.map(s => projectStatusSurface(s));

  // 计算跨项目同名仓库/工作区防串台标记
  const repoCountMap = new Map();
  for (const proj of projectedList) {
    for (const ide of proj.ide_endpoints) {
      if (ide.repository_identity) {
        repoCountMap.set(ide.repository_identity, (repoCountMap.get(ide.repository_identity) || 0) + 1);
      }
    }
  }

  return projectedList.map(proj => {
    let sharedRepoWithOtherProjects = false;
    for (const ide of proj.ide_endpoints) {
      if (ide.repository_identity && (repoCountMap.get(ide.repository_identity) || 0) > 1) {
        sharedRepoWithOtherProjects = true;
        break;
      }
    }
    return {
      ...proj,
      disambiguation: {
        ...proj.disambiguation,
        shared_repo_with_other_projects: sharedRepoWithOtherProjects
      }
    };
  });
}
