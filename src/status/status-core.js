/**
 * Status Core — 单个 Project Binding 的规范状态核心
 *
 * 核心设计原则 (Core Principles):
 * 1. 规范事实优先：Endpoint Result 必须从底层规范事实（latest completed cursor、last handled cursor、continuity/trust）确定性派生，绝不把 NEW / NO_NEW_RESULT 当作可写输入；
 * 2. 宿主独立、Relay 可选：不依赖任何 Relay Exchange 即可独立运作；
 * 3. 端点独立：Browser 与 IDE 的 Endpoint Result 独立更新，支持 Dual NEW 共存；
 * 4. 确定性三态：Endpoint Result 确定性地仅推导为 NEW、NO_NEW_RESULT 或 UNKNOWN，严禁使用 IDLE；
 * 5. Fail-closed 优先：连续性中断或归属异常时 UNKNOWN 优先，绝不退化为便利性所有权猜测；
 * 6. 防静默抹除：Mark handled 只能推进到当前可靠的 latest completed cursor，旧/不匹配 cursor 绝不能清除当前 NEW；
 * 7. 身份守卫：禁止跨会话不安全 rebind，防止旧会话事实被带入新会话（真正的 reconciliation rebind 归属 #14）；
 * 8. 事实解耦：Action 事实与 Human Intervention 事实与 Endpoint Result 独立并存，绝不相互篡改；
 * 9. 无唯一所有者：不持久化、不推断 Baton、owner 或“轮到谁”。
 */

import { validateBinding } from '../controller/binding.js';
import { formatStatusSnapshot, formatCompactStatus } from './status-view.js';

export const ALLOWED_ENDPOINTS = ['browser', 'ide'];
export const ALLOWED_RESULT_STATES = ['NEW', 'NO_NEW_RESULT', 'UNKNOWN'];
export const ALLOWED_ACTION_STAGES = [
  'REQUESTED',
  'SUBMITTED_LOCALLY',
  'ACCEPTED_OR_DELIVERED',
  'TARGET_COMPLETED'
];

/**
 * 从端点规范事实纯函数式确定性派生 Endpoint Result
 * @param {object} endpointFact
 * @returns {'NEW' | 'NO_NEW_RESULT' | 'UNKNOWN'}
 */
export function deriveEndpointResult(endpointFact) {
  if (!endpointFact || !endpointFact.continuity || !endpointFact.continuity.trusted) {
    return 'UNKNOWN';
  }

  const { latest_completed_cursor, last_handled_cursor } = endpointFact;

  // 若存在可靠的最新完成游标，且未被 Rally 明确 handled，则确定性派生为 NEW
  if (latest_completed_cursor && latest_completed_cursor !== last_handled_cursor) {
    return 'NEW';
  }

  // 连续性受信且所有已知完成均已处理（或无未处理完成）时，派生为 NO_NEW_RESULT
  return 'NO_NEW_RESULT';
}

/**
 * 创建 Project Status Core 实例
 * @param {object} params
 * @param {object} params.binding - Project Binding 对象
 * @returns {ProjectStatusCore}
 */
export function createProjectStatusCore({ binding }) {
  return new ProjectStatusCore({ binding });
}

export class ProjectStatusCore {
  /**
   * @param {object} options
   * @param {object} options.binding - Project Binding 实例
   */
  constructor({ binding }) {
    const validation = validateBinding(binding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding for Status Core: ${validation.errors.join('; ')}`);
    }

    this._binding = { ...binding };
    this._updatedAt = new Date().toISOString();

    // 独立初始化 Browser 与 IDE 两个端点的底层规范事实（Canonical Facts）
    this._endpoints = {
      browser: {
        endpoint: 'browser',
        latest_completed_cursor: null,
        last_handled_cursor: null,
        completed_at: null,
        continuity: {
          trusted: false,
          unknown_reason: 'initial_unobserved'
        },
        updated_at: this._updatedAt
      },
      ide: {
        endpoint: 'ide',
        latest_completed_cursor: null,
        last_handled_cursor: null,
        completed_at: null,
        continuity: {
          trusted: false,
          unknown_reason: 'initial_unobserved'
        },
        updated_at: this._updatedAt
      }
    };

    // 人工介入状态（独立于端点完成与动作事实）
    this._humanIntervention = {
      active: false,
      reason: null,
      updated_at: this._updatedAt
    };

    // 动作事实序列
    this._actions = [];
  }

  /**
   * 获取当前绑定的快照副本
   */
  getBinding() {
    return { ...this._binding };
  }

  /**
   * 更新当前 Binding（仅限保持身份的更新，如 revision bump 或 paused 切换）
   * 严格禁止跨 conversation 的不安全 rebind（防止旧端点结果被误带入新会话）
   * @param {object} nextBinding 
   */
  updateBinding(nextBinding) {
    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding update: ${validation.errors.join('; ')}`);
    }

    if (nextBinding.binding_id !== this._binding.binding_id) {
      throw new Error(`Cannot change binding_id from "${this._binding.binding_id}" to "${nextBinding.binding_id}".`);
    }

    // 身份守卫：端点身份变更属于 #14 reconciliation rebind，在此直接拦截
    const browserChanged =
      nextBinding.browser.provider !== this._binding.browser.provider ||
      nextBinding.browser.conversation_id !== this._binding.browser.conversation_id;

    const ideChanged =
      nextBinding.ide.conversation_id !== this._binding.ide.conversation_id ||
      nextBinding.ide.workspace_identity !== this._binding.ide.workspace_identity ||
      nextBinding.ide.repository_identity !== this._binding.ide.repository_identity;

    if (browserChanged || ideChanged) {
      throw new Error(
        'Identity-changing rebind is prohibited in Status Core (#13); cross-conversation reconciliation belongs to #14.'
      );
    }

    this._binding = { ...nextBinding };
    this._updatedAt = new Date().toISOString();
  }

  /**
   * 记录端点底层规范事实（Opaque latest completed cursor、last handled cursor、continuity/trust）
   * 严格禁止传入 NEW / NO_NEW_RESULT 作为权威事实写入
   * @param {string} endpoint - 'browser' | 'ide'
   * @param {object} observation - 规范事实输入
   */
  recordEndpointObservation(endpoint, observation = {}) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Invalid endpoint "${endpoint}". Must be 'browser' or 'ide'.`);
    }

    const current = this._endpoints[endpoint];
    const now = new Date().toISOString();

    let trusted = false;
    let unknownReason = null;

    // 1. 拒绝非法的 IDLE 状态传入，fail-closed 到 UNKNOWN
    if (observation.result_state === 'IDLE') {
      trusted = false;
      unknownReason = 'disallowed_idle_state: IDLE is not canonical Endpoint Result truth';
    }
    // 2. 归属校验：若提供 conversation_id，必须与当前 binding 严格匹配
    else if (
      observation.conversation_id &&
      observation.conversation_id !== (endpoint === 'browser' ? this._binding.browser.conversation_id : this._binding.ide.conversation_id)
    ) {
      trusted = false;
      unknownReason = `attribution_mismatch: expected ${
        endpoint === 'browser' ? this._binding.browser.conversation_id : this._binding.ide.conversation_id
      }, got ${observation.conversation_id}`;
    }
    // 3. 版本校验：若提供 binding_revision，必须与当前 binding_revision 一致
    else if (observation.binding_revision && observation.binding_revision !== this._binding.binding_revision) {
      trusted = false;
      unknownReason = `stale_revision: expected rev ${this._binding.binding_revision}, got rev ${observation.binding_revision}`;
    }
    // 4. 连续性校验：若显式报告连续性断裂或错误，fail-closed 为 UNKNOWN
    else if (observation.continuity_lost || observation.error) {
      trusted = false;
      unknownReason = observation.reason || observation.error || 'continuity_lost';
    }
    // 5. 校验通过，连续性受信
    else {
      trusted = true;
      unknownReason = null;
    }

    // 提取游标事实（支持 latest_completed_cursor 或别名 turn_id / cursor）
    const latestCursor = observation.latest_completed_cursor ?? observation.turn_id ?? observation.cursor ?? current.latest_completed_cursor;
    const handledCursor = observation.last_handled_cursor ?? current.last_handled_cursor;
    const completedAt = observation.completed_at ?? current.completed_at;

    this._endpoints[endpoint] = {
      endpoint,
      latest_completed_cursor: latestCursor,
      last_handled_cursor: handledCursor,
      completed_at: completedAt,
      continuity: {
        trusted,
        unknown_reason: unknownReason
      },
      updated_at: now
    };

    this._updatedAt = now;
  }

  /**
   * 显式标记某端点已处理 (Mark handled)
   * 核心不变量：只能推进到当前可靠的 latest completed cursor！
   * 若连续性未知、无可靠最新完成、或 expected_cursor 与当前 latest cursor 不匹配，绝不能清除 NEW
   * @param {string} endpoint 
   * @param {object} [params]
   * @param {string} [params.expected_cursor] - 预期的游标，必须与当前 latest_completed_cursor 一致
   * @param {string} [params.handled_turn_id] - 别名，同 expected_cursor
   * @returns {{ success: boolean, reason?: string, handled_cursor?: string }}
   */
  markEndpointHandled(endpoint, { expected_cursor = null, handled_turn_id = null } = {}) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Invalid endpoint "${endpoint}".`);
    }

    const current = this._endpoints[endpoint];
    const now = new Date().toISOString();

    // 1. 若当前连续性不受信任（UNKNOWN），fail-closed，绝不能推进或清除
    if (!current.continuity.trusted) {
      return { success: false, reason: 'continuity_not_trusted' };
    }

    // 2. 若当前没有可靠的 latest_completed_cursor，无完成可推进
    if (!current.latest_completed_cursor) {
      return { success: false, reason: 'no_latest_completed_cursor' };
    }

    // 3. 若调用者指定了 expected cursor，必须精确匹配当前 latest_completed_cursor
    const targetCursor = expected_cursor || handled_turn_id;
    if (targetCursor && targetCursor !== current.latest_completed_cursor) {
      // 游标不匹配（旧游标或未知游标）：绝不能清除当前 NEW！
      return { success: false, reason: 'cursor_mismatch' };
    }

    // 4. 正确推进：将 last_handled_cursor 推进至当前最新的 latest_completed_cursor
    current.last_handled_cursor = current.latest_completed_cursor;
    current.updated_at = now;
    this._updatedAt = now;

    return { success: true, handled_cursor: current.last_handled_cursor };
  }

  /**
   * 设置人工介入事实
   * 独立共存：绝不影响或改写端点的 Endpoint Result
   * @param {object} params
   * @param {boolean} params.active
   * @param {string|null} params.reason
   */
  setHumanIntervention({ active = true, reason = null } = {}) {
    this._humanIntervention = {
      active: Boolean(active),
      reason: reason || null,
      updated_at: new Date().toISOString()
    };
    this._updatedAt = this._humanIntervention.updated_at;
  }

  /**
   * 清除人工介入
   * 独立共存：绝不影响或改写端点的 Endpoint Result
   */
  clearHumanIntervention() {
    this._humanIntervention = {
      active: false,
      reason: null,
      updated_at: new Date().toISOString()
    };
    this._updatedAt = this._humanIntervention.updated_at;
  }

  /**
   * 记录动作事实
   * 独立共存：动作生命周期与 Endpoint Result 互不干扰
   * @param {object} actionFact
   */
  recordActionFact({
    action_id,
    action_type = 'action',
    target_endpoint,
    stage = 'REQUESTED',
    binding_revision,
    evidence = null
  }) {
    if (!action_id || typeof action_id !== 'string') {
      throw new Error('action_id is required and must be a string');
    }
    if (!ALLOWED_ACTION_STAGES.includes(stage)) {
      throw new Error(`Invalid action stage "${stage}"`);
    }

    const now = new Date().toISOString();
    const fact = {
      action_id,
      action_type,
      target_endpoint: target_endpoint || null,
      stage,
      binding_revision: binding_revision ?? this._binding.binding_revision,
      evidence,
      created_at: now,
      updated_at: now
    };

    this._actions.push(fact);
    this._updatedAt = now;
    return fact;
  }

  /**
   * 推进动作事实阶段
   * @param {string} actionId 
   * @param {object} params
   * @param {string} params.next_stage 
   * @param {*} params.evidence
   */
  advanceActionStage(actionId, { next_stage, evidence }) {
    const action = this._actions.find(a => a.action_id === actionId);
    if (!action) {
      throw new Error(`Action "${actionId}" not found`);
    }
    if (!ALLOWED_ACTION_STAGES.includes(next_stage)) {
      throw new Error(`Invalid target stage "${next_stage}"`);
    }

    const currentIndex = ALLOWED_ACTION_STAGES.indexOf(action.stage);
    const nextIndex = ALLOWED_ACTION_STAGES.indexOf(next_stage);

    if (nextIndex <= currentIndex) {
      throw new Error(`Cannot transition backwards or sideways from ${action.stage} to ${next_stage}`);
    }

    const now = new Date().toISOString();
    action.stage = next_stage;
    action.evidence = evidence ?? action.evidence;
    action.updated_at = now;
    this._updatedAt = now;

    return { ...action };
  }

  /**
   * 获取当前规范机器可读项目快照
   * 所有的 result_state 均从底层规范事实确定性纯函数式派生
   * @returns {object}
   */
  getSnapshot() {
    const endpointsSnapshot = {
      browser: {
        endpoint: 'browser',
        result_state: deriveEndpointResult(this._endpoints.browser),
        latest_completed_cursor: this._endpoints.browser.latest_completed_cursor,
        last_handled_cursor: this._endpoints.browser.last_handled_cursor,
        turn_id: this._endpoints.browser.latest_completed_cursor,
        last_handled_turn_id: this._endpoints.browser.last_handled_cursor,
        completed_at: this._endpoints.browser.completed_at,
        continuity: { ...this._endpoints.browser.continuity },
        unknown_reason: this._endpoints.browser.continuity.trusted ? null : this._endpoints.browser.continuity.unknown_reason,
        updated_at: this._endpoints.browser.updated_at
      },
      ide: {
        endpoint: 'ide',
        result_state: deriveEndpointResult(this._endpoints.ide),
        latest_completed_cursor: this._endpoints.ide.latest_completed_cursor,
        last_handled_cursor: this._endpoints.ide.last_handled_cursor,
        turn_id: this._endpoints.ide.latest_completed_cursor,
        last_handled_turn_id: this._endpoints.ide.last_handled_cursor,
        completed_at: this._endpoints.ide.completed_at,
        continuity: { ...this._endpoints.ide.continuity },
        unknown_reason: this._endpoints.ide.continuity.trusted ? null : this._endpoints.ide.continuity.unknown_reason,
        updated_at: this._endpoints.ide.updated_at
      }
    };

    return formatStatusSnapshot({
      binding: this._binding,
      endpoints: endpointsSnapshot,
      humanIntervention: this._humanIntervention,
      actions: this._actions,
      updatedAt: this._updatedAt
    });
  }

  /**
   * 获取紧凑人类可读文本视图（与机器快照同源）
   * @returns {string}
   */
  toCompactView() {
    return formatCompactStatus(this.getSnapshot());
  }
}
