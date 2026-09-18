/**
 * 安全一键继续控制原语 (Safe One-Click Continue Control Primitive)
 * 
 * 核心契约与安全边界 (Issue #19 / Browser Mission Contract 5726437868 & 5726654452):
 * 1. 用户显式指定目标端点；绝对不推断 Baton / owner / next-actor；
 * 2. 唯允许同项目 exact source endpoint 的可靠未处理 NEW 作为自动上下文；
 * 3. 多 IDE 目标为 Browser 时，必须提供确切的 source_endpoint，严禁 sibling 聚合或首个/最新推断；
 * 4. 防漂移与上下文状态锁定 (Locking Source Snapshot)：
 *    UI 形成请求时记录的 expected_source_result_state, expected_source_cursor,
 *    expected_source_result_ref 若与执行时不一致，严格 fail-closed BLOCKED；
 * 5. 确定性 Outbound Bundle：标准 rally.prompt 操作，携带确定性 text 与 provenance；
 * 6. 载荷超限防御：超过 typed-envelope payload 边界 (64KB) 时严格 BLOCKED，绝不静默截断；
 * 7. 单一规范 Action 事实：委托 executeSafeSend 执行，action_type 固定为 'continue'；
 * 8. 绝对禁止自动 Mark handled。
 */

import {
  generateActionId,
  resolveProjectAndValidateRevision,
  recordBlockedAction
} from './safe-controls-common.js';
import { executeSafeSend } from './safe-send.js';
import { MAX_PAYLOAD_BYTES } from './envelope.js';

export function executeSafeContinue(params = {}) {
  const {
    registry,
    bindingId = params.projectBindingId,
    expected_binding_revision = params.expectedBindingRevision,
    target_endpoint = params.targetEndpoint,
    source_endpoint = params.sourceEndpoint,
    expected_source_result_state,
    expected_source_cursor,
    expected_source_result_ref,
    browserAdapter = null,
    ideAdapter = params.ideAdapters || null
  } = params;

  const actionId = generateActionId();

  function blockAndThrow(reason) {
    recordBlockedAction(registry, bindingId, {
      actionId,
      actionType: 'continue',
      targetEndpoint: target_endpoint,
      expectedRevision: expected_binding_revision,
      reason
    });
    throw new Error(reason);
  }

  // 1. 基础参数与版本核验
  let core;
  let currentBinding;
  try {
    const res = resolveProjectAndValidateRevision(registry, bindingId, expected_binding_revision);
    core = res.core;
    currentBinding = res.currentBinding;
  } catch (err) {
    blockAndThrow(err.message || 'stale_or_missing_binding_revision');
  }

  const snapshot = core.getSnapshot();
  const ideEndpoints = currentBinding.ide_endpoints || [];

  // 2. 目标与源端点精确解析
  let resolvedSource = null;
  let sourceEpRev = 1;

  if (target_endpoint === 'browser') {
    if (source_endpoint) {
      const match = ideEndpoints.find(e => e.endpoint_id === source_endpoint);
      if (!match) {
        blockAndThrow(`INVALID_SOURCE_ENDPOINT: source_endpoint "${source_endpoint}" does not exist in binding`);
      }
      resolvedSource = source_endpoint;
      sourceEpRev = match.endpoint_revision || 1;
    } else {
      if (ideEndpoints.length === 1) {
        resolvedSource = ideEndpoints[0].endpoint_id;
        sourceEpRev = ideEndpoints[0].endpoint_revision || 1;
      } else {
        blockAndThrow('SOURCE_ENDPOINT_REQUIRED: Target is browser but multiple IDE endpoints exist; explicit source_endpoint is required');
      }
    }
  } else {
    // 目标为 IDE
    const targetMatch = ideEndpoints.find(e => e.endpoint_id === target_endpoint);
    if (!targetMatch) {
      blockAndThrow(`IDE_ENDPOINT_NOT_FOUND: Target endpoint "${target_endpoint}" does not exist in binding`);
    }

    if (source_endpoint && source_endpoint !== 'browser') {
      blockAndThrow(`INVALID_SOURCE_ENDPOINT: Source for IDE target must be "browser", got "${source_endpoint}"`);
    }

    resolvedSource = 'browser';
    sourceEpRev = 1;
  }

  // 3. 读取源端点规范事实并执行防漂移校验 (Locking Source Snapshot)
  const sourceFact = resolvedSource === 'browser'
    ? snapshot.endpoints.browser
    : (snapshot.endpoints.ide_endpoints?.[resolvedSource] || null);

  if (!sourceFact || sourceFact.continuity?.trusted !== true || sourceFact.result_state === 'UNKNOWN') {
    blockAndThrow(`SOURCE_ENDPOINT_UNKNOWN: Context uncertain on source endpoint "${resolvedSource}"`);
  }

  // 防漂移：必须提供 expected_source_result_state 并核验
  if (expected_source_result_state === undefined || expected_source_result_state === null) {
    blockAndThrow('STALE_SOURCE_CONTEXT: expected_source_result_state is required for continue snapshot locking');
  }
  if (expected_source_result_state !== sourceFact.result_state) {
    blockAndThrow(`STALE_SOURCE_CONTEXT: expected source result_state "${expected_source_result_state}", got "${sourceFact.result_state}"`);
  }

  // 防漂移：expected_source_cursor 必须强制提供（但允许为 null）
  if (expected_source_cursor === undefined) {
    blockAndThrow('STALE_SOURCE_CONTEXT: expected_source_cursor is required for continue snapshot locking');
  }

  const actualCursor = sourceFact.latest_completed_cursor ?? null;
  if (expected_source_cursor !== actualCursor) {
    blockAndThrow(`STALE_SOURCE_CONTEXT: expected source cursor "${expected_source_cursor}", got "${actualCursor}"`);
  }

  // 若源端点为 NEW，必须具备可用结果材料，且必须提供并核验 expected_source_result_ref
  const hasSourceNewResult = sourceFact.result_state === 'NEW';
  let sourceResultMaterial = null;

  if (hasSourceNewResult) {
    if (!expected_source_result_ref) {
      blockAndThrow('STALE_SOURCE_CONTEXT: expected_source_result_ref is required when source result_state is NEW');
    }
    const resultArtifact = sourceFact.latest_completed_result;
    if (!resultArtifact || typeof resultArtifact !== 'object' || resultArtifact.cursor !== sourceFact.latest_completed_cursor) {
      blockAndThrow(`SOURCE_RESULT_UNAVAILABLE: source endpoint "${resolvedSource}" has NEW result but result artifact is missing or mismatched`);
    }

    if (expected_source_result_ref !== resultArtifact.result_ref) {
      blockAndThrow(`STALE_SOURCE_CONTEXT: expected source result_ref "${expected_source_result_ref}", got "${resultArtifact.result_ref}"`);
    }

    sourceResultMaterial = resultArtifact;
  } else {
    // 源端点非 NEW（如 NO_NEW_RESULT）：若显式提供了 expected_source_result_ref，核验必须与当前材料一致
    if (expected_source_result_ref !== undefined) {
      const actualResultRef = sourceFact.latest_completed_result?.result_ref ?? null;
      const expRef = expected_source_result_ref ?? null;
      if (expRef !== actualResultRef) {
        blockAndThrow(`STALE_SOURCE_CONTEXT: expected source result_ref "${expRef}", got "${actualResultRef}"`);
      }
    }
  }

  // 4. 组装确定性 Outbound Bundle 与 Provenance
  const provenance = {
    binding_id: bindingId,
    binding_revision: currentBinding.binding_revision,
    source_endpoint: resolvedSource,
    source_endpoint_revision: sourceEpRev,
    source_result_ref: sourceResultMaterial ? sourceResultMaterial.result_ref : null,
    source_completed_at: sourceResultMaterial ? sourceResultMaterial.captured_at : null,
    target_endpoint
  };

  let renderedText = '';
  if (sourceResultMaterial) {
    renderedText = `[Rally Continue Context from ${resolvedSource}]\n${sourceResultMaterial.text}\n\nPlease continue.`;
  } else {
    renderedText = 'Please continue.';
  }

  const payload = {
    text: renderedText,
    provenance
  };

  // 5. 载荷超限防御 (Fail-closed BLOCKED，绝不静默截断)
  const estimatedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (estimatedBytes > MAX_PAYLOAD_BYTES) {
    blockAndThrow(`PAYLOAD_TOO_LARGE: Envelope payload exceeds bound (${MAX_PAYLOAD_BYTES} bytes, got ${estimatedBytes} bytes)`);
  }

  // 6. 委托 executeSafeSend 产生单一规范 Action 事实并派发
  return executeSafeSend({
    registry,
    bindingId,
    expected_binding_revision,
    target_endpoint,
    action_type: 'continue',
    envelope: {
      op: 'rally.prompt',
      payload
    },
    browserAdapter,
    ideAdapter
  });
}
