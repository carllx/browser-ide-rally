/**
 * Endpoint Ledger — 端点账本纯逻辑与规范事实推导模块
 * 
 * 领域不变式：
 * 1. 纯函数式确定性派生 NEW / NO_NEW_RESULT / UNKNOWN；
 * 2. 严格布尔受信与连续性 fail-closed；
 * 3. 杜绝不可能的游标账本 (latest 为空但 handled 非空)；
 * 4. 消除 status-core 与 status-view 之间的循环依赖。
 */

export const ALLOWED_RESULT_STATES = ['NEW', 'NO_NEW_RESULT', 'UNKNOWN'];

/**
 * 创建端点初始规范事实对象
 */
export function createInitialEndpointFact({
  endpoint,
  role = 'ide',
  endpoint_revision = 1,
  updated_at = new Date().toISOString()
}) {
  return {
    endpoint,
    role,
    endpoint_revision,
    latest_completed_cursor: null,
    last_handled_cursor: null,
    completed_at: null,
    continuity: {
      trusted: false,
      unknown_reason: 'initial_unobserved'
    },
    updated_at
  };
}

/**
 * 从端点规范事实纯函数式确定性派生 Endpoint Result
 */
export function deriveEndpointResult(endpointFact) {
  if (!endpointFact || !endpointFact.continuity || endpointFact.continuity.trusted !== true) {
    return 'UNKNOWN';
  }

  const { latest_completed_cursor, last_handled_cursor } = endpointFact;

  if (
    (latest_completed_cursor === null || latest_completed_cursor === undefined) &&
    (last_handled_cursor !== null && last_handled_cursor !== undefined)
  ) {
    return 'UNKNOWN';
  }

  if (
    latest_completed_cursor !== null &&
    latest_completed_cursor !== undefined &&
    latest_completed_cursor !== last_handled_cursor
  ) {
    return 'NEW';
  }

  return 'NO_NEW_RESULT';
}

/**
 * 受信水合单个端点事实 (Hydrate Endpoint Fact)
 */
export function hydrateEndpointFact(fact, expectedEndpoint, {
  role = 'ide',
  endpoint_revision = 1,
  fallbackUpdatedAt = new Date().toISOString()
} = {}) {
  if (!fact || typeof fact !== 'object') {
    return createInitialEndpointFact({
      endpoint: expectedEndpoint,
      role,
      endpoint_revision,
      updated_at: fallbackUpdatedAt
    });
  }

  const slotMatch = fact.endpoint === expectedEndpoint;
  const hasLatest = 'latest_completed_cursor' in fact && fact.latest_completed_cursor !== undefined;
  const hasHandled = 'last_handled_cursor' in fact && fact.last_handled_cursor !== undefined;
  const isTrustedDeclared = fact.continuity?.trusted === true;

  let trusted = false;
  let unknownReason = null;

  if (isTrustedDeclared) {
    const isImpossibleLedger =
      (fact.latest_completed_cursor === null || fact.latest_completed_cursor === undefined) &&
      (fact.last_handled_cursor !== null && fact.last_handled_cursor !== undefined);

    if (!slotMatch || !hasLatest || !hasHandled || isImpossibleLedger) {
      trusted = false;
      unknownReason = isImpossibleLedger
        ? 'impossible_persisted_cursor_ledger: handled cursor exists while latest completed cursor is null'
        : 'incomplete_persisted_cursor_ledger: trusted endpoint requires explicit cursor fields and matching slot';
    } else {
      trusted = true;
      unknownReason = null;
    }
  } else {
    trusted = false;
    unknownReason = fact.continuity?.unknown_reason || 'untrusted_or_malformed_persisted_continuity';
  }

  const epRev = Number.isInteger(fact.endpoint_revision) && fact.endpoint_revision >= 1
    ? fact.endpoint_revision
    : endpoint_revision;

  return {
    endpoint: expectedEndpoint,
    role: fact.role || role,
    endpoint_revision: epRev,
    latest_completed_cursor: trusted ? fact.latest_completed_cursor : null,
    last_handled_cursor: trusted ? fact.last_handled_cursor : null,
    completed_at: fact.completed_at ?? null,
    continuity: {
      trusted,
      unknown_reason: unknownReason
    },
    updated_at: fact.updated_at || fallbackUpdatedAt
  };
}

/**
 * 校验 observation 对目标端点的连续性与归属事实
 * 
 * 强制约束（来自 Browser 修正与 Review 门禁）：
 * 1. IDE observation stale safety 必须真正使用 endpoint_id + endpoint_revision + exact provider identity；
 * 2. 多 IDE 模式下严格禁止使用 project-wide binding_revision 作为 fallback（必须显式提供 endpoint_revision）；
 * 3. 严格校验 exact provider identity：conversation_id 必须完全一致，若 observation 携带 workspace/repository 亦必须精确匹配。
 * @returns {{ trusted: boolean, unknownReason: string|null }}
 */
export function verifyObservationContinuity({
  observation,
  expectedConfig,
  targetEpRev,
  isBrowser = false,
  bindingRevision,
  ideCount = 1
}) {
  if (observation.result_state === 'IDLE') {
    return { trusted: false, unknownReason: 'disallowed_idle_state: IDLE is not canonical Endpoint Result truth' };
  }

  if (isBrowser) {
    if (observation.binding_revision !== undefined && observation.binding_revision !== bindingRevision) {
      return { trusted: false, unknownReason: `stale_revision: expected rev ${bindingRevision}, got rev ${observation.binding_revision}` };
    }
  } else {
    // IDE 端点
    if (ideCount > 1) {
      // 多 IDE 模式下：必须显式提供 endpoint_revision，禁止 fallback 到 binding_revision！
      if (observation.endpoint_revision === undefined) {
        return { trusted: false, unknownReason: 'missing_endpoint_revision: multi-IDE observation requires explicit endpoint_revision' };
      }
      if (observation.endpoint_revision !== targetEpRev) {
        return { trusted: false, unknownReason: `stale_endpoint_revision: expected ep_rev ${targetEpRev}, got ep_rev ${observation.endpoint_revision}` };
      }
    } else {
      // 单 IDE 模式（完全保持既有 #16 测试契约兼容）
      if (observation.endpoint_revision !== undefined) {
        if (observation.endpoint_revision !== targetEpRev) {
          return { trusted: false, unknownReason: `stale_endpoint_revision: expected ep_rev ${targetEpRev}, got ep_rev ${observation.endpoint_revision}` };
        }
      } else if (observation.binding_revision !== undefined) {
        if (observation.binding_revision !== bindingRevision) {
          return { trusted: false, unknownReason: `stale_revision: expected rev ${bindingRevision}, got rev ${observation.binding_revision}` };
        }
      }
    }
  }

  if (observation.continuity_lost || observation.error) {
    return { trusted: false, unknownReason: observation.reason || observation.error || 'continuity_lost' };
  }

  // Exact provider identity 校验
  const expectedConvId = expectedConfig?.conversation_id;
  if (!observation.conversation_id || observation.conversation_id !== expectedConvId) {
    return {
      trusted: false,
      unknownReason: observation.conversation_id
        ? `attribution_mismatch: expected ${expectedConvId}, got ${observation.conversation_id}`
        : 'missing_conversation_identity: explicit conversation_id matching binding is required'
    };
  }

  // 若 observation 携带 workspace_identity，要求与配置完全匹配
  if (observation.workspace_identity && expectedConfig?.workspace_identity && observation.workspace_identity !== expectedConfig.workspace_identity) {
    return {
      trusted: false,
      unknownReason: `workspace_mismatch: expected ${expectedConfig.workspace_identity}, got ${observation.workspace_identity}`
    };
  }

  // 若 observation 携带 repository_identity，要求与配置完全匹配
  if (observation.repository_identity && expectedConfig?.repository_identity && observation.repository_identity !== expectedConfig.repository_identity) {
    return {
      trusted: false,
      unknownReason: `repository_mismatch: expected ${expectedConfig.repository_identity}, got ${observation.repository_identity}`
    };
  }

  const isExplicitlyTrusted = observation.trusted === true || observation.continuity?.trusted === true;
  if (!isExplicitlyTrusted) {
    return { trusted: false, unknownReason: 'unverified_continuity: explicit trust fact required' };
  }

  return { trusted: true, unknownReason: null };
}

/**
 * 格式化单个端点的快照对象
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
