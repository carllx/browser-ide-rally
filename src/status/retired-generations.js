/**
 * 退役端点代际账本 (Retired Generations Ledger)
 * 
 * 领域不变式与规范准则 (#41):
 * 1. 非破坏性历史存证：端点轮换 (Rotation) 时即将退役的端点代际身份与完整事实快照永久归档；
 * 2. 隔离与只读：退役代际属于证据平面，绝不参与活跃端点槽位管理、红点推导或关注度计算；
 * 3. 游标绝不篡改：轮换退役绝不修改原端点的 last_handled_cursor，不伪造 handled 事实；
 * 4. 持久化确定性：随 ProjectRegistry 导出与还原，确保重启后历史证据不丢失。
 */

import { deriveEndpointResult } from './endpoint-ledger.js';

/**
 * 校验并规范化单条退役代际事实（严格 Fail-Closed，拒绝默认容错捏造）
 * @param {object} entry
 * @returns {object}
 */
export function normalizeRetiredGeneration(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Corrupt retired generation: entry must be a valid object');
  }

  // 1. Role 校验：仅允许 'browser' 或 'ide'
  if (entry.role !== 'browser' && entry.role !== 'ide') {
    throw new Error(`Corrupt retired generation: invalid role "${entry.role}", expected "browser" or "ide"`);
  }
  const role = entry.role;

  // 2. Endpoint ID 校验
  if (typeof entry.endpoint_id !== 'string' || !entry.endpoint_id.trim()) {
    throw new Error('Corrupt retired generation: endpoint_id must be a non-empty string');
  }
  const endpointId = entry.endpoint_id.trim();
  if (role === 'browser' && endpointId !== 'browser') {
    throw new Error(`Corrupt retired generation: browser role must have endpoint_id "browser", got "${endpointId}"`);
  }
  if (role === 'ide' && endpointId === 'browser') {
    throw new Error('Corrupt retired generation: ide role cannot have endpoint_id "browser"');
  }

  // 3. Endpoint Revision 校验：必须为正整数 >= 1
  if (typeof entry.endpoint_revision !== 'number' || !Number.isInteger(entry.endpoint_revision) || entry.endpoint_revision < 1) {
    throw new Error(`Corrupt retired generation: invalid endpoint_revision "${entry.endpoint_revision}", expected integer >= 1`);
  }
  const endpointRevision = entry.endpoint_revision;

  // 4. Retired At & Reason 校验
  if (typeof entry.retired_at !== 'string' || !entry.retired_at.trim() || Number.isNaN(Date.parse(entry.retired_at))) {
    throw new Error(`Corrupt retired generation: invalid retired_at timestamp "${entry.retired_at}"`);
  }
  const retiredAt = entry.retired_at.trim();

  if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
    throw new Error('Corrupt retired generation: reason must be a non-empty string');
  }
  const reason = entry.reason.trim();

  // 5. Identity 校验
  if (!entry.identity || typeof entry.identity !== 'object' || Array.isArray(entry.identity)) {
    throw new Error('Corrupt retired generation: identity must be a valid object');
  }
  if (typeof entry.identity.conversation_id !== 'string' || !entry.identity.conversation_id.trim()) {
    throw new Error('Corrupt retired generation: identity.conversation_id must be a non-empty string');
  }
  const cleanConvId = entry.identity.conversation_id.trim();

  let identity;
  if (role === 'ide') {
    if (typeof entry.identity.workspace_identity !== 'string' || !entry.identity.workspace_identity.trim()) {
      throw new Error('Corrupt retired generation: ide identity requires valid non-empty workspace_identity');
    }
    if (typeof entry.identity.repository_identity !== 'string' || !entry.identity.repository_identity.trim()) {
      throw new Error('Corrupt retired generation: ide identity requires valid non-empty repository_identity');
    }
    if (entry.identity.branch !== null && entry.identity.branch !== undefined) {
      throw new Error('Corrupt retired generation: ide identity cannot contain branch');
    }
    if (entry.identity.provider !== null && entry.identity.provider !== undefined) {
      throw new Error('Corrupt retired generation: ide identity cannot contain provider');
    }
    identity = {
      conversation_id: cleanConvId,
      workspace_identity: entry.identity.workspace_identity.trim(),
      repository_identity: entry.identity.repository_identity.trim(),
      branch: null,
      provider: null
    };
  } else {
    // browser
    if (typeof entry.identity.provider !== 'string' || !entry.identity.provider.trim()) {
      throw new Error('Corrupt retired generation: browser identity requires valid non-empty provider');
    }
    let branch = null;
    if (entry.identity.branch !== null && entry.identity.branch !== undefined) {
      if (typeof entry.identity.branch !== 'string' || !entry.identity.branch.trim()) {
        throw new Error('Corrupt retired generation: browser identity branch must be a non-empty string or null');
      }
      branch = entry.identity.branch.trim();
    }
    if (entry.identity.workspace_identity !== null && entry.identity.workspace_identity !== undefined) {
      throw new Error('Corrupt retired generation: browser identity cannot contain workspace_identity');
    }
    if (entry.identity.repository_identity !== null && entry.identity.repository_identity !== undefined) {
      throw new Error('Corrupt retired generation: browser identity cannot contain repository_identity');
    }
    identity = {
      conversation_id: cleanConvId,
      provider: entry.identity.provider.trim(),
      branch,
      workspace_identity: null,
      repository_identity: null
    };
  }

  // 6. Endpoint Fact 校验：必须存在且与外部属性严格一致
  if (!entry.endpoint_fact || typeof entry.endpoint_fact !== 'object' || Array.isArray(entry.endpoint_fact)) {
    throw new Error('Corrupt retired generation: missing or malformed endpoint_fact');
  }
  const fact = entry.endpoint_fact;
  if (fact.role !== role) {
    throw new Error(`Corrupt retired generation: endpoint_fact.role "${fact.role}" does not match entry role "${role}"`);
  }
  if (fact.endpoint !== endpointId) {
    throw new Error(`Corrupt retired generation: endpoint_fact.endpoint "${fact.endpoint}" does not match entry endpoint_id "${endpointId}"`);
  }
  if (fact.endpoint_revision !== endpointRevision) {
    throw new Error(`Corrupt retired generation: endpoint_fact.endpoint_revision "${fact.endpoint_revision}" does not match entry revision "${endpointRevision}"`);
  }
  if (!fact.continuity || typeof fact.continuity !== 'object' || Array.isArray(fact.continuity)) {
    throw new Error('Corrupt retired generation: endpoint_fact.continuity must be a valid non-null object');
  }
  if (typeof fact.continuity.trusted !== 'boolean') {
    throw new Error('Corrupt retired generation: endpoint_fact.continuity.trusted must be a boolean');
  }
  if (fact.continuity.unknown_reason !== null && fact.continuity.unknown_reason !== undefined) {
    if (typeof fact.continuity.unknown_reason !== 'string') {
      throw new Error('Corrupt retired generation: endpoint_fact.continuity.unknown_reason must be a string or null');
    }
  }

  // 游标与时间戳严格校验
  if (fact.latest_completed_cursor !== null && fact.latest_completed_cursor !== undefined) {
    if (typeof fact.latest_completed_cursor !== 'string' || !fact.latest_completed_cursor.trim()) {
      throw new Error('Corrupt retired generation: latest_completed_cursor must be a non-empty string or null');
    }
  }
  if (fact.last_handled_cursor !== null && fact.last_handled_cursor !== undefined) {
    if (typeof fact.last_handled_cursor !== 'string' || !fact.last_handled_cursor.trim()) {
      throw new Error('Corrupt retired generation: last_handled_cursor must be a non-empty string or null');
    }
  }
  if (fact.completed_at !== null && fact.completed_at !== undefined) {
    if (typeof fact.completed_at !== 'string' || !fact.completed_at.trim() || Number.isNaN(Date.parse(fact.completed_at))) {
      throw new Error('Corrupt retired generation: completed_at must be a valid ISO timestamp or null');
    }
  }
  if (fact.updated_at !== null && fact.updated_at !== undefined) {
    if (typeof fact.updated_at !== 'string' || !fact.updated_at.trim() || Number.isNaN(Date.parse(fact.updated_at))) {
      throw new Error('Corrupt retired generation: updated_at must be a valid ISO timestamp');
    }
  }

  // 结果材料严格校验
  let normalizedResult = null;
  if (fact.latest_completed_result !== null && fact.latest_completed_result !== undefined) {
    const res = fact.latest_completed_result;
    if (typeof res !== 'object' || Array.isArray(res)) {
      throw new Error('Corrupt retired generation: latest_completed_result must be an object');
    }
    if (!fact.latest_completed_cursor) {
      throw new Error('Corrupt retired generation: latest_completed_result cannot exist when latest_completed_cursor is null');
    }
    if (res.cursor !== fact.latest_completed_cursor) {
      throw new Error(`Corrupt retired generation: latest_completed_result.cursor "${res.cursor}" does not match latest_completed_cursor "${fact.latest_completed_cursor}"`);
    }
    if (typeof res.result_ref !== 'string' || !res.result_ref.trim()) {
      throw new Error('Corrupt retired generation: latest_completed_result.result_ref must be a non-empty string');
    }
    if (typeof res.text !== 'string') {
      throw new Error('Corrupt retired generation: latest_completed_result.text must be a string');
    }
    if (typeof res.captured_at !== 'string' || Number.isNaN(Date.parse(res.captured_at))) {
      throw new Error('Corrupt retired generation: latest_completed_result.captured_at must be a valid ISO timestamp');
    }
    normalizedResult = {
      cursor: res.cursor,
      result_ref: res.result_ref.trim(),
      text: res.text,
      captured_at: res.captured_at
    };
  }

  const endpointFact = {
    endpoint: endpointId,
    role,
    endpoint_revision: endpointRevision,
    latest_completed_cursor: fact.latest_completed_cursor ? fact.latest_completed_cursor.trim() : null,
    last_handled_cursor: fact.last_handled_cursor ? fact.last_handled_cursor.trim() : null,
    completed_at: fact.completed_at ? fact.completed_at.trim() : null,
    latest_completed_result: normalizedResult,
    continuity: {
      trusted: fact.continuity.trusted,
      unknown_reason: fact.continuity.unknown_reason ? fact.continuity.unknown_reason.trim() : null
    },
    updated_at: fact.updated_at ? fact.updated_at.trim() : retiredAt
  };

  // 杜绝不可能账本 (latest 为 null 但 handled 非 null)
  if (!endpointFact.latest_completed_cursor && endpointFact.last_handled_cursor) {
    throw new Error('Corrupt retired generation: impossible ledger (latest cursor is null but handled cursor is non-null)');
  }

  // 严格自洽性检查：若持久化中存在预先声明的 result_state，绝不能与 raw fact 的真确派生结果相矛盾
  const derivedState = deriveEndpointResult(endpointFact);
  if (fact.result_state !== undefined && fact.result_state !== null) {
    if (fact.result_state !== derivedState) {
      throw new Error(`Corrupt retired generation: contradictory result_state (persisted "${fact.result_state}", derived "${derivedState}")`);
    }
  }

  return {
    role,
    endpoint_id: endpointId,
    endpoint_revision: endpointRevision,
    retired_at: retiredAt,
    reason,
    identity,
    endpoint_fact: endpointFact
  };
}

export class RetiredGenerationsLedger {
  constructor(initialEntries = []) {
    this._entries = [];
    if (Array.isArray(initialEntries)) {
      for (const item of initialEntries) {
        this._entries.push(normalizeRetiredGeneration(item));
      }
    }
  }

  /**
   * 记录一次端点代际退役
   * @param {object} params
   * @returns {object} 归档的退役代际对象
   */
  recordRetirement({
    role,
    endpoint_id,
    endpoint_revision,
    identity,
    endpoint_fact,
    retired_at = new Date().toISOString(),
    reason = 'conversation_rotation'
  }) {
    const normalized = normalizeRetiredGeneration({
      role,
      endpoint_id,
      endpoint_revision,
      identity,
      endpoint_fact,
      retired_at,
      reason
    });
    this._entries.push(normalized);
    return normalized;
  }

  /**
   * 获取所有退役代际只读列表（深拷贝，防止外部篡改）
   * @returns {Array<object>}
   */
  list() {
    return this._entries.map(e => ({
      ...e,
      identity: { ...e.identity },
      endpoint_fact: e.endpoint_fact
        ? {
            ...e.endpoint_fact,
            latest_completed_result: e.endpoint_fact.latest_completed_result
              ? { ...e.endpoint_fact.latest_completed_result }
              : null,
            continuity: { ...e.endpoint_fact.continuity }
          }
        : null
    }));
  }

  /**
   * 导出用于持久化或快照的数组
   * @returns {Array<object>}
   */
  exportData() {
    return this.list();
  }
}

export function createRetiredGenerationsLedger(initialEntries = []) {
  return new RetiredGenerationsLedger(initialEntries);
}
