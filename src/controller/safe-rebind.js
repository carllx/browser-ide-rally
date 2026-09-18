/**
 * 安全端点重绑定控制原语 (Safe Rebind Primitive)
 * 
 * 核心设计准则 (#14, #18, #21):
 * 1. 严格版本核验：必须携带 expected_binding_revision；
 * 2. 泛化阻断：严禁泛化 "bound_ide"，必须指定 exact target_endpoint；
 * 3. 未处理守卫：目标端点若有 unhandled NEW 或 UNKNOWN 结果，默认拒绝替换，
 *    仅在显式 allow_discard_unhandled: true 时允许覆盖；
 * 4. 事实生命周期：REQUESTED -> SUBMITTED_LOCALLY -> TARGET_COMPLETED。
 */

import {
  generateActionId,
  resolveProjectAndValidateRevision,
  recordBlockedAction
} from './safe-controls-common.js';

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

  const allowReplace = Boolean(
    options.allow_discard_unhandled ||
    options.allow_replace_unhandled ||
    params.allowReplaceUnhandled ||
    params.allowDiscardUnhandled
  );

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

  const action = core.recordActionFact({
    action_id: actionId,
    action_type: 'rebind',
    target_endpoint,
    stage: 'REQUESTED',
    binding_revision: expected_binding_revision,
    payload: { identity }
  });

  // 检查目标端点是否处于 unhandled NEW 或 UNKNOWN 状态
  const snapshot = core.getSnapshot();
  let targetEndpointFact = null;
  if (target_endpoint === 'browser') {
    targetEndpointFact = snapshot.endpoints?.browser;
  } else if (snapshot.endpoints?.ide_endpoints) {
    targetEndpointFact = snapshot.endpoints.ide_endpoints[target_endpoint];
  }

  if (targetEndpointFact) {
    const isNew = targetEndpointFact.result_state === 'NEW';
    const isUnknown = targetEndpointFact.result_state === 'UNKNOWN';

    if ((isNew || isUnknown) && !allowReplace) {
      core.advanceActionStage(action.action_id, {
        next_stage: 'BLOCKED',
        evidence: `Cannot replace ${target_endpoint} endpoint with unhandled ${targetEndpointFact.result_state} result without explicit confirmation`
      });
      throw new Error(
        `Cannot replace ${target_endpoint} endpoint with unhandled ${targetEndpointFact.result_state} result without explicit confirmation`
      );
    }
  }

  try {
    core.advanceActionStage(action.action_id, {
      next_stage: 'SUBMITTED_LOCALLY',
      evidence: `Rebinding endpoint "${target_endpoint}"`
    });

    const updatedSnapshot = registry.rebindProjectEndpoint(bindingId, {
      endpoint_id: target_endpoint,
      target_endpoint,
      identity,
      allow_replace_unhandled: allowReplace,
      allow_discard_unhandled: allowReplace,
      ...options
    });

    core.advanceActionStage(action.action_id, {
      next_stage: 'TARGET_COMPLETED',
      evidence: `Endpoint "${target_endpoint}" successfully rebound to revision ${updatedSnapshot.binding.binding_revision}`
    });

    return {
      success: true,
      action,
      snapshot: updatedSnapshot
    };
  } catch (err) {
    core.advanceActionStage(action.action_id, {
      next_stage: 'BLOCKED',
      evidence: err.message
    });
    throw err;
  }
}
