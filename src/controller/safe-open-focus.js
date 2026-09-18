/**
 * 安全开启 / 聚焦端点控制原语 (Safe Open / Focus Control Primitive)
 * 
 * 核心设计准则 (#18):
 * 1. 严格版本核验：expected_binding_revision 必须匹配；
 * 2. 泛化阻断：严禁泛化 "bound_ide"，保持单动作事实唯一性（每 action_id 仅一条事实）；
 * 3. 真实副作用凭据：仅在实际执行了真实窗口/标签聚焦操作且取得凭据时方可推进至 TARGET_COMPLETED；
 *    仅定位或仅核验身份绝不能到达 TARGET_COMPLETED；
 * 4. 规范 Browser 接口：采用 conversationId 寻址，不回退至坐标签名。
 */

import {
  generateActionId,
  resolveProjectAndValidateRevision,
  recordBlockedAction,
  resolveIdeAdapter
} from './safe-controls-common.js';

/**
 * 执行安全端点开启与聚焦
 * @param {object} params
 * @returns {{ success: boolean, action: object, target?: object, endpoint?: object }}
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

  // 泛化 bound_ide 阻断：在记录主 Action 之前直接记录单次 BLOCKED 事实，防止重复 actionId
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

  const action = core.recordActionFact({
    action_id: actionId,
    action_type: 'open_focus',
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision
  });

  if (target_endpoint === 'browser') {
    if (!browserAdapter || typeof browserAdapter.focusConversationTab !== 'function') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'browser_adapter_not_available'
      });
      throw new Error('Browser adapter with focusConversationTab is required for browser open/focus');
    }

    const conversationId = currentBinding.browser?.conversation_id;
    if (!conversationId) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'no_bound_browser_conversation'
      });
      throw new Error('No browser conversation bound in project binding');
    }

    try {
      let tab = null;
      if (typeof browserAdapter.locateExactConversationTab === 'function') {
        tab = browserAdapter.locateExactConversationTab(conversationId);
      }

      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: `Locating and focusing browser conversation "${conversationId}"`
      });

      // 规范单一控制接口：按 conversationId 聚焦，严禁坐标回退
      const focusRes = browserAdapter.focusConversationTab(conversationId);

      // 副作用真实性凭据校验：必须实际执行了聚焦
      if (!focusRes || focusRes.focused !== true) {
        const failureReason = focusRes?.reason || 'Browser tab focus not confirmed';
        core.advanceActionStage(action.action_id, {
          next_stage: 'FAILED',
          evidence: failureReason
        });
        const failErr = new Error(`FOCUS_FAILED: ${failureReason}`);
        failErr.actionStage = 'FAILED';
        throw failErr;
      }

      core.advanceActionStage(action.action_id, {
        next_stage: 'TARGET_COMPLETED',
        evidence: `Focused Chrome window ${focusRes.windowIndex ?? ''} tab ${focusRes.tabIndex ?? ''}`.trim()
      });

      return { success: true, action, target: focusRes };
    } catch (err) {
      const isTerminal = action.stage === 'FAILED' || action.stage === 'BLOCKED' || action.stage === 'TARGET_COMPLETED';
      if (!isTerminal) {
        const isBlocked = err.message.includes('NO_EXACT_CONVERSATION_TAB') ||
                          err.message.includes('AMBIGUOUS_CONVERSATION_TAB') ||
                          err.message.includes('CONVERSATION_ID_REQUIRED') ||
                          err.message.includes('not found') ||
                          err.message.includes('SECURITY_REJECT');
        const nextStage = isBlocked ? 'BLOCKED' : 'FAILED';
        core.advanceActionStage(action.action_id, {
          next_stage: nextStage,
          evidence: err.message
        });
        err.actionStage = nextStage;
      } else {
        err.actionStage = action.stage;
      }
      throw err;
    }
  } else {
    // IDE 目标端点精准寻址
    const ep = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === target_endpoint);
    if (!ep) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'ide_endpoint_not_found'
      });
      const notFoundErr = new Error(`IDE_ENDPOINT_NOT_FOUND: Endpoint "${target_endpoint}" does not exist in binding`);
      notFoundErr.actionStage = 'BLOCKED';
      throw notFoundErr;
    }

    const effectiveIdeAdapter = resolveIdeAdapter(ideAdapter, target_endpoint);
    if (!effectiveIdeAdapter || typeof effectiveIdeAdapter.verifyTargetIdentity !== 'function') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'ide_adapter_not_available'
      });
      const noAdapterErr = new Error('IDE adapter is required for IDE open/focus');
      noAdapterErr.actionStage = 'BLOCKED';
      throw noAdapterErr;
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

      // 真实聚焦凭据：必须提供并成功执行 focusWindow
      if (typeof effectiveIdeAdapter.focusWindow !== 'function') {
        core.advanceActionStage(action.action_id, {
          next_stage: 'BLOCKED',
          evidence: 'ide_focus_method_not_implemented'
        });
        const notSupportedErr = new Error(`FOCUS_NOT_SUPPORTED: IDE adapter for "${target_endpoint}" does not implement focusWindow`);
        notSupportedErr.actionStage = 'BLOCKED';
        throw notSupportedErr;
      }

      const focusRes = effectiveIdeAdapter.focusWindow();
      if (!focusRes || focusRes.focused !== true) {
        const failureReason = focusRes?.reason || 'IDE window focus not confirmed';
        core.advanceActionStage(action.action_id, {
          next_stage: 'FAILED',
          evidence: failureReason
        });
        const failErr = new Error(`FOCUS_FAILED: ${failureReason}`);
        failErr.actionStage = 'FAILED';
        throw failErr;
      }

      core.advanceActionStage(action.action_id, {
        next_stage: 'TARGET_COMPLETED',
        evidence: `Focused IDE window for endpoint "${target_endpoint}"`
      });

      return { success: true, action, endpoint: ep, focusResult: focusRes };
    } catch (err) {
      const isTerminal = action.stage === 'FAILED' || action.stage === 'BLOCKED' || action.stage === 'TARGET_COMPLETED';
      if (!isTerminal) {
        const isBlocked = err.message.includes('IDENTITY_MISMATCH') ||
                          err.message.includes('IDENTITY_VERIFY_FAIL') ||
                          err.message.includes('not found') ||
                          err.message.includes('SECURITY_REJECT');
        const nextStage = isBlocked ? 'BLOCKED' : 'FAILED';
        core.advanceActionStage(action.action_id, {
          next_stage: nextStage,
          evidence: err.message
        });
        err.actionStage = nextStage;
      } else {
        err.actionStage = action.stage;
      }
      throw err;
    }
  }
}
