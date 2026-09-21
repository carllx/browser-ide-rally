/**
 * Status Core — 单个 Project Binding 的规范状态核心
 * 
 * 领域不变式与核心语义：
 * 1. 1 Canonical Browser + 1..N Concurrent IDE Endpoints；
 * 2. 规范事实优先，确定性派生 NEW / NO_NEW_RESULT / UNKNOWN；
 * 3. 严格布尔受信与连续性 fail-closed；显式推进防静默抹除；
 * 4. 独立端点寻址与同级隔离：采用 endpoint_id + endpoint_revision + exact provider identity；
 *    Sibling IDE 的增删改不导致未变动 IDE 的有效 observation 变为 stale；
 * 5. 安全生命周期守卫：委托 endpoint-lifecycle 执行；
 * 6. 禁止移除至 0 个 IDE 端点；绝不引入 Baton / Owner / Next Actor；
 * 7. updateBinding 严格守卫：禁止变更任何 IDE 拓扑、端点成员、provider 身份或版本，堵死绕过漏洞。
 */

import { validateBinding } from '../controller/binding.js';
import {
  deriveEndpointResult,
  createInitialEndpointFact,
  hydrateEndpointFact,
  verifyObservationContinuity,
  validateAndNormalizeResultMaterial
} from './endpoint-ledger.js';
import {
  ALLOWED_ACTION_STAGES,
  createActionFact,
  transitionActionStage
} from './action-ledger.js';
import {
  executeAddIdeEndpoint,
  executeRemoveIdeEndpoint,
  executeRebindEndpoint
} from './endpoint-lifecycle.js';
import { formatStatusSnapshot, formatCompactStatus } from './status-view.js';
import {
  createInitialOrderingEvidence,
  hydrateOrderingEvidence,
  recordLiveWitnessedCompletion,
  reconcileProjectOrdering,
  rebaselineOrderingOnLifecycle
} from './ordering-ledger.js';

export { deriveEndpointResult, ALLOWED_ACTION_STAGES };

export function createProjectStatusCore({
  binding,
  initial_endpoints = null,
  initial_ordering_evidence = null,
  onMutation = null
}) {
  return new ProjectStatusCore({ binding, initial_endpoints, initial_ordering_evidence, onMutation });
}

export class ProjectStatusCore {
  constructor({ binding, initial_endpoints = null, initial_ordering_evidence = null, onMutation = null }) {
    const validation = validateBinding(binding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding for Status Core: ${validation.errors.join('; ')}`);
    }

    this._binding = { ...binding };
    this._updatedAt = new Date().toISOString();
    this._onMutation = typeof onMutation === 'function' ? onMutation : null;
    this._isLegacySingleIdeAuthority = Boolean(
      binding.is_legacy_single_ide ?? (binding.ide && (!Array.isArray(binding.ide_endpoints) || binding.ide_endpoints.length <= 1))
    );

    this._browserEndpoint = createInitialEndpointFact({
      endpoint: 'browser',
      role: 'browser',
      endpoint_revision: 1,
      updated_at: this._updatedAt
    });

    this._ideEndpoints = new Map();
    const ideList = this._binding.ide_endpoints || [];
    for (const ep of ideList) {
      this._ideEndpoints.set(
        ep.endpoint_id,
        createInitialEndpointFact({
          endpoint: ep.endpoint_id,
          role: 'ide',
          endpoint_revision: ep.endpoint_revision || 1,
          updated_at: this._updatedAt
        })
      );
    }

    if (initial_endpoints) {
      this.hydrateEndpoints(initial_endpoints);
    }

    this._humanIntervention = {
      active: false,
      reason: null,
      updated_at: this._updatedAt
    };

    this._actions = [];
    this._orderingEvidence = hydrateOrderingEvidence(initial_ordering_evidence, {
      fallbackUpdatedAt: this._updatedAt,
      initialEndpointsCursors: this._getAllCurrentCursors()
    });
  }

  _getAllCurrentCursors() {
    const ideCursors = {};
    for (const [id, fact] of this._ideEndpoints.entries()) {
      ideCursors[id] = fact.latest_completed_cursor ?? null;
    }
    return {
      browser: this._browserEndpoint.latest_completed_cursor ?? null,
      ide: ideCursors
    };
  }

  _resolveEndpoint(endpointIdentifier) {
    if (!endpointIdentifier || typeof endpointIdentifier !== 'string') return null;
    if (endpointIdentifier === 'browser') {
      return { role: 'browser', id: 'browser', fact: this._browserEndpoint, config: this._binding.browser };
    }
    if (this._ideEndpoints.has(endpointIdentifier)) {
      const config = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === endpointIdentifier);
      return { role: 'ide', id: endpointIdentifier, fact: this._ideEndpoints.get(endpointIdentifier), config };
    }
    if (endpointIdentifier === 'ide' && this._ideEndpoints.size === 1) {
      const onlyId = Array.from(this._ideEndpoints.keys())[0];
      const config = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === onlyId);
      return { role: 'ide', id: onlyId, fact: this._ideEndpoints.get(onlyId), config };
    }
    return null;
  }

  hydrateEndpoints(endpointsFactMap) {
    if (!endpointsFactMap || typeof endpointsFactMap !== 'object') {
      return;
    }

    if (endpointsFactMap.browser) {
      this._browserEndpoint = hydrateEndpointFact(
        endpointsFactMap.browser,
        'browser',
        { role: 'browser', endpoint_revision: 1, fallbackUpdatedAt: this._updatedAt }
      );
    }

    const ideFactsSource = endpointsFactMap.ide_endpoints || {};
    for (const [epId, fact] of Object.entries(ideFactsSource)) {
      if (this._ideEndpoints.has(epId)) {
        const boundEp = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === epId);
        const epRev = boundEp?.endpoint_revision || 1;
        this._ideEndpoints.set(
          epId,
          hydrateEndpointFact(fact, epId, { role: 'ide', endpoint_revision: epRev, fallbackUpdatedAt: this._updatedAt })
        );
      }
    }

    if (endpointsFactMap.ide && this._ideEndpoints.size === 1) {
      const onlyId = Array.from(this._ideEndpoints.keys())[0];
      const boundEp = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === onlyId);
      const epRev = boundEp?.endpoint_revision || 1;
      this._ideEndpoints.set(
        onlyId,
        hydrateEndpointFact(endpointsFactMap.ide, onlyId, { role: 'ide', endpoint_revision: epRev, fallbackUpdatedAt: this._updatedAt })
      );
    }
  }

  exportState() {
    const ideEndpointsObj = {};
    for (const [id, fact] of this._ideEndpoints.entries()) {
      ideEndpointsObj[id] = { ...fact, continuity: { ...fact.continuity } };
    }
    return {
      binding: {
        ...this._binding,
        browser: { ...this._binding.browser },
        ide_endpoints: (this._binding.ide_endpoints || []).map(ep => ({ ...ep }))
      },
      endpoints: {
        browser: { ...this._browserEndpoint, continuity: { ...this._browserEndpoint.continuity } },
        ide_endpoints: ideEndpointsObj,
        ide: this._ideEndpoints.size === 1
          ? { ...Array.from(this._ideEndpoints.values())[0], continuity: { ...Array.from(this._ideEndpoints.values())[0].continuity } }
          : null
      },
      ordering_evidence: this.getOrderingEvidence(),
      human_intervention: { ...this._humanIntervention },
      actions: this._actions.map(a => ({ ...a })),
      updated_at: this._updatedAt
    };
  }

  getBinding() {
    return {
      ...this._binding,
      ide_endpoints: (this._binding.ide_endpoints || []).map(ep => ({ ...ep }))
    };
  }

  isLegacySingleIdeAuthority() {
    return Boolean(this._isLegacySingleIdeAuthority && this._ideEndpoints.size === 1);
  }

  addIdeEndpoint({ endpoint_id, identity }) {
    this._isLegacySingleIdeAuthority = false;
    if (this._binding) {
      this._binding.is_legacy_single_ide = false;
    }
    const res = executeAddIdeEndpoint({
      binding: this._binding,
      ideEndpointsMap: this._ideEndpoints,
      endpoint_id,
      identity
    });
    this._binding = res.nextBinding;
    this._ideEndpoints.set(res.cleanId, res.newFact);
    this._updatedAt = res.now;
    this._orderingEvidence = rebaselineOrderingOnLifecycle(this._orderingEvidence, {
      mutationType: 'ADD',
      targetRole: 'ide',
      targetId: res.cleanId,
      allCurrentCursors: this._getAllCurrentCursors(),
      now: res.now
    });
    return this.getSnapshot();
  }

  removeIdeEndpoint(endpointId, options = {}) {
    if (endpointId === 'browser') {
      throw new Error('Cannot remove canonical browser endpoint');
    }
    const resolved = this._resolveEndpoint(endpointId);
    if (!resolved || resolved.role !== 'ide') {
      throw new Error(`IDE endpoint "${endpointId}" not found`);
    }

    const res = executeRemoveIdeEndpoint({
      binding: this._binding,
      ideEndpointsMap: this._ideEndpoints,
      resolvedEndpoint: resolved,
      options
    });

    this._binding = res.nextBinding;
    this._ideEndpoints.delete(res.removedId);
    this._updatedAt = res.now;
    this._orderingEvidence = rebaselineOrderingOnLifecycle(this._orderingEvidence, {
      mutationType: 'REMOVE',
      targetRole: 'ide',
      targetId: res.removedId,
      allCurrentCursors: this._getAllCurrentCursors(),
      now: res.now
    });
    return this.getSnapshot();
  }

  rebindEndpoint(rebindParams) {
    const targetIdentifier = rebindParams.endpoint_id || rebindParams.endpoint;
    const resolved = this._resolveEndpoint(targetIdentifier);
    if (!resolved) {
      throw new Error(`Invalid endpoint identifier "${targetIdentifier}".`);
    }

    const res = executeRebindEndpoint({
      binding: this._binding,
      resolvedEndpoint: resolved,
      identity: rebindParams.identity,
      options: rebindParams
    });

    this._binding = res.nextBinding;
    if (res.targetRole === 'browser') {
      this._browserEndpoint = res.newBrowserFact;
    } else {
      this._ideEndpoints.set(res.targetId, res.newIdeFact);
    }
    this._updatedAt = res.now;
    this._orderingEvidence = rebaselineOrderingOnLifecycle(this._orderingEvidence, {
      mutationType: 'REBIND',
      targetRole: res.targetRole,
      targetId: res.targetId,
      allCurrentCursors: this._getAllCurrentCursors(),
      now: res.now
    });
    return this.getSnapshot();
  }

  recordEndpointObservation(endpointIdentifier, observation = {}) {
    const resolved = this._resolveEndpoint(endpointIdentifier);
    if (!resolved) {
      throw new Error(`Invalid endpoint "${endpointIdentifier}".`);
    }

    if (observation.is_generating === true || observation.should_record === false) {
      return;
    }

    const current = resolved.fact;
    const now = new Date().toISOString();
    const targetEpRev = resolved.config?.endpoint_revision || current.endpoint_revision || 1;
    const isLegacySingleIdeAuthority = Boolean(
      this._isLegacySingleIdeAuthority && this._ideEndpoints.size === 1
    );

    const continuityRes = verifyObservationContinuity({
      observation,
      expectedConfig: resolved.config,
      targetEpRev,
      isBrowser: resolved.role === 'browser',
      bindingRevision: this._binding.binding_revision,
      ideCount: this._ideEndpoints.size,
      isLegacySingleIdeAuthority
    });

    // 1. 如果是确凿过时的端点代际观察 (conclusively stale endpoint-generation observation)，
    // 绝不能篡改当前规范端点事实，直接拒绝并作为 NO-OP 返回
    if (continuityRes.staleGeneration) {
      return;
    }

    const { trusted, unknownReason } = continuityRes;

    let latestCursor = current.latest_completed_cursor;
    let completedAt = current.completed_at;
    let latestResult = current.latest_completed_result;

    if (trusted) {
      const cursorChanged = observation.latest_completed_cursor !== undefined &&
        observation.latest_completed_cursor !== current.latest_completed_cursor;

      if (observation.latest_completed_cursor !== undefined) {
        latestCursor = observation.latest_completed_cursor;
      }
      if (observation.completed_at !== undefined) {
        completedAt = observation.completed_at;
      }

      if (cursorChanged) {
        // 游标发生变化：只有新 artifact 存在且规范有效、cursor 精确匹配新 cursor 时才安装，否则清除为 null
        latestResult = validateAndNormalizeResultMaterial(
          observation.latest_completed_result,
          latestCursor,
          completedAt || now
        );
      } else {
        // 游标未发生变化
        if (observation.latest_completed_result !== undefined) {
          latestResult = validateAndNormalizeResultMaterial(
            observation.latest_completed_result,
            latestCursor,
            completedAt || now
          );
        } else {
          // 未提供 result material：若已有 artifact 仍合规且与当前 cursor 匹配则保留，否则置为 null
          latestResult = validateAndNormalizeResultMaterial(
            latestResult,
            latestCursor,
            completedAt || now
          );
        }
      }
    } else {
      // 未受信：若已有 artifact 与当前 cursor 不匹配或不合规，则置为 null
      latestResult = validateAndNormalizeResultMaterial(
        latestResult,
        latestCursor,
        completedAt || now
      );
    }

    const updatedFact = {
      ...current,
      latest_completed_cursor: latestCursor,
      last_handled_cursor: current.last_handled_cursor,
      completed_at: completedAt,
      latest_completed_result: latestResult,
      continuity: {
        trusted,
        unknown_reason: unknownReason
      },
      updated_at: now
    };

    if (resolved.role === 'browser') {
      this._browserEndpoint = updatedFact;
    } else {
      this._ideEndpoints.set(resolved.id, updatedFact);
    }

    // 仅在受信任且明确声明 live_witnessed 时推进 ordering evidence
    if (trusted && observation.live_witnessed === true && latestCursor !== null && latestCursor !== undefined) {
      this._orderingEvidence = recordLiveWitnessedCompletion(this._orderingEvidence, {
        endpointId: resolved.role === 'browser' ? 'browser' : resolved.id,
        cursor: latestCursor,
        allCurrentCursors: this._getAllCurrentCursors(),
        now
      });
    }

    this._updatedAt = now;
    if (this._onMutation) {
      this._onMutation();
    }
  }

  markEndpointHandled(endpointIdentifier, { expected_cursor } = {}) {
    const resolved = this._resolveEndpoint(endpointIdentifier);
    if (!resolved) {
      throw new Error(`Invalid endpoint "${endpointIdentifier}".`);
    }

    const current = resolved.fact;
    const now = new Date().toISOString();

    if (!current.continuity.trusted) {
      return { success: false, reason: 'continuity_not_trusted' };
    }

    if (current.latest_completed_cursor === null || current.latest_completed_cursor === undefined) {
      return { success: false, reason: 'no_latest_completed_cursor' };
    }

    if (expected_cursor === null || expected_cursor === undefined || expected_cursor !== current.latest_completed_cursor) {
      return { success: false, reason: 'cursor_mismatch' };
    }

    current.last_handled_cursor = current.latest_completed_cursor;
    current.updated_at = now;
    this._updatedAt = now;
    if (this._onMutation) {
      this._onMutation();
    }

    return { success: true, handled_cursor: current.last_handled_cursor };
  }

  setHumanIntervention({ active = true, reason = null } = {}) {
    const isActive = Boolean(active);
    let normalizedReason = null;
    if (isActive) {
      if (typeof reason !== 'string' || !reason.trim()) {
        throw new Error('Human intervention reason must be a non-empty string when active: true');
      }
      normalizedReason = reason.trim();
    }
    const now = new Date().toISOString();
    this._humanIntervention = { active: isActive, reason: normalizedReason, updated_at: now };
    this._updatedAt = now;
    if (this._onMutation) this._onMutation();
  }

  clearHumanIntervention() {
    this.setHumanIntervention({ active: false, reason: null });
  }

  recordActionFact(actionParams = {}) {
    const fact = createActionFact({
      ...actionParams,
      binding_revision: actionParams.binding_revision ?? this._binding.binding_revision
    });
    this._actions.push(fact);
    this._updatedAt = fact.updated_at;
    if (this._onMutation) this._onMutation();
    return fact;
  }

  advanceActionStage(actionId, { next_stage, evidence }) {
    const action = this._actions.find(a => a.action_id === actionId);
    if (!action) {
      throw new Error(`Action "${actionId}" not found`);
    }
    const updated = transitionActionStage(action, { next_stage, evidence });
    this._updatedAt = updated.updated_at;
    if (this._onMutation) {
      this._onMutation();
    }
    return updated;
  }

  setOnMutation(fn) {
    this._onMutation = typeof fn === 'function' ? fn : null;
  }

  updateBinding(nextBinding) {
    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding update: ${validation.errors.join('; ')}`);
    }

    if (nextBinding.binding_id !== this._binding.binding_id) {
      throw new Error(`Cannot change binding_id from "${this._binding.binding_id}" to "${nextBinding.binding_id}".`);
    }

    // 1. Browser 身份守卫
    const browserChanged =
      nextBinding.browser?.provider !== this._binding.browser?.provider ||
      nextBinding.browser?.conversation_id !== this._binding.browser?.conversation_id ||
      (nextBinding.browser?.branch || null) !== (this._binding.browser?.branch || null);

    if (browserChanged) {
      throw new Error('Identity-changing rebind is prohibited in Status Core; use rebindEndpoint() for safe rebind (#14).');
    }

    // 2. IDE 拓扑与身份守卫 (Blocker 2)
    // 禁止通过 updateBinding 绕过生命周期守卫修改 IDE 数量、端点 ID、会话、工作区、仓库或 endpoint_revision
    const currIdeList = this._binding.ide_endpoints || [];
    const nextIdeList = nextBinding.ide_endpoints || [];

    if (currIdeList.length !== nextIdeList.length) {
      throw new Error('Topology-changing add/remove of IDE endpoints is prohibited in updateBinding; use addIdeEndpoint() or removeIdeEndpoint().');
    }

    for (let i = 0; i < currIdeList.length; i++) {
      const curr = currIdeList[i];
      const next = nextIdeList.find(e => e.endpoint_id === curr.endpoint_id);
      if (!next) {
        throw new Error(`IDE endpoint membership change ("${curr.endpoint_id}" missing) is prohibited in updateBinding; use removeIdeEndpoint().`);
      }
      if (
        next.conversation_id !== curr.conversation_id ||
        next.workspace_identity !== curr.workspace_identity ||
        next.repository_identity !== curr.repository_identity ||
        next.endpoint_revision !== curr.endpoint_revision
      ) {
        throw new Error(`IDE endpoint identity or revision mutation for "${curr.endpoint_id}" is prohibited in updateBinding; use rebindEndpoint().`);
      }
    }

    this._binding = { ...nextBinding };
    this._updatedAt = new Date().toISOString();
  }

  reconcileProjectOrdering() {
    const cursors = this._getAllCurrentCursors();
    const now = new Date().toISOString();
    this._orderingEvidence = reconcileProjectOrdering(this._orderingEvidence, {
      browserCursor: cursors.browser,
      ideCursorsMap: cursors.ide,
      now
    });
    this._updatedAt = now;
    if (this._onMutation) {
      this._onMutation();
    }
    return this.getSnapshot();
  }

  getOrderingEvidence() {
    return {
      ...this._orderingEvidence,
      checkpoint_cursors: {
        browser: this._orderingEvidence.checkpoint_cursors?.browser ?? null,
        ide: { ...(this._orderingEvidence.checkpoint_cursors?.ide || {}) }
      }
    };
  }

  getSnapshot() {
    return formatStatusSnapshot({
      binding: this._binding,
      endpoints: {
        browser: this._browserEndpoint,
        ide_endpoints: this._ideEndpoints
      },
      orderingEvidence: this._orderingEvidence,
      humanIntervention: this._humanIntervention,
      actions: this._actions,
      updatedAt: this._updatedAt
    });
  }

  toCompactView() {
    return formatCompactStatus(this.getSnapshot());
  }
}
