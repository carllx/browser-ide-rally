/**
 * Status Core — 单个 Project Binding 的规范状态核心
 *
 * 核心设计原则 (Core Principles):
 * 1. 宿主独立、Relay 可选：不依赖任何 Relay Exchange 即可独立运作；
 * 2. 端点独立：Browser 与 IDE 的 Endpoint Result 独立更新，支持 Dual NEW 共存；
 * 3. 确定性三态：Endpoint Result 确定性地仅推导为 NEW、NO_NEW_RESULT 或 UNKNOWN，严禁使用 IDLE；
 * 4. Fail-closed 优先：连续性中断或归属异常时 UNKNOWN 优先，绝不退化为便利性所有权猜测；
 * 5. 事实解耦：Action 事实与 Human Intervention 事实与 Endpoint Result 独立并存，绝不相互篡改；
 * 6. 无唯一所有者：不持久化、不推断 Baton、owner 或“轮到谁”。
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

    // 独立初始化 Browser 与 IDE 两个端点的观察事实
    this._endpoints = {
      browser: {
        endpoint: 'browser',
        result_state: 'UNKNOWN',
        turn_id: null,
        completed_at: null,
        last_handled_turn_id: null,
        unknown_reason: 'initial_unobserved',
        updated_at: this._updatedAt
      },
      ide: {
        endpoint: 'ide',
        result_state: 'UNKNOWN',
        turn_id: null,
        completed_at: null,
        last_handled_turn_id: null,
        unknown_reason: 'initial_unobserved',
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
   * 更新当前 Binding（例如 rebind 或 revision bump）
   * @param {object} nextBinding 
   */
  updateBinding(nextBinding) {
    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding update: ${validation.errors.join('; ')}`);
    }
    this._binding = { ...nextBinding };
    this._updatedAt = new Date().toISOString();
  }

  /**
   * 记录端点观察事实并确定性推导 Endpoint Result
   * @param {string} endpoint - 'browser' | 'ide'
   * @param {object} observation - 观察输入对象
   */
  recordEndpointObservation(endpoint, observation = {}) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Invalid endpoint "${endpoint}". Must be 'browser' or 'ide'.`);
    }

    const current = this._endpoints[endpoint];
    const now = new Date().toISOString();
    let derivedState = 'UNKNOWN';
    let unknownReason = null;
    let turnId = observation.turn_id ?? current.turn_id;
    let completedAt = observation.completed_at ?? current.completed_at;

    // 1. 归属校验：若提供 conversation_id，必须与当前 binding 匹配
    const expectedConversationId = endpoint === 'browser'
      ? this._binding.browser?.conversation_id
      : this._binding.ide?.conversation_id;

    if (observation.conversation_id && observation.conversation_id !== expectedConversationId) {
      derivedState = 'UNKNOWN';
      unknownReason = `attribution_mismatch: expected ${expectedConversationId}, got ${observation.conversation_id}`;
    }
    // 2. 版本校验：若提供 binding_revision，必须与当前 binding_revision 一致
    else if (observation.binding_revision && observation.binding_revision !== this._binding.binding_revision) {
      derivedState = 'UNKNOWN';
      unknownReason = `stale_revision: expected rev ${this._binding.binding_revision}, got rev ${observation.binding_revision}`;
    }
    // 3. 连续性校验：若显式标记连续性中断或错误，fail-closed 为 UNKNOWN
    else if (observation.continuity_lost || observation.error) {
      derivedState = 'UNKNOWN';
      unknownReason = observation.reason || observation.error || 'continuity_lost';
    }
    // 4. 显式推导态处理（注意绝不接受 IDLE）
    else if (observation.result_state) {
      if (observation.result_state === 'IDLE') {
        derivedState = 'UNKNOWN';
        unknownReason = 'disallowed_idle_state: IDLE is not canonical Endpoint Result truth';
      } else if (ALLOWED_RESULT_STATES.includes(observation.result_state)) {
        derivedState = observation.result_state;
      } else {
        derivedState = 'UNKNOWN';
        unknownReason = `invalid_result_state: ${observation.result_state}`;
      }
    }
    // 5. 基于观察事实自动推导（存在未处理的已归属 turn）
    else if (typeof observation.has_unhandled_completion === 'boolean') {
      derivedState = observation.has_unhandled_completion ? 'NEW' : 'NO_NEW_RESULT';
    } else {
      derivedState = 'UNKNOWN';
      unknownReason = 'insufficient_canonical_facts';
    }

    this._endpoints[endpoint] = {
      endpoint,
      result_state: derivedState,
      turn_id: turnId,
      completed_at: completedAt,
      last_handled_turn_id: observation.last_handled_turn_id ?? current.last_handled_turn_id,
      unknown_reason: unknownReason,
      updated_at: now
    };

    this._updatedAt = now;
  }

  /**
   * 显式标记某端点已处理 (Mark handled)
   * 若当前状态为 UNKNOWN，保持 UNKNOWN（fail-closed），绝不凭空推断为已完成
   * @param {string} endpoint 
   * @param {object} params
   */
  markEndpointHandled(endpoint, { handled_turn_id = null } = {}) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Invalid endpoint "${endpoint}".`);
    }

    const current = this._endpoints[endpoint];
    const now = new Date().toISOString();

    // fail-closed 语义：未知状态不能被标记为正常 caught up
    if (current.result_state === 'UNKNOWN') {
      this._endpoints[endpoint] = {
        ...current,
        updated_at: now
      };
      this._updatedAt = now;
      return;
    }

    const targetTurnId = handled_turn_id || current.turn_id;

    this._endpoints[endpoint] = {
      ...current,
      result_state: 'NO_NEW_RESULT',
      last_handled_turn_id: targetTurnId,
      unknown_reason: null,
      updated_at: now
    };

    this._updatedAt = now;
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
   * 后一阶段绝不能由前一阶段自动假定，必须具有证据
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
   * @returns {object}
   */
  getSnapshot() {
    return formatStatusSnapshot({
      binding: this._binding,
      endpoints: this._endpoints,
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
