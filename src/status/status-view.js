/**
 * 状态视图模块 (Status View)
 * 提供从规范状态事实派生的机器可读快照 (Snapshot) 与紧凑纯文本视图 (Compact View)
 *
 * 领域不变式 (Domain Invariants):
 * 1. 机器可读快照与紧凑视图源自同一规范真实数据源；
 * 2. 绝不持久化或推断唯一 owner、Baton、next actor 或 "whose turn"；
 * 3. 独立呈现 Browser 与 IDE 的 Endpoint Result（支持 Dual NEW 并存）；
 * 4. 出现 UNKNOWN 时显式 fail-closed 展示，严禁使用 IDLE。
 */

import { deriveEndpointResult } from './status-core.js';

/**
 * 格式化单个端点的快照对象，消除端点间的重复结构映射
 * @param {object} endpointFact - 端点规范事实
 * @returns {object|null}
 */
export function formatEndpointSnapshot(endpointFact) {
  if (!endpointFact) {
    return null;
  }
  const isTrusted = Boolean(endpointFact.continuity?.trusted);
  const unknownReason = isTrusted ? null : (endpointFact.continuity?.unknown_reason || null);
  return {
    endpoint: endpointFact.endpoint,
    result_state: deriveEndpointResult(endpointFact),
    latest_completed_cursor: endpointFact.latest_completed_cursor,
    last_handled_cursor: endpointFact.last_handled_cursor,
    completed_at: endpointFact.completed_at,
    continuity: {
      trusted: isTrusted,
      unknown_reason: unknownReason
    },
    unknown_reason: unknownReason,
    updated_at: endpointFact.updated_at
  };
}

/**
 * 格式化规范机器可读项目快照
 * @param {object} params
 * @param {object} params.binding - Project Binding 对象
 * @param {object} params.endpoints - 端点原始规范事实集 { browser, ide }
 * @param {object} params.humanIntervention - 人工介入事实
 * @param {Array} params.actions - 动作事实列表
 * @param {string} params.updatedAt - 更新时间戳
 * @returns {object} 规范机器可读快照
 */
export function formatStatusSnapshot({
  binding,
  endpoints,
  humanIntervention,
  actions = [],
  updatedAt
}) {
  return {
    binding: binding ? {
      binding_id: binding.binding_id,
      binding_revision: binding.binding_revision,
      browser: {
        provider: binding.browser?.provider || null,
        conversation_id: binding.browser?.conversation_id || null
      },
      ide: {
        conversation_id: binding.ide?.conversation_id || null,
        workspace_identity: binding.ide?.workspace_identity || null,
        repository_identity: binding.ide?.repository_identity || null
      },
      capabilities: Array.isArray(binding.capabilities) ? [...binding.capabilities] : [],
      paused: Boolean(binding.paused)
    } : null,
    endpoints: {
      browser: formatEndpointSnapshot(endpoints?.browser),
      ide: formatEndpointSnapshot(endpoints?.ide)
    },
    human_intervention: {
      active: Boolean(humanIntervention?.active),
      reason: humanIntervention?.reason || null,
      updated_at: humanIntervention?.updated_at || null
    },
    actions: actions.map(act => ({ ...act })),
    updated_at: updatedAt || new Date().toISOString()
  };
}

/**
 * 格式化紧凑单行人类可读视图
 * @param {object} snapshot - 规范机器可读快照
 * @returns {string} 紧凑纯文本状态字符串
 */
export function formatCompactStatus(snapshot) {
  if (!snapshot || !snapshot.binding) {
    return 'Project [none] unbound';
  }

  const bId = snapshot.binding.binding_id;
  const bRev = snapshot.binding.binding_revision;
  const pausedStr = snapshot.binding.paused ? ' (PAUSED)' : '';

  const browserState = snapshot.endpoints?.browser?.result_state || 'UNKNOWN';
  const ideState = snapshot.endpoints?.ide?.result_state || 'UNKNOWN';

  let humanStr = 'Human: NONE';
  if (snapshot.human_intervention?.active) {
    humanStr = `Human: REQUIRED${snapshot.human_intervention.reason ? ` (${snapshot.human_intervention.reason})` : ''}`;
  }

  let actionStr = 'Actions: 0';
  const activeActions = snapshot.actions || [];
  if (activeActions.length > 0) {
    const latest = activeActions[activeActions.length - 1];
    actionStr = `Actions: ${activeActions.length} (${latest.action_type || 'action'}: ${latest.stage || 'UNKNOWN'})`;
  }

  return `Project [${bId}@rev${bRev}${pausedStr}] Browser: ${browserState} | IDE: ${ideState} | ${humanStr} | ${actionStr}`;
}
