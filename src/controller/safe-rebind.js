/**
 * 安全端点重绑定控制原语 (Safe Rebind Primitive)
 * 
 * 核心设计准则 (#14, #18, #21, #41):
 * 1. 严格版本核验：必须携带 expected_binding_revision，防止并发竞态覆盖；
 * 2. 泛化阻断：严禁泛化 "bound_ide"，必须指定 exact target_endpoint；
 * 3. 非破坏性会话轮换 (#41)：普通 Rebind 不再阻断于 NEW/UNKNOWN 状态，
 *    自动将原代际事实归档至 retired_generations 并以 Fail-Closed 启动新代际；
 *    历史 discard/confirmation 选项仅保留用于内部兼容，语义上不再作为安全授权；
 * 4. 同目标零变更守卫：若新身份与当前活跃端点完全一致，作为零变更 No-Op 执行；
 * 5. 事实生命周期：REQUESTED -> SUBMITTED_LOCALLY -> TARGET_COMPLETED / BLOCKED。
 */

import {
  generateActionId,
  resolveProjectAndValidateRevision,
  recordBlockedAction
} from './safe-controls-common.js';
import {
  normalizeChatGPTConversationInput
} from '../surface/chatgpt-conversation-parser.js';

/**
 * 执行安全端点重绑定
 * @param {object} params
 * @returns {{ success: boolean, action: object, snapshot: object }}
 */
export function executeSafeRebind(params) {
  const {
    registry,
    bindingId = params.projectBindingId,
    expected_binding_revision = params.expectedBindingRevision,
    target_endpoint = params.targetEndpoint,
    identity = params.identity || params.newIdentity,
    options = {}
  } = params;

  // 遗留兼容字段（仅向后兼容传参，普通 Rebind 语义上不再用于拦截）
  const allowReplaceNew = Boolean(
    options.allow_discard_unhandled ||
    options.allow_replace_unhandled ||
    options.confirm_replace_unhandled_new ||
    params.allowReplaceUnhandled ||
    params.allowDiscardUnhandled
  );

  const allowReplaceUnknown = Boolean(
    options.allow_replace_unknown ||
    options.confirm_replace_unknown ||
    options.allow_discard_unhandled ||
    options.allow_replace_unhandled ||
    params.allowReplaceUnknown ||
    params.allowReplaceUnhandled ||
    params.allowDiscardUnhandled
  );

  let cleanIdentity = identity;
  if (identity && typeof identity === 'object') {
    let convId = identity.conversation_id;
    if (target_endpoint === 'browser' && convId) {
      convId = normalizeChatGPTConversationInput(convId);
    }
    cleanIdentity = {
      ...identity,
      conversation_id: convId,
      workspace_identity: identity.workspace_identity || identity.workspace,
      repository_identity: identity.repository_identity || identity.repository
    };
  }

  const actionId = generateActionId();
  let core;
  let currentBinding;

  try {
    const res = resolveProjectAndValidateRevision(registry, bindingId, expected_binding_revision);
    core = res.core;
    currentBinding = res.currentBinding;
  } catch (err) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'rebind',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: 'stale_or_missing_binding_revision'
    });
    throw err;
  }

  // 严禁泛化 bound_ide
  if (target_endpoint === 'bound_ide') {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'rebind',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: 'generic_bound_ide_prohibited'
    });
    throw new Error('IDE_ENDPOINT_NOT_FOUND: SECURITY_REJECT: Generic "bound_ide" target is prohibited, specify exact endpoint_id');
  }

  // 目标端点存在性校验（在创建 Action 之前校验）
  const snapshotBefore = core.getSnapshot();
  let targetEndpointFact = null;
  if (target_endpoint === 'browser') {
    targetEndpointFact = snapshotBefore.endpoints?.browser;
  } else if (snapshotBefore.endpoints?.ide_endpoints) {
    targetEndpointFact = snapshotBefore.endpoints.ide_endpoints[target_endpoint];
  }

  if (!targetEndpointFact) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'rebind',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: `Target endpoint "${target_endpoint}" does not exist in project binding`
    });
    throw new Error(`Target endpoint "${target_endpoint}" does not exist in project binding`);
  }

  // === 关键前置检测：Exact Same-Target 检测（在创建 Action 之前完成） ===
  // 必须使用有效身份完全比对：
  // Browser: effective provider + conversation + branch
  // IDE: conversation_id + workspace_identity + repository_identity
  let isExactSameTarget = false;
  if (target_endpoint === 'browser') {
    if (cleanIdentity && typeof cleanIdentity === 'object' && cleanIdentity.conversation_id) {
      const currentBr = currentBinding.browser || {};
      const currentProvider = (currentBr.provider || 'chatgpt').trim();
      const currentConv = (currentBr.conversation_id || '').trim();
      const currentBranch = currentBr.branch ? currentBr.branch.trim() : null;

      const targetProvider = (cleanIdentity.provider || currentProvider).trim();
      const targetConv = cleanIdentity.conversation_id.trim();
      const rawBranch = cleanIdentity.branch !== undefined ? cleanIdentity.branch : cleanIdentity.branch_name;
      let targetBranch = currentBranch;
      if (rawBranch !== undefined) {
        targetBranch = (rawBranch !== null && typeof rawBranch === 'string') ? rawBranch.trim() : null;
      }

      if (
        targetProvider === currentProvider &&
        targetConv === currentConv &&
        targetBranch === currentBranch
      ) {
        isExactSameTarget = true;
      }
    }
  } else {
    // IDE 端点
    const currentIde = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === target_endpoint);
    if (currentIde && cleanIdentity && typeof cleanIdentity === 'object' && cleanIdentity.conversation_id) {
      const isSameConv = cleanIdentity.conversation_id.trim() === (currentIde.conversation_id || '').trim();
      const isSameWs = (cleanIdentity.workspace_identity?.trim() || null) === (currentIde.workspace_identity?.trim() || null);
      const isSameRepo = (cleanIdentity.repository_identity?.trim() || null) === (currentIde.repository_identity?.trim() || null);

      if (isSameConv && isSameWs && isSameRepo) {
        isExactSameTarget = true;
      }
    }
  }

  if (isExactSameTarget) {
    // 绝对零变更 No-Op：
    // 不创建 Action、不修改 updated_at、不改变 binding_revision、不改变 endpoint_revision/fact、不追加退役历史。
    return {
      success: true,
      action: null,
      snapshot: snapshotBefore,
      is_same_target: true
    };
  }

  const action = core.recordActionFact({
    action_id: actionId,
    action_type: 'rebind',
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision,
    payload: { identity: cleanIdentity }
  });

  try {
    core.advanceActionStage(action.action_id, {
      next_stage: 'SUBMITTED_LOCALLY',
      evidence: `Rebinding endpoint "${target_endpoint}"`
    });

    const updatedSnapshot = registry.rebindProjectEndpoint(bindingId, {
      endpoint_id: target_endpoint,
      target_endpoint,
      identity: cleanIdentity,
      allow_replace_unhandled: allowReplaceNew,
      allow_discard_unhandled: allowReplaceNew,
      confirm_replace_unhandled_new: allowReplaceNew,
      allow_replace_unknown: allowReplaceUnknown,
      confirm_replace_unknown: allowReplaceUnknown,
      ...options
    });

    const evidence = `Endpoint "${target_endpoint}" successfully rebound to revision ${updatedSnapshot.binding.binding_revision}`;

    core.advanceActionStage(action.action_id, {
      next_stage: 'TARGET_COMPLETED',
      evidence
    });

    return {
      success: true,
      action,
      snapshot: updatedSnapshot,
      is_same_target: false
    };
  } catch (err) {
    core.advanceActionStage(action.action_id, {
      next_stage: 'BLOCKED',
      evidence: err.message
    });
    throw err;
  }
}
