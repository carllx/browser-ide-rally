/**
 * 安全派发 / 发送动作控制原语 (Safe Send Control Primitive)
 * 
 * 核心设计准则 (#18):
 * 1. 统一 Send Schema：全链路使用 typed payload { text }，隔离旧兼容字段；
 * 2. 精确 Envelope 钉住：携带 binding_id, binding_revision, target_endpoint, endpoint_revision；
 * 3. 真实副作用与投递凭据保真：
 *    - 本地 DOM click 或 CLI 派发成功仅能证明 SUBMITTED_LOCALLY；
 *    - 不将本地 submission 的 accepted:true 当作投递确认；
 *    - 不使用调用方选项（如 confirm_delivery）伪造阶段；
 *    - 仅从独立证明的提供者信号推进至 ACCEPTED_OR_DELIVERED；
 *    - 仅从真实超时/不确定性凭据推进至 UNKNOWN，且绝无隐式重试；
 * 4. IDE 派发守卫：若未实际运行 dispatch 方法，绝不进入 SUBMITTED_LOCALLY。
 */

import {
  ALLOWED_OPERATIONS,
  formatEnvelopeBlock
} from './envelope.js';
import {
  generateActionId,
  generateNonce,
  resolveProjectAndValidateRevision,
  recordBlockedAction,
  resolveIdeAdapter
} from './safe-controls-common.js';

/**
 * 执行安全动作发送
 * @param {object} params
 * @returns {{ success: boolean, action: object, envelope: object }}
 */
export function executeSafeSend(params) {
  const {
    registry,
    bindingId = params.projectBindingId,
    expected_binding_revision = params.expectedBindingRevision,
    target_endpoint = params.targetEndpoint,
    action_type = params.action_type || params.actionType || 'send',
    browserAdapter = null,
    ideAdapter = params.ideAdapters || null,
    options = {}
  } = params;

  // 统一 Schema：优先提取 typed payload 对象
  const operation = (params.envelope?.op ?? params.operation ?? 'rally.echo');
  let normalizedPayload = params.envelope?.payload ?? params.payload;
  if (normalizedPayload === undefined && params.envelope?.body !== undefined) {
    normalizedPayload = { text: String(params.envelope.body) };
  } else if (typeof normalizedPayload === 'string') {
    normalizedPayload = { text: normalizedPayload };
  } else if (!normalizedPayload || typeof normalizedPayload !== 'object') {
    normalizedPayload = { text: String(normalizedPayload || '') };
  }

  const actionId = generateActionId();
  const finalNonce = params.nonce || generateNonce();
  let core;
  let currentBinding;

  try {
    const res = resolveProjectAndValidateRevision(registry, bindingId, expected_binding_revision);
    core = res.core;
    currentBinding = res.currentBinding;
  } catch (err) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: action_type,
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
      actionType: action_type,
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
      actionType: action_type,
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: 'generic_bound_ide_prohibited'
    });
    throw new Error('IDE_ENDPOINT_NOT_FOUND: SECURITY_REJECT: Generic "bound_ide" target is prohibited, specify exact endpoint_id');
  }

  // 3. 构造精准 Envelope (携带 binding_id, revision, target_endpoint, endpoint_revision)
  const envelope = {
    version: 1,
    nonce: finalNonce,
    binding_id: bindingId,
    binding_revision: expected_binding_revision,
    target_endpoint,
    operation,
    payload: normalizedPayload
  };

  let envelopeText = '';
  try {
    // 若为 IDE 端点，钉住 endpoint_revision
    if (target_endpoint !== 'browser') {
      const ep = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === target_endpoint);
      if (ep && ep.endpoint_revision !== undefined) {
        envelope.endpoint_revision = ep.endpoint_revision;
      }
    }
    envelopeText = formatEnvelopeBlock(envelope);
  } catch (err) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: action_type,
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason: err.message
    });
    throw err;
  }

  const action = core.recordActionFact({
    action_id: actionId,
    action_type: action_type,
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision,
    payload: normalizedPayload,
    nonce: finalNonce
  });

  if (target_endpoint === 'browser') {
    if (!browserAdapter || typeof browserAdapter.sendTextPrompt !== 'function') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'browser_adapter_not_available'
      });
      throw new Error('Browser adapter with sendTextPrompt is required for browser send');
    }

    const conversationId = currentBinding.browser?.conversation_id;
    if (!conversationId) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'no_bound_browser_conversation'
      });
      throw new Error('No browser conversation bound in project binding');
    }

    // 预检 Composer Preflight
    if (typeof browserAdapter.checkComposerPreflight === 'function') {
      try {
        const preflight = browserAdapter.checkComposerPreflight(conversationId);
        if (preflight && preflight.ready === false) {
          const reason = preflight.reason || 'composer_not_ready';
          core.advanceActionStage(action.action_id, {
            next_stage: 'BLOCKED',
            evidence: `PREFLIGHT_BLOCKED: ${reason}`
          });
          throw new Error(`PREFLIGHT_BLOCKED: ${reason}`);
        }
      } catch (err) {
        if (!err.message.startsWith('PREFLIGHT_BLOCKED')) {
          core.advanceActionStage(action.action_id, {
            next_stage: 'BLOCKED',
            evidence: err.message
          });
        }
        throw err;
      }
    }

    // 执行本地提交 (DOM click) -> 严格仅能推进至 SUBMITTED_LOCALLY
    let sendResult = null;
    try {
      sendResult = browserAdapter.sendTextPrompt(conversationId, envelopeText);
      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: 'DOM composer submit clicked'
      });
    } catch (err) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'FAILED',
        evidence: err.message
      });
      throw err;
    }

    // 投递确认检查：仅从独立证明的提供者/投递凭据推进
    if (sendResult?.delivery_proven === true) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'ACCEPTED_OR_DELIVERED',
        evidence: sendResult.delivery_evidence || 'Browser prompt delivery verified by provider'
      });
    } else if (sendResult?.delivery_state === 'UNKNOWN') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'UNKNOWN',
        evidence: sendResult.reason || 'Delivery unconfirmed within timeout'
      });
    }

    return { success: true, action, envelope };
  } else {
    // IDE 目标本地派发
    const ep = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === target_endpoint);
    if (!ep) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'ide_endpoint_not_found'
      });
      throw new Error(`IDE_ENDPOINT_NOT_FOUND: Endpoint "${target_endpoint}" does not exist in binding`);
    }

    const effectiveIdeAdapter = resolveIdeAdapter(ideAdapter, target_endpoint);
    if (!effectiveIdeAdapter || typeof effectiveIdeAdapter.verifyTargetIdentity !== 'function') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'ide_adapter_not_available'
      });
      throw new Error('IDE adapter is required for IDE send');
    }

    try {
      effectiveIdeAdapter.verifyTargetIdentity({
        conversationId: ep.conversation_id,
        expectedWorkspace: ep.workspace_identity,
        expectedRepo: ep.repository_identity
      });
    } catch (err) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: err.message
      });
      throw err;
    }

    // 关键守卫：必须存在实际的派发方法，否则绝不进入 SUBMITTED_LOCALLY
    if (typeof effectiveIdeAdapter.dispatchControlledTask !== 'function') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: 'ide_dispatch_method_not_implemented'
      });
      throw new Error(`DISPATCH_NOT_SUPPORTED: IDE adapter for "${target_endpoint}" does not implement dispatchControlledTask`);
    }

    let ideResult = null;
    try {
      ideResult = effectiveIdeAdapter.dispatchControlledTask({
        conversationId: ep.conversation_id,
        envelope,
        targetEndpoint: target_endpoint
      });
      core.advanceActionStage(action.action_id, {
        next_stage: 'SUBMITTED_LOCALLY',
        evidence: 'CLI task dispatched'
      });
    } catch (err) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'FAILED',
        evidence: err.message
      });
      throw err;
    }

    // 投递确认检查：仅从独立证明的提供者/投递凭据推进
    if (ideResult?.delivery_proven === true) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'ACCEPTED_OR_DELIVERED',
        evidence: ideResult.delivery_evidence || 'IDE target accepted task'
      });
    } else if (ideResult?.delivery_state === 'UNKNOWN') {
      core.advanceActionStage(action.action_id, {
        next_stage: 'UNKNOWN',
        evidence: ideResult.reason || 'Delivery unconfirmed within timeout'
      });
    }

    return { success: true, action, envelope };
  }
}
