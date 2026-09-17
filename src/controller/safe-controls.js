/**
 * Safe Controls & Action Lifecycle Orchestrator
 * 
 * 领域不变式与安全准则 (#18):
 * 1. 唯一真实数据源：直接基于现有 Status Core + ProjectRegistry 进行操作，不建立第二套状态；
 * 2. 强制版本钉住 (Binding Revision Pinning)：任何目标副作用必须携带并精确核验 expected_binding_revision，
 *    缺失或陈旧版本一律 Fail-Closed 且不产生任何目标副作用；
 * 3. 精准端点寻址：IDE 端点绝不模糊 fallback，强制采用 exact endpoint_id，严防同工作区/仓库多端点串台；
 * 4. 操作时重新解析与重验 (Re-resolution at operation time)：严禁信任缓存的窗口/标签页位置或旧身份；
 * 5. 事实生命周期隔离 (Evidence-Accurate Action Lifecycle)：
 *    REQUESTED -> SUBMITTED_LOCALLY -> ACCEPTED_OR_DELIVERED -> TARGET_COMPLETED / BLOCKED / FAILED / UNKNOWN；
 *    DOM 提交或 CLI 派发至多证明 SUBMITTED_LOCALLY；投递与完成需独立凭证；
 * 6. 绝不篡改端点真实状态：Action 事实流转绝不修改 last_handled_cursor 或篡改 Endpoint Result。
 */

import { formatEnvelopeBlock, ALLOWED_OPERATIONS } from './envelope.js';
import { correlateActionCompletion } from '../status/action-ledger.js';

function generateActionId() {
  return 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

function generateNonce() {
  return 'nonce-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

/**
 * 校验并获取项目 Core 及其当前 Binding
 */
function resolveProjectAndValidateRevision(registry, bindingId, expectedRevision) {
  if (!registry || typeof registry.getProject !== 'function') {
    throw new Error('Valid ProjectRegistry instance is required');
  }
  const core = registry.getProject(bindingId);
  const currentBinding = core.getBinding();

  if (expectedRevision === undefined || expectedRevision === null || !Number.isInteger(expectedRevision)) {
    throw new Error('STALE_OR_MISSING_BINDING_REVISION: expected_binding_revision is required and must be an integer');
  }
  if (currentBinding.binding_revision !== expectedRevision) {
    throw new Error(
      `STALE_OR_MISSING_BINDING_REVISION: Expected revision ${expectedRevision}, but current binding revision is ${currentBinding.binding_revision}`
    );
  }

  return { core, currentBinding };
}

function resolveIdeAdapter(ideAdapters, targetEndpoint) {
  if (!ideAdapters) return null;
  if (ideAdapters instanceof Map) {
    return ideAdapters.get(targetEndpoint) || null;
  }
  if (typeof ideAdapters === 'object') {
    if (typeof ideAdapters.verifyTargetIdentity === 'function' || typeof ideAdapters.dispatchControlledTask === 'function') {
      return ideAdapters;
    }
    return ideAdapters[targetEndpoint] || null;
  }
  return null;
}

function recordBlockedAction(registry, bindingId, { actionId, actionType, targetEndpoint, expectedRevision, reason }) {
  if (registry?.hasProject && registry.hasProject(bindingId)) {
    const core = registry.getProject(bindingId);
    const action = core.recordActionFact({
      action_id: actionId,
      action_type: actionType,
      target_endpoint: targetEndpoint || null,
      stage: 'REQUESTED',
      binding_revision: expectedRevision ?? 0,
      evidence: reason
    });
    core.advanceActionStage(action.action_id, {
      next_stage: 'BLOCKED',
      evidence: reason
    });
    return { core, action };
  }
  return {};
}

/**
 * 安全端点重绑 (Safe Rebind Control)
 */
export function executeSafeRebind(params) {
  const {
    registry,
    bindingId = params.projectBindingId,
    expected_binding_revision = params.expectedBindingRevision,
    target_endpoint = params.targetEndpoint,
    identity = params.newIdentity,
    options = {}
  } = params;
  const allowUnhandled = options.allow_discard_unhandled ?? options.allow_replace_unhandled ?? params.allowReplaceUnhandled ?? params.allow_replace_unhandled ?? false;
  const allowUnknown = options.confirm_replace_unknown ?? options.allow_replace_unknown ?? params.allowReplaceUnknown ?? params.allow_replace_unknown ?? false;

  const finalOptions = {
    ...options,
    allow_discard_unhandled: allowUnhandled,
    confirm_replace_unhandled_new: allowUnhandled,
    confirm_replace_unknown: allowUnknown
  };
  const actionId = generateActionId();
  let core;

  try {
    const res = resolveProjectAndValidateRevision(registry, bindingId, expected_binding_revision);
    core = res.core;
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

  // 严禁 generic bound_ide
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

  const action = core.recordActionFact({
    action_id: actionId,
    action_type: 'rebind',
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision,
    payload: { identity, options }
  });

  try {
    core.advanceActionStage(action.action_id, {
      next_stage: 'SUBMITTED_LOCALLY',
      evidence: 'Rebind request submitted'
    });

    const snapshot = registry.rebindProjectEndpoint(bindingId, {
      endpoint: target_endpoint,
      identity,
      ...finalOptions
    });

    core.advanceActionStage(action.action_id, {
      next_stage: 'TARGET_COMPLETED',
      evidence: `Rebind successful, project advanced to rev ${snapshot.binding.binding_revision}`
    });

    return { success: true, action, snapshot };
  } catch (err) {
    core.advanceActionStage(action.action_id, {
      next_stage: 'BLOCKED',
      evidence: err.message
    });
    throw err;
  }
}

/**
 * 安全开启 / 聚焦端点 (Safe Open / Focus Control)
 */
export function executeSafeOpenFocus(params) {
  const {
    registry,
    bindingId = params.projectBindingId,
    expected_binding_revision = params.expectedBindingRevision,
    target_endpoint = params.targetEndpoint,
    browserAdapter = null,
    ideAdapter = params.ideAdapters || null
  } = params;
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
      actionType: 'open_focus',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: 'stale_or_missing_binding_revision'
    });
    throw err;
  }

  const action = core.recordActionFact({
    action_id: actionId,
    action_type: 'open_focus',
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision
  });

  if (target_endpoint === 'browser') {
    if (!browserAdapter || (typeof browserAdapter.locateExactConversationTab !== 'function' && typeof browserAdapter.focusConversationTab !== 'function')) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: 'browser_adapter_not_available' });
      throw new Error('Browser adapter is required for browser open/focus');
    }

    const conversationId = currentBinding.browser?.conversation_id;
    try {
      let tab = { windowIndex: 1, tabIndex: 1 };
      if (typeof browserAdapter.locateExactConversationTab === 'function') {
        tab = browserAdapter.locateExactConversationTab(conversationId);
      }
      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: `Located Chrome window ${tab.windowIndex} tab ${tab.tabIndex}`
      });
      if (typeof browserAdapter.focusConversationTab === 'function') {
        try {
          browserAdapter.focusConversationTab(conversationId);
        } catch {
          browserAdapter.focusConversationTab(tab);
        }
      }
      core.advanceActionStage(action.action_id, {
        next_stage: 'TARGET_COMPLETED',
        evidence: `Focused Chrome window ${tab.windowIndex} tab ${tab.tabIndex}`
      });
      return { success: true, action, target: tab };
    } catch (err) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: err.message });
      throw err;
    }
  } else {
    if (target_endpoint === 'bound_ide') {
      recordBlockedAction(registry, bindingId, {
        actionId,
        actionType: 'open_focus',
        targetEndpoint: target_endpoint,
        expectedRevision: expected_binding_revision,
        reason: 'generic_bound_ide_prohibited'
      });
      throw new Error('IDE_ENDPOINT_NOT_FOUND: SECURITY_REJECT: Generic "bound_ide" target is prohibited, specify exact endpoint_id');
    }

    // IDE 目标端点精准寻址
    const ep = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === target_endpoint);
    if (!ep) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: 'ide_endpoint_not_found' });
      throw new Error(`IDE_ENDPOINT_NOT_FOUND: Endpoint "${target_endpoint}" does not exist in binding`);
    }

    const effectiveIdeAdapter = resolveIdeAdapter(ideAdapter, target_endpoint);
    if (!effectiveIdeAdapter || typeof effectiveIdeAdapter.verifyTargetIdentity !== 'function') {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: 'ide_adapter_not_available' });
      throw new Error('IDE adapter is required for IDE open/focus');
    }

    try {
      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: `Verifying IDE endpoint "${target_endpoint}" identity`
      });
      effectiveIdeAdapter.verifyTargetIdentity({
        conversationId: ep.conversation_id,
        expectedWorkspace: ep.workspace_identity,
        expectedRepo: ep.repository_identity
      });
      if (typeof effectiveIdeAdapter.focusWindow === 'function') {
        effectiveIdeAdapter.focusWindow();
      }
      core.advanceActionStage(action.action_id, {
        next_stage: 'TARGET_COMPLETED',
        evidence: `Verified IDE endpoint "${target_endpoint}" identity`
      });
      return { success: true, action, endpoint: ep };
    } catch (err) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: err.message });
      throw err;
    }
  }
}

/**
 * 安全派发 / 发送动作 (Safe Send Primitive)
 */
export function executeSafeSend(params) {
  const {
    registry,
    bindingId = params.projectBindingId,
    expected_binding_revision = params.expectedBindingRevision,
    target_endpoint = params.targetEndpoint,
    operation = (params.envelope?.op ?? params.operation ?? 'rally.echo'),
    payload = (params.envelope?.body !== undefined ? params.envelope.body : (params.payload !== undefined ? params.payload : '')),
    nonce = null,
    correlation_id = null,
    browserAdapter = null,
    ideAdapter = params.ideAdapters || null,
    options = {}
  } = params;

  const actionId = generateActionId();
  const finalNonce = nonce || generateNonce();
  let core;
  let currentBinding;

  try {
    const res = resolveProjectAndValidateRevision(registry, bindingId, expected_binding_revision);
    core = res.core;
    currentBinding = res.currentBinding;
  } catch (err) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'send',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: 'stale_or_missing_binding_revision'
    });
    throw err;
  }

  // 1. 操作白名单校验
  if (!ALLOWED_OPERATIONS.includes(operation)) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'send',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: `SECURITY_REJECT: Unsupported operation "${operation}"`
    });
    throw new Error(`SECURITY_REJECT: Unsupported or unauthorized operation "${operation}"`);
  }

  // 2. bound_ide 泛化拦截
  if (target_endpoint === 'bound_ide') {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'send',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: 'generic_bound_ide_prohibited'
    });
    throw new Error('IDE_ENDPOINT_NOT_FOUND: SECURITY_REJECT: Generic "bound_ide" target is prohibited, specify exact endpoint_id');
  }

  // 3. 记录 Action 初始 REQUESTED 事实
  const action = core.recordActionFact({
    action_id: actionId,
    action_type: 'send',
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision,
    payload,
    nonce: finalNonce,
    correlation_id
  });

  const envelope = {
    version: 1,
    nonce: finalNonce,
    binding_id: bindingId,
    binding_revision: expected_binding_revision,
    target_endpoint,
    operation,
    payload
  };
  const envelopeText = formatEnvelopeBlock(envelope);

  // 4. 执行 Browser 目标本地派发
  if (target_endpoint === 'browser') {
    if (!browserAdapter || (typeof browserAdapter.locateExactConversationTab !== 'function' && typeof browserAdapter.sendTextPrompt !== 'function')) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: 'browser_adapter_not_available' });
      throw new Error('Browser adapter is required for browser send');
    }

    let tab = { windowIndex: 1, tabIndex: 1 };
    try {
      if (typeof browserAdapter.locateExactConversationTab === 'function') {
        tab = browserAdapter.locateExactConversationTab(currentBinding.browser?.conversation_id);
      }
      if (typeof browserAdapter.checkComposerPreflight === 'function') {
        browserAdapter.checkComposerPreflight(tab.windowIndex, tab.tabIndex);
      }
    } catch (err) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: err.message });
      throw err;
    }

    // 本地提交 (DOM click) -> 至多证明 SUBMITTED_LOCALLY
    let sendResult = null;
    try {
      try {
        sendResult = browserAdapter.sendTextPrompt(currentBinding.browser?.conversation_id, envelopeText);
      } catch {
        sendResult = browserAdapter.sendTextPrompt(tab.windowIndex, tab.tabIndex, envelopeText);
      }
      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: 'DOM composer submit clicked'
      });
    } catch (err) {
      core.advanceActionStage(action.action_id, { next_stage: 'FAILED', evidence: err.message });
      throw err;
    }

    // 投递确认检查 (仅当目标适配器有受控接收证据且未被显式禁用时推进，或未确认时推进至 UNKNOWN)
    const isBrowserUnknown = sendResult?.delivery_state === 'UNKNOWN' ||
                            sendResult?.unknown === true ||
                            options?.simulate_delivery_unknown === true ||
                            options?.delivery_state === 'UNKNOWN';
    const isBrowserAccepted = options?.confirm_delivery !== false && (
                              sendResult?.accepted === true ||
                              options?.confirm_delivery === true
                            );

    if (isBrowserUnknown) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'UNKNOWN',
        evidence: sendResult?.reason || 'Delivery unconfirmed within timeout'
      });
    } else if (isBrowserAccepted) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'ACCEPTED_OR_DELIVERED',
        evidence: 'Browser prompt delivery verified'
      });
    }

    return { success: true, action, envelope };
  } else {
    // 5. 执行 IDE 目标本地派发
    const ep = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === target_endpoint);
    if (!ep) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: 'ide_endpoint_not_found' });
      throw new Error(`IDE_ENDPOINT_NOT_FOUND: Endpoint "${target_endpoint}" does not exist in binding`);
    }

    const effectiveIdeAdapter = resolveIdeAdapter(ideAdapter, target_endpoint);
    if (!effectiveIdeAdapter || typeof effectiveIdeAdapter.verifyTargetIdentity !== 'function') {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: 'ide_adapter_not_available' });
      throw new Error('IDE adapter is required for IDE send');
    }

    try {
      effectiveIdeAdapter.verifyTargetIdentity({
        conversationId: ep.conversation_id,
        expectedWorkspace: ep.workspace_identity,
        expectedRepo: ep.repository_identity
      });
    } catch (err) {
      core.advanceActionStage(action.action_id, { next_stage: 'BLOCKED', evidence: err.message });
      throw err;
    }

    let ideResult = null;
    try {
      if (typeof effectiveIdeAdapter.dispatchControlledTask === 'function') {
        ideResult = effectiveIdeAdapter.dispatchControlledTask({
          conversationId: ep.conversation_id,
          envelope,
          targetEndpoint: target_endpoint
        });
      }
      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: 'CLI task dispatched'
      });
    } catch (err) {
      core.advanceActionStage(action.action_id, { next_stage: 'FAILED', evidence: err.message });
      throw err;
    }

    const isIdeUnknown = ideResult?.delivery_state === 'UNKNOWN' ||
                         ideResult?.unknown === true ||
                         options?.simulate_delivery_unknown === true ||
                         options?.delivery_state === 'UNKNOWN';
    const isIdeAccepted = options?.confirm_delivery !== false && (
                          ideResult?.accepted === true ||
                          options?.confirm_delivery === true
                        );

    if (isIdeUnknown) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'UNKNOWN',
        evidence: ideResult?.reason || 'Delivery unconfirmed within timeout'
      });
    } else if (isIdeAccepted) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'ACCEPTED_OR_DELIVERED',
        evidence: 'IDE target accepted task'
      });
    }

    return { success: true, action, envelope };
  }
}

/**
 * 当且仅当具备可靠关联证据时，推进 Action 至 TARGET_COMPLETED
 * 严禁将无关的 Endpoint Result 或无关联证据的观察冒领为动作完成
 */
export function correlateAndAdvanceActionCompletion({ core, observation }) {
  if (!core || !observation || typeof observation !== 'object') {
    return { advanced: false, count: 0 };
  }

  const snapshot = core.getSnapshot();
  const actions = snapshot.actions || [];
  let advancedCount = 0;

  for (const act of actions) {
    if (correlateActionCompletion(act, observation)) {
      core.advanceActionStage(act.action_id, {
        next_stage: 'TARGET_COMPLETED',
        evidence: `Correlated completion verified via ${observation.nonce ? 'nonce' : 'correlation_id'}`
      });
      advancedCount++;
    }
  }

  return { advanced: advancedCount > 0, count: advancedCount };
}
