/**
 * Status Core — 单个 Project Binding 的规范状态核心
 * 
 * 领域不变式与核心语义：
 * 1. 1 Canonical Browser + 1..N Concurrent IDE Endpoints；
 * 2. 规范事实优先，确定性派生 NEW / NO_NEW_RESULT / UNKNOWN；
 * 3. 严格布尔受信与连续性 fail-closed；显式推进防静默抹除；
 * 4. 独立端点寻址与同级隔离：采用 endpoint_id + endpoint_revision + exact provider identity；
 *    Sibling IDE 的增删改不导致未变动 IDE 的有效 observation 变为 stale；
 * 5. 安全生命周期守卫：NEW 与 UNKNOWN 移除/重绑必须显式确认，且绝不伪装为 Mark handled；
 * 6. 禁止移除至 0 个 IDE 端点；绝不引入 Baton / Owner / Next Actor。
 */

import { validateBinding, bumpRevision } from '../controller/binding.js';
import {
  deriveEndpointResult,
  createInitialEndpointFact,
  hydrateEndpointFact,
  verifyObservationContinuity
} from './endpoint-ledger.js';
import {
  ALLOWED_ACTION_STAGES,
  createActionFact,
  transitionActionStage
} from './action-ledger.js';
import { formatStatusSnapshot, formatCompactStatus } from './status-view.js';

export { deriveEndpointResult, ALLOWED_ACTION_STAGES };

export function createProjectStatusCore({ binding, initial_endpoints = null }) {
  return new ProjectStatusCore({ binding, initial_endpoints });
}

export class ProjectStatusCore {
  constructor({ binding, initial_endpoints = null }) {
    const validation = validateBinding(binding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding for Status Core: ${validation.errors.join('; ')}`);
    }

    this._binding = { ...binding };
    this._updatedAt = new Date().toISOString();

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
  }

  _resolveEndpoint(endpointIdentifier) {
    if (!endpointIdentifier || typeof endpointIdentifier !== 'string') {
      return null;
    }
    if (endpointIdentifier === 'browser') {
      return {
        role: 'browser',
        id: 'browser',
        fact: this._browserEndpoint,
        config: this._binding.browser
      };
    }
    if (this._ideEndpoints.has(endpointIdentifier)) {
      const config = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === endpointIdentifier);
      return {
        role: 'ide',
        id: endpointIdentifier,
        fact: this._ideEndpoints.get(endpointIdentifier),
        config
      };
    }
    if (endpointIdentifier === 'ide' && this._ideEndpoints.size === 1) {
      const onlyId = Array.from(this._ideEndpoints.keys())[0];
      const config = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === onlyId);
      return {
        role: 'ide',
        id: onlyId,
        fact: this._ideEndpoints.get(onlyId),
        config
      };
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
        const epRev = boundEp?.endpoint_revision || fact.endpoint_revision || 1;
        this._ideEndpoints.set(
          epId,
          hydrateEndpointFact(fact, epId, { role: 'ide', endpoint_revision: epRev, fallbackUpdatedAt: this._updatedAt })
        );
      }
    }

    if (endpointsFactMap.ide && this._ideEndpoints.size === 1) {
      const onlyId = Array.from(this._ideEndpoints.keys())[0];
      const boundEp = (this._binding.ide_endpoints || []).find(e => e.endpoint_id === onlyId);
      const epRev = boundEp?.endpoint_revision || endpointsFactMap.ide.endpoint_revision || 1;
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
        ide_endpoints: (this._binding.ide_endpoints || []).map(ep => ({ ...ep }))
      },
      endpoints: {
        browser: { ...this._browserEndpoint, continuity: { ...this._browserEndpoint.continuity } },
        ide_endpoints: ideEndpointsObj,
        ide: this._ideEndpoints.size === 1
          ? { ...Array.from(this._ideEndpoints.values())[0], continuity: { ...Array.from(this._ideEndpoints.values())[0].continuity } }
          : null
      },
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

  addIdeEndpoint({ endpoint_id, identity }) {
    if (!endpoint_id || typeof endpoint_id !== 'string' || !endpoint_id.trim()) {
      throw new Error('Valid endpoint_id is required to add IDE endpoint');
    }
    const cleanId = endpoint_id.trim();
    if (cleanId === 'browser') {
      throw new Error('IDE endpoint_id cannot be "browser"');
    }
    if (this._ideEndpoints.has(cleanId)) {
      throw new Error(`IDE endpoint "${cleanId}" already exists`);
    }
    if (!identity || !identity.conversation_id || !identity.workspace_identity || !identity.repository_identity) {
      throw new Error('identity requires conversation_id, workspace_identity, and repository_identity');
    }

    const now = new Date().toISOString();
    const nextBinding = bumpRevision(this._binding);
    const newEp = {
      endpoint_id: cleanId,
      endpoint_revision: 1,
      conversation_id: identity.conversation_id,
      workspace_identity: identity.workspace_identity,
      repository_identity: identity.repository_identity
    };
    nextBinding.ide_endpoints.push(newEp);

    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Add IDE configuration: ${validation.errors.join('; ')}`);
    }

    this._binding = nextBinding;
    this._ideEndpoints.set(cleanId, createInitialEndpointFact({
      endpoint: cleanId,
      role: 'ide',
      endpoint_revision: 1,
      updated_at: now
    }));

    this._updatedAt = now;
    return this.getSnapshot();
  }

  removeIdeEndpoint(endpointId, {
    allow_discard_unhandled = false,
    confirm_replace_unhandled_new = false,
    confirm_replace_unknown = false,
    confirm_replace = false
  } = {}) {
    if (endpointId === 'browser') {
      throw new Error('Cannot remove canonical browser endpoint');
    }
    const resolved = this._resolveEndpoint(endpointId);
    if (!resolved || resolved.role !== 'ide') {
      throw new Error(`IDE endpoint "${endpointId}" not found`);
    }

    if (this._ideEndpoints.size <= 1) {
      throw new Error('Cannot remove the last IDE endpoint; Rally project requires at least one IDE endpoint slot');
    }

    const derivedState = deriveEndpointResult(resolved.fact);
    if (derivedState === 'NEW') {
      const confirmed = allow_discard_unhandled || confirm_replace_unhandled_new || confirm_replace;
      if (!confirmed) {
        throw new Error(
          `Cannot remove IDE endpoint "${resolved.id}" with unhandled NEW result without explicit confirmation (allow_discard_unhandled: true).`
        );
      }
    } else if (derivedState === 'UNKNOWN') {
      const confirmed = allow_discard_unhandled || confirm_replace_unknown || confirm_replace;
      if (!confirmed) {
        throw new Error(
          `Cannot remove IDE endpoint "${resolved.id}" in UNKNOWN state without explicit confirmation (confirm_replace_unknown: true or allow_discard_unhandled: true).`
        );
      }
    }

    const now = new Date().toISOString();
    const nextBinding = bumpRevision(this._binding);
    nextBinding.ide_endpoints = nextBinding.ide_endpoints.filter(ep => ep.endpoint_id !== resolved.id);

    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Remove IDE configuration: ${validation.errors.join('; ')}`);
    }

    this._binding = nextBinding;
    this._ideEndpoints.delete(resolved.id);
    this._updatedAt = now;
    return this.getSnapshot();
  }

  rebindEndpoint({
    endpoint,
    endpoint_id,
    identity,
    allow_discard_unhandled = false,
    confirm_replace_unhandled_new = false,
    confirm_replace_unknown = false,
    confirm_replace = false
  }) {
    const targetIdentifier = endpoint_id || endpoint;
    const resolved = this._resolveEndpoint(targetIdentifier);
    if (!resolved) {
      throw new Error(`Invalid endpoint identifier "${targetIdentifier}".`);
    }

    if (!identity || typeof identity !== 'object') {
      throw new Error('New endpoint identity must be a valid object');
    }

    const currentFact = resolved.fact;
    const currentDerivedState = deriveEndpointResult(currentFact);

    if (currentDerivedState === 'NEW') {
      const confirmed = allow_discard_unhandled || confirm_replace_unhandled_new || confirm_replace;
      if (!confirmed) {
        throw new Error(
          `Cannot replace ${resolved.id} endpoint with unhandled NEW result without explicit confirmation (allow_discard_unhandled: true).`
        );
      }
    } else if (currentDerivedState === 'UNKNOWN') {
      const confirmed = allow_discard_unhandled || confirm_replace_unknown || confirm_replace;
      if (!confirmed) {
        throw new Error(
          `Cannot replace ${resolved.id} endpoint in UNKNOWN state without explicit confirmation (allow_discard_unhandled: true or confirm_replace_unknown: true).`
        );
      }
    }

    const now = new Date().toISOString();
    const nextBinding = bumpRevision(this._binding);

    if (resolved.role === 'browser') {
      if (!identity.conversation_id || typeof identity.conversation_id !== 'string') {
        throw new Error('New browser identity requires valid conversation_id');
      }
      nextBinding.browser = {
        provider: identity.provider || this._binding.browser?.provider || 'chatgpt',
        conversation_id: identity.conversation_id
      };
      this._binding = nextBinding;
      this._browserEndpoint = {
        endpoint: 'browser',
        role: 'browser',
        endpoint_revision: 1,
        latest_completed_cursor: null,
        last_handled_cursor: null,
        completed_at: null,
        continuity: {
          trusted: false,
          unknown_reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
        },
        updated_at: now
      };
    } else {
      if (!identity.conversation_id || !identity.workspace_identity || !identity.repository_identity) {
        throw new Error('New ide identity requires conversation_id, workspace_identity, and repository_identity');
      }
      const targetEpIndex = nextBinding.ide_endpoints.findIndex(e => e.endpoint_id === resolved.id);
      if (targetEpIndex === -1) {
        throw new Error(`Target IDE endpoint "${resolved.id}" not found in binding`);
      }
      const oldEp = nextBinding.ide_endpoints[targetEpIndex];
      const nextEpRev = (oldEp.endpoint_revision || 1) + 1;

      nextBinding.ide_endpoints[targetEpIndex] = {
        endpoint_id: resolved.id,
        endpoint_revision: nextEpRev,
        conversation_id: identity.conversation_id,
        workspace_identity: identity.workspace_identity,
        repository_identity: identity.repository_identity
      };

      const validation = validateBinding(nextBinding);
      if (!validation.valid) {
        throw new Error(`Invalid Rebind configuration: ${validation.errors.join('; ')}`);
      }

      this._binding = nextBinding;
      this._ideEndpoints.set(resolved.id, {
        endpoint: resolved.id,
        role: 'ide',
        endpoint_revision: nextEpRev,
        latest_completed_cursor: null,
        last_handled_cursor: null,
        completed_at: null,
        continuity: {
          trusted: false,
          unknown_reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
        },
        updated_at: now
      });
    }

    this._updatedAt = now;
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
    const expectedConvId = resolved.config?.conversation_id;
    const targetEpRev = resolved.config?.endpoint_revision || current.endpoint_revision || 1;

    const { trusted, unknownReason } = verifyObservationContinuity({
      observation,
      expectedConvId,
      targetEpRev,
      isBrowser: resolved.role === 'browser',
      bindingRevision: this._binding.binding_revision,
      ideCount: this._ideEndpoints.size
    });

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

    const updatedFact = {
      ...current,
      latest_completed_cursor: latestCursor,
      last_handled_cursor: current.last_handled_cursor,
      completed_at: completedAt,
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

    this._updatedAt = now;
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

    return { success: true, handled_cursor: current.last_handled_cursor };
  }

  setHumanIntervention({ active = true, reason = null } = {}) {
    this._humanIntervention = {
      active: Boolean(active),
      reason: reason || null,
      updated_at: new Date().toISOString()
    };
    this._updatedAt = this._humanIntervention.updated_at;
  }

  clearHumanIntervention() {
    this.setHumanIntervention({ active: false, reason: null });
  }

  recordActionFact({
    action_id,
    action_type = 'action',
    target_endpoint,
    stage = 'REQUESTED',
    binding_revision,
    evidence = null
  }) {
    const fact = createActionFact({
      action_id,
      action_type,
      target_endpoint,
      stage,
      binding_revision: binding_revision ?? this._binding.binding_revision,
      evidence
    });

    this._actions.push(fact);
    this._updatedAt = fact.updated_at;
    return fact;
  }

  advanceActionStage(actionId, { next_stage, evidence }) {
    const action = this._actions.find(a => a.action_id === actionId);
    if (!action) {
      throw new Error(`Action "${actionId}" not found`);
    }
    const updated = transitionActionStage(action, { next_stage, evidence });
    this._updatedAt = updated.updated_at;
    return updated;
  }

  updateBinding(nextBinding) {
    const validation = validateBinding(nextBinding);
    if (!validation.valid) {
      throw new Error(`Invalid Binding update: ${validation.errors.join('; ')}`);
    }

    if (nextBinding.binding_id !== this._binding.binding_id) {
      throw new Error(`Cannot change binding_id from "${this._binding.binding_id}" to "${nextBinding.binding_id}".`);
    }

    const browserChanged =
      nextBinding.browser?.provider !== this._binding.browser?.provider ||
      nextBinding.browser?.conversation_id !== this._binding.browser?.conversation_id;

    if (browserChanged) {
      throw new Error('Identity-changing rebind is prohibited in Status Core; use rebindEndpoint() for safe rebind (#14).');
    }

    this._binding = { ...nextBinding };
    this._updatedAt = new Date().toISOString();
  }

  getSnapshot() {
    return formatStatusSnapshot({
      binding: this._binding,
      endpoints: {
        browser: this._browserEndpoint,
        ide_endpoints: this._ideEndpoints
      },
      humanIntervention: this._humanIntervention,
      actions: this._actions,
      updatedAt: this._updatedAt
    });
  }

  toCompactView() {
    return formatCompactStatus(this.getSnapshot());
  }
}
