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
 * 校验并规范化单条退役代际事实
 * @param {object} entry
 * @returns {object}
 */
export function normalizeRetiredGeneration(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Retired generation entry must be a valid object');
  }

  const role = entry.role === 'browser' ? 'browser' : 'ide';
  const endpointId = String(entry.endpoint_id || (role === 'browser' ? 'browser' : '')).trim();
  if (!endpointId) {
    throw new Error('Retired generation requires valid endpoint_id');
  }

  const endpointRevision = Number(entry.endpoint_revision) || 1;
  const retiredAt = entry.retired_at || new Date().toISOString();
  const reason = entry.reason || 'conversation_rotation';

  const identity = entry.identity && typeof entry.identity === 'object'
    ? {
        conversation_id: entry.identity.conversation_id || null,
        workspace_identity: entry.identity.workspace_identity || null,
        repository_identity: entry.identity.repository_identity || null,
        branch: entry.identity.branch || null
      }
    : {
        conversation_id: null,
        workspace_identity: null,
        repository_identity: null,
        branch: null
      };

  const endpointFact = entry.endpoint_fact && typeof entry.endpoint_fact === 'object'
    ? {
        endpoint: entry.endpoint_fact.endpoint || endpointId,
        role: entry.endpoint_fact.role || role,
        endpoint_revision: entry.endpoint_fact.endpoint_revision || endpointRevision,
        latest_completed_cursor: entry.endpoint_fact.latest_completed_cursor ?? null,
        last_handled_cursor: entry.endpoint_fact.last_handled_cursor ?? null,
        completed_at: entry.endpoint_fact.completed_at ?? null,
        latest_completed_result: entry.endpoint_fact.latest_completed_result
          ? { ...entry.endpoint_fact.latest_completed_result }
          : null,
        continuity: {
          trusted: Boolean(entry.endpoint_fact.continuity?.trusted),
          unknown_reason: entry.endpoint_fact.continuity?.unknown_reason ?? null
        },
        updated_at: entry.endpoint_fact.updated_at || retiredAt
      }
    : null;

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
