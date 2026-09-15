/**
 * Status Core — 单个 Project Binding 的规范状态核心
 *
 * 核心设计原则 (Core Principles):
 * 1. 规范事实优先：Endpoint Result 必须从底层规范事实（latest completed cursor、last handled cursor、continuity/trust）确定性派生，绝不把 NEW / NO_NEW_RESULT 当作可写输入；
 * 2. 连续性信任显式化：连续性信任必须显式提供，无明确信任证据时 fail-closed 到 UNKNOWN，绝不因“无错误”默认信任；未受信观察绝不污染规范游标；
 * 3. 观察与处理严格分离：recordEndpointObservation 只能更新 completion/continuity 事实，绝不接受或推进 last_handled_cursor；
 * 4. 显式推进防静默抹除：last_handled_cursor 仅由显式 markEndpointHandled() 推进至可靠 latest completed cursor，且强制比对 expected_cursor，旧/不匹配/缺失 cursor 绝不能清除当前 NEW；
 * 5. 安全重绑与替换守卫 (#14)：通过 rebindEndpoint() 显式重绑，严格拦截未处理 NEW 结果的静默丢弃；新端点连续性重置为 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION；未变端点事实完整保留；
 * 6. 受信任反序列化 (#14)：专有受信 hydration 缝隙，与 live observation 彻底解耦，安全恢复持久化 handled 游标；
 * 7. 宿主独立、Relay 可选：不依赖任何 Relay Exchange 即可独立运作；
 * 8. 端点独立：Browser 与 IDE 的 Endpoint Result 独立更新，支持 Dual NEW 共存；
 * 9. 确定性三态：Endpoint Result 确定性地仅推导为 NEW、NO_NEW_RESULT 或 UNKNOWN，严禁使用 IDLE；
 * 10. 事实解耦：Action 事实与 Human Intervention 事实与 Endpoint Result 独立并存，绝不相互篡改；
 * 11. 无唯一所有者：不持久化、不推断 Baton、owner 或“轮到谁”。
 */

import { validateBinding, bumpRevision } from '../controller/binding.js';
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
 * 严格防范假值游标（如 0 或空字符串）漏判
 * @param {object} endpointFact
 * @returns {'NEW' | 'NO_NEW_RESULT' | 'UNKNOWN'}
 */
export function deriveEndpointResult(endpointFact) {
  if (!endpointFact || !endpointFact.continuity || !endpointFact.continuity.trusted) {
    return 'UNKNOWN';
  }

  const { latest_completed_cursor, last_handled_cursor } = endpointFact;

  // 若存在可靠的最新完成游标，且未被 Rally 明确 handled，则确定性派生为 NEW
  if (
    latest_completed_cursor !== null &&
    latest_completed_cursor !== undefined &&
    latest_completed_cursor !== last_handled_cursor
  ) {
    return 'NEW';
  }

  // 连续性受信且所有已知完成均已处理（或无未处理完成）时，派生为 NO_NEW_RESULT
  return 'NO_NEW_RESULT';
}

/**
 * 创建 Project Status Core 实例
 * @param {object} params
 * @param {object} params.binding - Project Binding 对象
 * @param {object} [params.initial_endpoints] - 受信持久化恢复事实
 * @returns {ProjectStatusCore}
 */
export function createProjectStatusCore({ binding, initial_endpoints = null }) {
  return new ProjectStatusCore({ binding, initial_endpoints });
}

export class ProjectStatusCore {
  /**
   * @param {object} options
   * @param {object} options.binding - Project Binding 实例
   * @param {object} [options.initial_endpoints] - 受信持久化恢复事实
   */
  constructor({ binding, initial_endpoints = null }) {
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

    if (initial_endpoints) {
      this.hydrateEndpoints(initial_endpoints);
    }

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
   * 受信反序列化/恢复端点状态专用缝隙 (#14)
   * 专供 Registry/持久化层恢复持久化端点事实，与 live observation 彻底解耦
   * @param {object} endpointsFactMap 
   */
  hydrateEndpoints(endpointsFactMap) {
    if (!endpointsFactMap || typeof endpointsFactMap !== 'object') {
      return;
    }

    for (const ep of ALLOWED_ENDPOINTS) {
      const fact = endpointsFactMap[ep];
      if (fact && typeof fact === 'object') {
        const slotMatch = fact.endpoint === ep;
        const hasLatest = 'latest_completed_cursor' in fact && fact.latest_completed_cursor !== undefined;
        const hasHandled = 'last_handled_cursor' in fact && fact.last_handled_cursor !== undefined;
        const isTrustedDeclared = Boolean(fact.continuity?.trusted);

        let trusted = false;
        let unknownReason = null;

        // 若持久化数据声明受信任，必须完整具备 canonical cursor ledger 结构且 slot 匹配
        if (isTrustedDeclared) {
          if (!slotMatch || !hasLatest || !hasHandled) {
            // 缺失规范字段或 slot 不匹配：绝不能被当成 NO_NEW_RESULT，fail-closed 到 UNKNOWN！
            trusted = false;
            unknownReason = 'incomplete_persisted_cursor_ledger: trusted endpoint requires explicit cursor fields and matching slot';
          } else {
            trusted = true;
            unknownReason = null;
          }
        } else {
          trusted = false;
          unknownReason = fact.continuity?.unknown_reason || 'initial_unobserved';
        }

        this._endpoints[ep] = {
          endpoint: ep,
          latest_completed_cursor: trusted ? fact.latest_completed_cursor : null,
          last_handled_cursor: trusted ? fact.last_handled_cursor : null,
          completed_at: fact.completed_at ?? null,
          continuity: {
            trusted,
            unknown_reason: unknownReason
          },
          updated_at: fact.updated_at || this._updatedAt
        };
      }
    }
  }

  /**
   * 导出内部规范持久化状态
   * @returns {object}
   */
  exportState() {
    return {
      binding: { ...this._binding },
      endpoints: {
        browser: {
          ...this._endpoints.browser,
          continuity: { ...this._endpoints.browser.continuity }
        },
        ide: {
          ...this._endpoints.ide,
          continuity: { ...this._endpoints.ide.continuity }
        }
      },
      human_intervention: { ...this._humanIntervention },
      actions: this._actions.map(a => ({ ...a })),
      updated_at: this._updatedAt
    };
  }

  /**
   * 获取当前绑定的快照副本
   */
  getBinding() {
    return { ...this._binding };
  }

  /**
   * 更新当前 Binding（仅限保持身份的更新，如 revision bump 或 paused 切换）
   * 严格禁止通过本方法跨 conversation 不安全 rebind
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

    // 身份守卫：端点身份变更属于 #14 safe rebind，必须调用 rebindEndpoint()
    const browserChanged =
      nextBinding.browser.provider !== this._binding.browser.provider ||
      nextBinding.browser.conversation_id !== this._binding.browser.conversation_id;

    const ideChanged =
      nextBinding.ide.conversation_id !== this._binding.ide.conversation_id ||
      nextBinding.ide.workspace_identity !== this._binding.ide.workspace_identity ||
      nextBinding.ide.repository_identity !== this._binding.ide.repository_identity;

    if (browserChanged || ideChanged) {
      throw new Error(
        'Identity-changing rebind is prohibited in Status Core; use rebindEndpoint() for safe rebind (#14).'
      );
    }

    this._binding = { ...nextBinding };
    this._updatedAt = new Date().toISOString();
  }

  /**
   * 安全端点重绑 (Safe Endpoint Rebind, #14)
   *
   * 规范契约 (Spec Invariants):
   * 1. 保持 Project Binding 身份不变，版本号递增 (binding_revision += 1)；
   * 2. 单次仅重绑一个端点（Browser 或 IDE），未替换端点的事实完全保持不变；
   * 3. 未处理 NEW 替换守卫：若被替换端点当前存在未处理 NEW，默认拒绝替换；除非显式传 allow_discard_unhandled: true；
   * 4. 显式丢弃未处理 NEW 时，绝不伪造 mark handled；
   * 5. 新绑定的端点连续性事实尚未确立，初始进入 UNKNOWN 状态，原因明确为 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION。
   *
   * @param {object} params
   * @param {'browser' | 'ide'} params.endpoint - 待重绑的端点
   * @param {object} params.identity - 新端点身份信息
   * @param {boolean} [params.allow_discard_unhandled=false] - 是否显式确认丢弃未处理 NEW
   * @returns {object} 更新后的项目快照
   */
  rebindEndpoint({ endpoint, identity, allow_discard_unhandled = false }) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Invalid endpoint "${endpoint}". Must be 'browser' or 'ide'.`);
    }

    if (!identity || typeof identity !== 'object') {
      throw new Error('New endpoint identity must be a valid object');
    }

    // 1. 未处理 NEW 替换守卫 (Unhandled NEW Replacement Guard)
    const currentTargetFact = this._endpoints[endpoint];
    const currentDerivedState = deriveEndpointResult(currentTargetFact);

    if (currentDerivedState === 'NEW' && !allow_discard_unhandled) {
      throw new Error(
        `Cannot replace ${endpoint} endpoint with unhandled NEW result without explicit confirmation (allow_discard_unhandled: true).`
      );
    }

    const now = new Date().toISOString();

    // 2. 递增 binding_revision 并更新指定端点的身份
    const nextBinding = bumpRevision(this._binding);
    if (endpoint === 'browser') {
      if (!identity.conversation_id || typeof identity.conversation_id !== 'string') {
        throw new Error('New browser identity requires valid conversation_id');
      }
      nextBinding.browser = {
        provider: identity.provider || this._binding.browser?.provider || 'chatgpt',
        conversation_id: identity.conversation_id
      };
    } else {
      if (!identity.conversation_id || !identity.workspace_identity || !identity.repository_identity) {
        throw new Error('New ide identity requires conversation_id, workspace_identity, and repository_identity');
      }
      nextBinding.ide = {
        conversation_id: identity.conversation_id,
        workspace_identity: identity.workspace_identity,
        repository_identity: identity.repository_identity
      };
    }

    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Rebind configuration: ${validation.errors.join('; ')}`);
    }

    this._binding = nextBinding;

    // 3. 重置被重绑端点的规范事实为 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION
    // 未被重绑的另一个端点完全保持原状！
    this._endpoints[endpoint] = {
      endpoint,
      latest_completed_cursor: null,
      last_handled_cursor: null,
      completed_at: null,
      continuity: {
        trusted: false,
        unknown_reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      },
      updated_at: now
    };

    this._updatedAt = now;
    return this.getSnapshot();
  }

  /**
   * 记录端点底层规范事实（Opaque latest completed cursor、completed_at、continuity/trust）
   *
   * 规范约束 (Invariants):
   * 1. 严格禁止传入 NEW / NO_NEW_RESULT 作为权威事实写入；
   * 2. 连续性信任必须显式提供 (trusted: true 或 continuity: { trusted: true })，无显式信任证据时 fail-closed 为 UNKNOWN；
   * 3. 绝不读取或修改 last_handled_cursor：live observation 只能更新 completion/continuity 事实，handled 只能由 markEndpointHandled() 推进；
   * 4. 未受信观察绝不写入或污染 latest_completed_cursor。
   *
   * @param {string} endpoint - 'browser' | 'ide'
   * @param {object} observation - 规范事实输入
   */
  recordEndpointObservation(endpoint, observation = {}) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Invalid endpoint "${endpoint}". Must be 'browser' or 'ide'.`);
    }

    const current = this._endpoints[endpoint];
    const now = new Date().toISOString();

    const expectedConversationId = endpoint === 'browser'
      ? this._binding.browser?.conversation_id
      : this._binding.ide?.conversation_id;

    const isExplicitlyTrusted = observation.trusted === true || observation.continuity?.trusted === true;

    let trusted = false;
    let unknownReason = null;

    // 1. 拒绝非法的 IDLE 状态传入，fail-closed 到 UNKNOWN
    if (observation.result_state === 'IDLE') {
      trusted = false;
      unknownReason = 'disallowed_idle_state: IDLE is not canonical Endpoint Result truth';
    }
    // 2. 连续性校验：若显式报告连续性断裂或错误，fail-closed 为 UNKNOWN
    else if (observation.continuity_lost || observation.error) {
      trusted = false;
      unknownReason = observation.reason || observation.error || 'continuity_lost';
    }
    // 3. 归属校验：若提供 conversation_id，必须与当前 binding 严格匹配；缺失时不可建立信任
    else if (!observation.conversation_id || observation.conversation_id !== expectedConversationId) {
      trusted = false;
      unknownReason = observation.conversation_id
        ? `attribution_mismatch: expected ${expectedConversationId}, got ${observation.conversation_id}`
        : 'missing_conversation_identity: explicit conversation_id matching binding is required';
    }
    // 4. 版本校验：若提供 binding_revision，必须与当前 binding_revision 一致
    else if (observation.binding_revision && observation.binding_revision !== this._binding.binding_revision) {
      trusted = false;
      unknownReason = `stale_revision: expected rev ${this._binding.binding_revision}, got rev ${observation.binding_revision}`;
    }
    // 5. 显式信任要求：无显式信任证据时绝不自动受信
    else if (!isExplicitlyTrusted) {
      trusted = false;
      unknownReason = 'unverified_continuity: explicit trust fact required';
    }
    // 6. 所有信任与归属检查均通过，连续性受信
    else {
      trusted = true;
      unknownReason = null;
    }

    // 提取完成游标事实：仅在连续性受信时才允许更新游标；未受信观察绝不污染已有的完成游标
    let latestCursor = current.latest_completed_cursor;
    let completedAt = current.completed_at;

    if (trusted) {
      if (observation.latest_completed_cursor !== undefined) {
        latestCursor = observation.latest_completed_cursor;
      }
      if (observation.completed_at !== undefined) {
        completedAt = observation.completed_at;
      }
    }

    // 注意：绝不更新 last_handled_cursor，严格保持 current.last_handled_cursor！
    this._endpoints[endpoint] = {
      endpoint,
      latest_completed_cursor: latestCursor,
      last_handled_cursor: current.last_handled_cursor,
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
   * 强制比对 expected_cursor：若未提供、或与当前 latest cursor 不匹配，绝不能清除 NEW
   * @param {string} endpoint 
   * @param {object} params
   * @param {string} params.expected_cursor - 预期的游标，必须与当前 latest_completed_cursor 一致
   * @returns {{ success: boolean, reason?: string, handled_cursor?: string }}
   */
  markEndpointHandled(endpoint, { expected_cursor } = {}) {
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
    if (current.latest_completed_cursor === null || current.latest_completed_cursor === undefined) {
      return { success: false, reason: 'no_latest_completed_cursor' };
    }

    // 3. 强制比对 expected_cursor：未提供或游标不匹配时，绝不能清除当前 NEW！
    if (expected_cursor === null || expected_cursor === undefined || expected_cursor !== current.latest_completed_cursor) {
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
   * 代理委托至 setHumanIntervention 消除重复
   */
  clearHumanIntervention() {
    this.setHumanIntervention({ active: false, reason: null });
  }

  /**
   * 记录动作事实
   * 独立共存：动作事实记录与 Endpoint Result 互不干扰
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
