/**
 * Endpoint Lifecycle — 端点生命周期变更与安全守卫模块
 * 
 * 领域不变式与守卫策略 (#41):
 * 1. Lifecycle authority 唯一集中由 Core / Registry 编排；
 * 2. 端点轮换 (Rebind) 采用非破坏性代际归档，普通 Rebind 无需确认丢弃标志，
 *    自动将原代际完整事实归档至 retired_generations，并以 Fail-Closed 启动新代际；
 * 3. 严格禁止同目标伪造代际：若轮换目标与当前活跃端点身份完全一致，作为零变更 No-Op 处理；
 * 4. 移除操作 (Remove) 依然维持严格保护守卫，禁止移除至 0 个 IDE 端点；
 * 5. 重绑仅重置被重绑端点事实为 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION，未变端点毫发无损。
 */

import { validateBinding, bumpRevision } from '../controller/binding.js';
import { deriveEndpointResult, createInitialEndpointFact } from './endpoint-ledger.js';

export function executeAddIdeEndpoint({
  binding,
  ideEndpointsMap,
  endpoint_id,
  identity
}) {
  if (!endpoint_id || typeof endpoint_id !== 'string' || !endpoint_id.trim()) {
    throw new Error('Valid endpoint_id is required to add IDE endpoint');
  }
  const cleanId = endpoint_id.trim();
  if (cleanId === 'browser') {
    throw new Error('IDE endpoint_id cannot be "browser"');
  }
  if (ideEndpointsMap.has(cleanId)) {
    throw new Error(`IDE endpoint "${cleanId}" already exists`);
  }
  if (!identity || !identity.conversation_id || !identity.workspace_identity || !identity.repository_identity) {
    throw new Error('identity requires conversation_id, workspace_identity, and repository_identity');
  }

  const now = new Date().toISOString();
  const nextBinding = bumpRevision(binding);
  const newEp = {
    endpoint_id: cleanId,
    endpoint_revision: 1,
    conversation_id: identity.conversation_id,
    workspace_identity: identity.workspace_identity,
    repository_identity: identity.repository_identity
  };
  nextBinding.ide_endpoints.push(newEp);

  const validation = validateBinding(nextBinding);
  if (!validation.valid) {
    throw new Error(`Invalid Add IDE configuration: ${validation.errors.join('; ')}`);
  }

  const newFact = createInitialEndpointFact({
    endpoint: cleanId,
    role: 'ide',
    endpoint_revision: 1,
    updated_at: now
  });

  return { nextBinding, cleanId, newFact, now };
}

export function executeRemoveIdeEndpoint({
  binding,
  ideEndpointsMap,
  resolvedEndpoint,
  options = {}
}) {
  const {
    allow_discard_unhandled = false,
    confirm_replace_unhandled_new = false,
    confirm_replace_unknown = false,
    confirm_replace = false
  } = options;

  if (ideEndpointsMap.size <= 1) {
    throw new Error('Cannot remove the last IDE endpoint; Rally project requires at least one IDE endpoint slot');
  }

  const derivedState = deriveEndpointResult(resolvedEndpoint.fact);
  if (derivedState === 'NEW') {
    const confirmed = allow_discard_unhandled || confirm_replace_unhandled_new || confirm_replace;
    if (!confirmed) {
      throw new Error(
        `Cannot remove IDE endpoint "${resolvedEndpoint.id}" with unhandled NEW result without explicit confirmation (allow_discard_unhandled: true).`
      );
    }
  } else if (derivedState === 'UNKNOWN') {
    const confirmed = allow_discard_unhandled || confirm_replace_unknown || confirm_replace;
    if (!confirmed) {
      throw new Error(
        `Cannot remove IDE endpoint "${resolvedEndpoint.id}" in UNKNOWN state without explicit confirmation (confirm_replace_unknown: true or allow_discard_unhandled: true).`
      );
    }
  }

  const now = new Date().toISOString();
  const nextBinding = bumpRevision(binding);
  nextBinding.ide_endpoints = nextBinding.ide_endpoints.filter(ep => ep.endpoint_id !== resolvedEndpoint.id);

  const validation = validateBinding(nextBinding);
  if (!validation.valid) {
    throw new Error(`Invalid Remove IDE configuration: ${validation.errors.join('; ')}`);
  }

  return { nextBinding, removedId: resolvedEndpoint.id, now };
}

export function executeRebindEndpoint({
  binding,
  resolvedEndpoint,
  identity,
  options = {}
}) {
  if (!identity || typeof identity !== 'object') {
    throw new Error('New endpoint identity must be a valid object');
  }

  const currentFact = resolvedEndpoint.fact;
  const now = new Date().toISOString();

  if (resolvedEndpoint.role === 'browser') {
    if (!identity.conversation_id || typeof identity.conversation_id !== 'string' || !identity.conversation_id.trim()) {
      throw new Error('New browser identity requires valid conversation_id');
    }

    const cleanConversationId = identity.conversation_id.trim();
    const isSameConversation = cleanConversationId === binding.browser?.conversation_id?.trim();
    const rawBranch = identity.branch !== undefined ? identity.branch : identity.branch_name;

    let nextBranch = null;
    if (rawBranch !== undefined && rawBranch !== null) {
      if (typeof rawBranch !== 'string' || !rawBranch.trim()) {
        throw new Error('New browser identity branch must be a non-empty string when supplied');
      }
      nextBranch = rawBranch.trim();
    } else if (rawBranch === null) {
      nextBranch = null;
    } else if (isSameConversation) {
      nextBranch = binding.browser?.branch || null;
    } else {
      nextBranch = null;
    }

    const targetProvider = (identity.provider || binding.browser?.provider || 'chatgpt').trim();
    const currentProvider = (binding.browser?.provider || 'chatgpt').trim();
    const isSameProvider = targetProvider === currentProvider;

    // 严格同目标检测：effective provider、会话 ID 与分支均未变更时，作为零变更 No-Op
    if (isSameProvider && isSameConversation && (nextBranch ?? null) === (binding.browser?.branch ?? null)) {
      return {
        isSameTarget: true,
        targetRole: 'browser',
        targetId: 'browser'
      };
    }

    const nextBinding = bumpRevision(binding);
    const oldRevision = currentFact.endpoint_revision || 1;
    const nextEpRev = oldRevision + 1;

    const retiredGeneration = {
      role: 'browser',
      endpoint_id: 'browser',
      endpoint_revision: oldRevision,
      retired_at: now,
      reason: 'conversation_rotation',
      identity: {
        provider: binding.browser?.provider || null,
        conversation_id: binding.browser?.conversation_id || null,
        branch: binding.browser?.branch || null
      },
      endpoint_fact: {
        ...currentFact,
        endpoint_revision: oldRevision,
        latest_completed_result: currentFact.latest_completed_result
          ? { ...currentFact.latest_completed_result }
          : null,
        continuity: { ...currentFact.continuity }
      }
    };

    nextBinding.browser = {
      provider: identity.provider || binding.browser?.provider || 'chatgpt',
      conversation_id: cleanConversationId,
      branch: nextBranch
    };

    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Rebind configuration: ${validation.errors.join('; ')}`);
    }

    const newBrowserFact = {
      endpoint: 'browser',
      role: 'browser',
      endpoint_revision: nextEpRev,
      latest_completed_cursor: null,
      last_handled_cursor: null,
      completed_at: null,
      latest_completed_result: null,
      continuity: {
        trusted: false,
        unknown_reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      },
      updated_at: now
    };
    return {
      nextBinding,
      newBrowserFact,
      targetRole: 'browser',
      targetId: 'browser',
      retiredGeneration,
      now
    };
  } else {
    if (!identity.conversation_id || !identity.workspace_identity || !identity.repository_identity) {
      throw new Error('New ide identity requires conversation_id, workspace_identity, and repository_identity');
    }
    const targetEpIndex = (binding.ide_endpoints || []).findIndex(e => e.endpoint_id === resolvedEndpoint.id);
    if (targetEpIndex === -1) {
      throw new Error(`Target IDE endpoint "${resolvedEndpoint.id}" not found in binding`);
    }
    const oldEp = binding.ide_endpoints[targetEpIndex];

    // 严格同目标检测：IDE 会话 ID、工作区与仓库均未变更时，作为零变更 No-Op
    const isSameIdeConv = identity.conversation_id.trim() === oldEp.conversation_id?.trim();
    const isSameIdeWs = (identity.workspace_identity?.trim() || null) === (oldEp.workspace_identity?.trim() || null);
    const isSameIdeRepo = (identity.repository_identity?.trim() || null) === (oldEp.repository_identity?.trim() || null);

    if (isSameIdeConv && isSameIdeWs && isSameIdeRepo) {
      return {
        isSameTarget: true,
        targetRole: 'ide',
        targetId: resolvedEndpoint.id
      };
    }

    const nextBinding = bumpRevision(binding);
    const oldEpRev = oldEp.endpoint_revision || 1;
    const nextEpRev = oldEpRev + 1;

    const retiredGeneration = {
      role: 'ide',
      endpoint_id: resolvedEndpoint.id,
      endpoint_revision: oldEpRev,
      retired_at: now,
      reason: 'conversation_rotation',
      identity: {
        conversation_id: oldEp.conversation_id || null,
        workspace_identity: oldEp.workspace_identity || null,
        repository_identity: oldEp.repository_identity || null
      },
      endpoint_fact: {
        ...currentFact,
        endpoint_revision: oldEpRev,
        latest_completed_result: currentFact.latest_completed_result
          ? { ...currentFact.latest_completed_result }
          : null,
        continuity: { ...currentFact.continuity }
      }
    };

    nextBinding.ide_endpoints[targetEpIndex] = {
      endpoint_id: resolvedEndpoint.id,
      endpoint_revision: nextEpRev,
      conversation_id: identity.conversation_id,
      workspace_identity: identity.workspace_identity,
      repository_identity: identity.repository_identity
    };

    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Rebind configuration: ${validation.errors.join('; ')}`);
    }

    const newIdeFact = {
      endpoint: resolvedEndpoint.id,
      role: 'ide',
      endpoint_revision: nextEpRev,
      latest_completed_cursor: null,
      last_handled_cursor: null,
      completed_at: null,
      latest_completed_result: null,
      continuity: {
        trusted: false,
        unknown_reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      },
      updated_at: now
    };

    return {
      nextBinding,
      targetId: resolvedEndpoint.id,
      newIdeFact,
      targetRole: 'ide',
      retiredGeneration,
      now
    };
  }
}
