/**
 * 状态视图模块 (Status View)
 * 提供从规范状态事实派生的机器可读快照 (Snapshot) 与紧凑纯文本视图 (Compact View)
 *
 * 领域不变式 (Domain Invariants):
 * 1. 机器可读快照与紧凑视图源自同一规范真实数据源；
 * 2. 绝不持久化或推断唯一 owner、Baton、next actor 或 "whose turn"；
 * 3. 独立呈现 Browser 与每个 IDE 的 Endpoint Result（支持多端 NEW 并存）；
 * 4. 出现 UNKNOWN 时显式 fail-closed 展示，严禁使用 IDLE；
 * 5. 消除与 status-core 的循环依赖，纯事实派生由 endpoint-ledger 提供。
 */

import { deriveEndpointResult, formatEndpointSnapshot } from './endpoint-ledger.js';

export { formatEndpointSnapshot };

/**
 * 格式化规范机器可读项目快照
 * @param {object} params
 * @param {object} params.binding - Project Binding 对象
 * @param {object} params.endpoints - 端点原始规范事实集，包含 browser 以及 Map 或 Object 形式的 ide_endpoints
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
  const browserFact = endpoints?.browser || null;
  const ideEndpointsMap = {};
  let primaryIdeSnapshot = null;

  if (endpoints?.ide_endpoints) {
    const entries = endpoints.ide_endpoints instanceof Map
      ? endpoints.ide_endpoints.entries()
      : Object.entries(endpoints.ide_endpoints);
    for (const [id, fact] of entries) {
      ideEndpointsMap[id] = formatEndpointSnapshot(fact);
    }
    const ids = Object.keys(ideEndpointsMap);
    if (ids.length === 1) {
      // 恰好 1 个 IDE 端点时，为兼容现有单端读取表面导出 endpoints.ide
      primaryIdeSnapshot = ideEndpointsMap[ids[0]];
    }
  } else if (endpoints?.ide) {
    // 兼容旧形态
    const legacySnapshot = formatEndpointSnapshot(endpoints.ide);
    primaryIdeSnapshot = legacySnapshot;
    if (endpoints.ide.endpoint) {
      ideEndpointsMap[endpoints.ide.endpoint] = legacySnapshot;
    }
  }

  // 格式化 binding 快照
  let bindingSnapshot = null;
  if (binding) {
    const rawIdeList = Array.isArray(binding.ide_endpoints)
      ? binding.ide_endpoints
      : (binding.ide ? [{ endpoint_id: 'ide', endpoint_revision: 1, ...binding.ide }] : []);

    bindingSnapshot = {
      binding_id: binding.binding_id,
      display_name: binding.display_name !== undefined ? binding.display_name : null,
      binding_revision: binding.binding_revision,
      browser: {
        provider: binding.browser?.provider || null,
        conversation_id: binding.browser?.conversation_id || null,
        branch: binding.browser?.branch || binding.browser?.branch_name || null
      },
      ide_endpoints: rawIdeList.map(ep => ({
        endpoint_id: ep.endpoint_id,
        endpoint_revision: ep.endpoint_revision || 1,
        conversation_id: ep.conversation_id || null,
        workspace_identity: ep.workspace_identity || null,
        repository_identity: ep.repository_identity || null
      })),
      // 恰好 1 个 IDE 端点时派生只读兼容字段
      ide: rawIdeList.length === 1 ? {
        conversation_id: rawIdeList[0].conversation_id || null,
        workspace_identity: rawIdeList[0].workspace_identity || null,
        repository_identity: rawIdeList[0].repository_identity || null
      } : null,
      capabilities: Array.isArray(binding.capabilities) ? [...binding.capabilities] : [],
      paused: Boolean(binding.paused)
    };
  }

  return {
    binding: bindingSnapshot,
    endpoints: {
      browser: formatEndpointSnapshot(browserFact),
      ide: primaryIdeSnapshot,
      ide_endpoints: ideEndpointsMap
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

  // 多 IDE 展示
  let idePart = 'IDE: UNKNOWN';
  const ideEndpoints = snapshot.endpoints?.ide_endpoints || {};
  const ideIds = Object.keys(ideEndpoints);
  if (ideIds.length === 1 && snapshot.endpoints?.ide) {
    idePart = `IDE: ${snapshot.endpoints.ide.result_state || 'UNKNOWN'}`;
  } else if (ideIds.length > 0) {
    const segments = ideIds.map(id => `${id}:${ideEndpoints[id]?.result_state || 'UNKNOWN'}`);
    idePart = `IDEs: [${segments.join(', ')}]`;
  }

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

  return `Project [${bId}@rev${bRev}${pausedStr}] Browser: ${browserState} | ${idePart} | ${humanStr} | ${actionStr}`;
}
