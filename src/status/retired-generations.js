/**
 * 退役端点代际账本 (Retired Generations Ledger)
 * 
 * 领域不变式与规范准则 (#41):
 * 1. 非破坏性历史存证：端点轮换 (Rotation) 时即将退役的端点代际身份与完整事实快照永久归档；
 * 2. 隔离与只读：退役代际属于证据平面，绝不参与活跃端点槽位管理、红点推导或关注度计算；
 * 3. 游标绝不篡改：轮换退役绝不修改原端点的 last_handled_cursor，不伪造 handled 事实；
 * 4. 持久化确定性：随 ProjectRegistry 导出与还原，确保重启后历史证据不丢失。
 */

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

  // 5. Identity 校验：必须包含非空 conversation_id
  if (!entry.identity || typeof entry.identity !== 'object' || Array.isArray(entry.identity)) {
    throw new Error('Corrupt retired generation: identity must be a valid object');
  }
  if (typeof entry.identity.conversation_id !== 'string' || !entry.identity.conversation_id.trim()) {
    throw new Error('Corrupt retired generation: identity.conversation_id must be a non-empty string');
  }
  const cleanConvId = entry.identity.conversation_id.trim();
  const identity = {
    conversation_id: cleanConvId,
    workspace_identity: typeof entry.identity.workspace_identity === 'string' ? entry.identity.workspace_identity.trim() : null,
    repository_identity: typeof entry.identity.repository_identity === 'string' ? entry.identity.repository_identity.trim() : null,
    branch: typeof entry.identity.branch === 'string' ? entry.identity.branch.trim() : null,
    provider: typeof entry.identity.provider === 'string' ? entry.identity.provider.trim() : null
  };

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

  const endpointFact = {
    endpoint: endpointId,
    role,
    endpoint_revision: endpointRevision,
    result_state: typeof fact.result_state === 'string' ? fact.result_state : 'UNKNOWN',
    latest_completed_cursor: fact.latest_completed_cursor ?? null,
    last_handled_cursor: fact.last_handled_cursor ?? null,
    completed_at: fact.completed_at ?? null,
    latest_completed_result: fact.latest_completed_result && typeof fact.latest_completed_result === 'object'
      ? { ...fact.latest_completed_result }
      : null,
    continuity: {
      trusted: fact.continuity.trusted,
      unknown_reason: fact.continuity.unknown_reason ?? null
    },
    updated_at: fact.updated_at || retiredAt
  };

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
