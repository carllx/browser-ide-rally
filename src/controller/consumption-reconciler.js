/**
 * 消费验证自动处理协调模块 (Verified-Consumption Reconciler)
 * 
 * 核心契约 (Spec #12 amendment 5738217235 / Contract 5738217513):
 * 1. 仅当 Continue 动作形成时源端点处于规范 NEW 时具备消费处理资格；
 * 2. 必须具备完备强关联凭据并在目标端点可靠达成 ACCEPTED_OR_DELIVERED；
 * 3. 严格执行 11 重强校验，任何漂移（游标、材料、绑定版本、端点身份等）严格 Fail-Closed；
 * 4. 绝不回填旧游标，绝不创建额外 Action 事实；
 * 5. 校验通过后直接调用 core.markEndpointHandled 推进源端点 handled 状态。
 */

/**
 * 调和并推进已验证消费的源端点 handled 状态
 * @param {object} params
 * @param {object} params.core - ProjectStatusCore 实例
 * @param {object} params.action - 当前 Action 事实
 * @param {object} [params.consumptionContext] - 仅限内部流转的消费凭证上下文
 * @returns {{ reconciled: boolean, handled_cursor?: string|null, reason?: string }}
 */
export function reconcileVerifiedConsumption({ core, action, consumptionContext } = {}) {
  if (!core || typeof core.getSnapshot !== 'function' || typeof core.markEndpointHandled !== 'function') {
    return { reconciled: false, reason: 'invalid_status_core' };
  }

  if (!action || typeof action !== 'object') {
    return { reconciled: false, reason: 'missing_action' };
  }

  // 1. 仅对 continue 类型动作且进入 ACCEPTED_OR_DELIVERED 阶段执行消费调和
  if (action.action_type !== 'continue') {
    return { reconciled: false, reason: 'action_not_continue' };
  }
  if (action.stage !== 'ACCEPTED_OR_DELIVERED') {
    return { reconciled: false, reason: 'action_stage_not_accepted_or_delivered' };
  }

  // 2. 消费资格校验：无消费上下文或形成时非 NEW 则绝不执行自动处理
  if (!consumptionContext || consumptionContext.eligible !== true) {
    return { reconciled: false, reason: 'not_eligible_for_auto_handled' };
  }

  const snapshot = core.getSnapshot();
  const currentBinding = snapshot.binding;

  // 3. 绑定与版本强校验
  if (currentBinding.binding_id !== consumptionContext.binding_id) {
    return { reconciled: false, reason: 'binding_id_mismatch' };
  }
  if (currentBinding.binding_revision !== consumptionContext.binding_revision) {
    return { reconciled: false, reason: 'binding_revision_stale' };
  }

  // 4. 目标端点校验
  if (action.target_endpoint !== consumptionContext.target_endpoint) {
    return { reconciled: false, reason: 'target_endpoint_mismatch' };
  }

  // 5. 源端点与源端版本核验
  const sourceId = consumptionContext.source_endpoint;
  let sourceFact = null;

  if (sourceId === 'browser') {
    sourceFact = snapshot.endpoints.browser;
  } else {
    sourceFact = snapshot.endpoints.ide_endpoints?.[sourceId] || null;
    const ideBinding = (currentBinding.ide_endpoints || []).find(e => e.endpoint_id === sourceId);
    if (!ideBinding) {
      return { reconciled: false, reason: 'source_endpoint_not_in_binding' };
    }
    if (consumptionContext.source_endpoint_revision !== undefined &&
        ideBinding.endpoint_revision !== consumptionContext.source_endpoint_revision) {
      return { reconciled: false, reason: 'source_endpoint_revision_stale' };
    }
  }

  if (!sourceFact) {
    return { reconciled: false, reason: 'source_fact_not_found' };
  }

  // 6. 源端点受信任度与当前状态校验
  if (sourceFact.continuity?.trusted !== true) {
    return { reconciled: false, reason: 'source_continuity_not_trusted' };
  }
  if (sourceFact.result_state !== 'NEW') {
    return { reconciled: false, reason: 'source_not_currently_new' };
  }

  // 7. 游标与结果材料完全匹配校验（防漂移）
  const currentCursor = sourceFact.latest_completed_cursor ?? null;
  if (currentCursor !== consumptionContext.expected_cursor) {
    return { reconciled: false, reason: 'source_cursor_drifted' };
  }

  const currentResultRef = sourceFact.latest_completed_result?.result_ref ?? null;
  if (consumptionContext.expected_result_ref !== undefined &&
      currentResultRef !== consumptionContext.expected_result_ref) {
    return { reconciled: false, reason: 'source_result_ref_drifted' };
  }

  // 8. 调用已有规范方法推进 handled，绝不回填，绝不创建额外 Action
  const markResult = core.markEndpointHandled(sourceId, {
    expected_cursor: consumptionContext.expected_cursor
  });

  if (markResult.success) {
    return {
      reconciled: true,
      handled_cursor: markResult.handled_cursor
    };
  }

  return {
    reconciled: false,
    reason: markResult.reason || 'mark_handled_failed'
  };
}
