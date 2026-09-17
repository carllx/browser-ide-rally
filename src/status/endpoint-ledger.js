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
 * 核心设计：
 * - Browser 端点严格校验 binding_revision；
 * - IDE 端点优先校验 endpoint_revision：
 *   若显式提供 endpoint_revision，则要求严格匹配 targetEpRev；
 *   若显式提供 binding_revision：
 *     如果当前项目只有 1 个 IDE 端点，严格匹配 bindingRevision（完全兼容已有单端契约测试）；
 *     如果存在多个 IDE 端点，只有当 binding_revision < targetEpRev 时才判为 stale，
 *     确保同级 Sibling IDE 的增删改（仅 bump 了 binding_revision）不使有效的观察变为 stale；
 *     若显式提供了版本且不匹配，统一返回 `stale_revision: expected rev X, got rev Y`。
 * @returns {{ trusted: boolean, unknownReason: string|null }}
 */
export function verifyObservationContinuity({
  observation,
  expectedConvId,
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
    if (observation.endpoint_revision !== undefined && observation.endpoint_revision !== targetEpRev) {
      return { trusted: false, unknownReason: `stale_endpoint_revision: expected ep_rev ${targetEpRev}, got ep_rev ${observation.endpoint_revision}` };
    } else if (observation.binding_revision !== undefined && observation.endpoint_revision === undefined) {
      if (ideCount === 1) {
        if (observation.binding_revision !== bindingRevision) {
          return { trusted: false, unknownReason: `stale_revision: expected rev ${bindingRevision}, got rev ${observation.binding_revision}` };
        }
      } else {
        if (observation.binding_revision < targetEpRev || observation.binding_revision === 0) {
          return { trusted: false, unknownReason: `stale_revision: expected rev ${targetEpRev}, got rev ${observation.binding_revision}` };
        }
      }
    }
  }

  if (observation.continuity_lost || observation.error) {
    return { trusted: false, unknownReason: observation.reason || observation.error || 'continuity_lost' };
  }

  if (!observation.conversation_id || observation.conversation_id !== expectedConvId) {
    return {
      trusted: false,
      unknownReason: observation.conversation_id
        ? `attribution_mismatch: expected ${expectedConvId}, got ${observation.conversation_id}`
        : 'missing_conversation_identity: explicit conversation_id matching binding is required'
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
