/**
 * Antigravity IDE 端点适配器 (Antigravity IDE Endpoint Adapter)
 *
 * 核心设计契约 (#16, #21):
 * 1. 适配器本地拥有 Antigravity Stop Hook、Transcript、step_index、fingerprint 解析细节；
 * 2. 向上游 Core / Registry 仅产出规范化的端点事实 (recordEndpointObservation 格式)，不泄露 provider-specific 字段；
 * 3. 严格身份归属：必须满足 exact conversationId、workspace_identity、repository_identity 匹配；
 * 4. 支持多 IDE 寻址：绑定特定的 endpointId 与 endpoint_revision；
 * 5. 连续性守卫：历史截断、漂移、损坏或游标不可对齐时，必须 fail-closed 到 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const FINAL_TERMINATION_REASONS = [
  'NO_TOOL_CALL'
];

export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let norm = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm.startsWith('file://')) {
    norm = norm.slice(7);
  }
  return norm;
}

export function matchesWorkspace(actualWorkspaces, expectedWorkspace) {
  if (!expectedWorkspace || typeof expectedWorkspace !== 'string') return false;
  const expectedNorm = normalizePath(expectedWorkspace);
  if (!expectedNorm) return false;

  const actualList = Array.isArray(actualWorkspaces)
    ? actualWorkspaces
    : (typeof actualWorkspaces === 'string' ? [actualWorkspaces] : []);

  return actualList.some(w => normalizePath(w) === expectedNorm);
}

export function parseCanonicalRepositoryIdentity(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  const cleaned = rawUrl.trim();

  const match = cleaned.match(/^(?:(?:https?|git|ssh):\/\/(?:[^@\/]+@)?[^\/]+\/|(?:[^@\/]+@)?[^:]+:)([^\/\s]+)\/([^\/\s#?]+?)(?:\.git)?$/i);
  if (!match) return null;

  const owner = match[1].trim();
  const repo = match[2].trim();
  if (!owner || !repo) return null;
  return `${owner}/${repo}`.toLowerCase();
}

export function matchesRepository(workspacePath, expectedRepository) {
  if (!expectedRepository || typeof expectedRepository !== 'string') return false;
  const expCanonical = expectedRepository.trim().toLowerCase();
  if (!expCanonical.includes('/') || expCanonical.split('/').length !== 2) {
    return false;
  }

  const normWs = normalizePath(workspacePath);
  if (!normWs || !fs.existsSync(normWs)) {
    return false;
  }

  const gitDir = path.join(normWs, '.git');
  if (!fs.existsSync(gitDir)) {
    return false;
  }

  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: normWs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    const actualCanonical = parseCanonicalRepositoryIdentity(remoteUrl);
    if (!actualCanonical) {
      return false;
    }

    return actualCanonical === expCanonical;
  } catch {
    return false;
  }
}

export function isProvenAntigravityTranscript(transcriptPath, conversationId) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return false;
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) return false;

  const normPath = normalizePath(transcriptPath);
  if (!normPath || !fs.existsSync(normPath)) {
    return false;
  }

  try {
    const stat = fs.statSync(normPath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const parts = normPath.split('/');
  const len = parts.length;
  if (len < 4) return false;

  const fileName = parts[len - 1];
  const logsDir = parts[len - 2];
  const sysDir = parts[len - 3];
  const convDir = parts[len - 4];

  if (
    fileName !== 'transcript.jsonl' ||
    logsDir !== 'logs' ||
    sysDir !== '.system_generated' ||
    convDir !== conversationId.trim()
  ) {
    return false;
  }

  return true;
}

export function deriveStepFingerprint(step) {
  const content = typeof step.content === 'string' ? step.content : JSON.stringify(step.content || '');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function encodeOpaqueCursor(stepIndex, fingerprint) {
  return `ag-step:${stepIndex}:${fingerprint}`;
}

export function decodeOpaqueCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const match = cursor.match(/^ag-step:(\d+):([a-f0-9]+)$/);
  if (!match) return null;
  return {
    stepIndex: parseInt(match[1], 10),
    fingerprint: match[2]
  };
}

export function parseTranscriptCompletedTurns(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
    return [];
  }

  const turns = [];
  const rawContent = fs.readFileSync(transcriptPath, 'utf8');
  const lines = rawContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (
      step &&
      step.type === 'PLANNER_RESPONSE' &&
      step.status === 'DONE' &&
      (!step.tool_calls || step.tool_calls.length === 0) &&
      typeof step.step_index === 'number'
    ) {
      let turnText = null;
      if (typeof step.content === 'string') {
        turnText = step.content;
      } else if (step.content && typeof step.content.text === 'string') {
        turnText = step.content.text;
      }
      turns.push({
        stepIndex: step.step_index,
        fingerprint: deriveStepFingerprint(step),
        text: turnText,
        createdAt: step.created_at || null
      });
    }
  }

  return turns.sort((a, b) => a.stepIndex - b.stepIndex);
}

/**
 * 派生对用户/产品安全的确定性不透明结果引用 (Product-safe Result Ref)
 * 格式固定为 res_<16 hex>，严格不泄露内部 step_index, fingerprint 或 provider message ID
 */
export function deriveProductSafeResultRef(endpointId, cursor) {
  const hash = crypto.createHash('sha256')
    .update(`ide:${endpointId}:${cursor}`)
    .digest('hex')
    .slice(0, 16);
  return `res_${hash}`;
}

export class AntigravityIdeAdapter {
  constructor({ binding, statusCore, endpointId = null }) {
    if (!binding) {
      throw new Error('AntigravityIdeAdapter requires a valid binding');
    }
    if (!statusCore) {
      throw new Error('AntigravityIdeAdapter requires a StatusCore instance');
    }

    this._statusCore = statusCore;
    this._binding = binding;
    this._endpointId = endpointId;

    this._resolveIdeIdentity();
  }

  _resolveIdeIdentity() {
    let ideEp = null;
    const ideEndpoints = this._binding.ide_endpoints;
    const ideCount = Array.isArray(ideEndpoints) ? ideEndpoints.length : 0;

    if (this._endpointId) {
      ideEp = (ideEndpoints || []).find(e => e.endpoint_id === this._endpointId);
      if (!ideEp && this._binding.ide?.endpoint_id === this._endpointId) {
        ideEp = this._binding.ide;
      }
    } else {
      if (ideCount > 1) {
        throw new Error('AntigravityIdeAdapter requires explicit endpointId when project has multiple IDE endpoints');
      } else if (ideCount === 1) {
        ideEp = ideEndpoints[0];
      } else if (this._binding.ide) {
        ideEp = this._binding.ide;
      }
    }

    if (!ideEp) {
      throw new Error('AntigravityIdeAdapter requires a valid binding with ide identity');
    }

    this._endpointId = ideEp.endpoint_id || 'ide';
    this._ideIdentity = ideEp;
  }

  _buildObservation(payload) {
    const obs = {
      conversation_id: this._ideIdentity.conversation_id,
      binding_revision: this._binding.binding_revision,
      ...payload
    };
    if (this._ideIdentity.endpoint_revision !== undefined) {
      obs.endpoint_revision = this._ideIdentity.endpoint_revision;
    }
    return obs;
  }

  _buildCompletedResult(cursor, text, timestamp) {
    if (!cursor || typeof text !== 'string') return null;
    return {
      cursor,
      result_ref: deriveProductSafeResultRef(this._endpointId, cursor),
      text,
      captured_at: timestamp || new Date().toISOString()
    };
  }

  _failClosedToUnknown(reason = 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION') {
    this._statusCore.recordEndpointObservation(
      this._endpointId,
      this._buildObservation({ continuity_lost: true, reason })
    );
  }

  updateBinding(nextBinding) {
    this._binding = nextBinding;
    this._resolveIdeIdentity();
  }

  handleStopHook(hookPayload) {
    if (!hookPayload || typeof hookPayload !== 'object') {
      this._failClosedToUnknown('malformed_hook_payload: payload must be a non-null object');
      return { accepted: false, reason: 'malformed_hook_payload' };
    }

    const {
      conversationId,
      workspacePaths,
      fullyIdle,
      terminationReason,
      transcriptPath
    } = hookPayload;

    const expectedIde = this._ideIdentity;

    if (!conversationId || conversationId !== expectedIde.conversation_id) {
      return {
        accepted: false,
        reason: `attribution_mismatch: expected conversation ${expectedIde.conversation_id}, got ${conversationId}`
      };
    }

    if (!matchesWorkspace(workspacePaths, expectedIde.workspace_identity)) {
      this._failClosedToUnknown(`workspace_mismatch: expected ${expectedIde.workspace_identity}`);
      return {
        accepted: false,
        reason: `workspace_mismatch: expected ${expectedIde.workspace_identity}`
      };
    }

    const matchedWorkspace = (Array.isArray(workspacePaths) ? workspacePaths : [workspacePaths])
      .find(w => normalizePath(w) === normalizePath(expectedIde.workspace_identity));
    if (!matchesRepository(matchedWorkspace, expectedIde.repository_identity)) {
      this._failClosedToUnknown(`repository_mismatch: expected ${expectedIde.repository_identity}`);
      return {
        accepted: false,
        reason: `repository_mismatch: expected ${expectedIde.repository_identity}`
      };
    }

    if (fullyIdle !== true) {
      return {
        accepted: false,
        reason: 'intermediate_activity: fullyIdle is false, task still in progress'
      };
    }

    if (!terminationReason || !FINAL_TERMINATION_REASONS.includes(terminationReason)) {
      this._failClosedToUnknown(`non_final_termination_reason: got ${terminationReason}`);
      return {
        accepted: false,
        reason: `non_final_termination_reason: got ${terminationReason}`
      };
    }

    if (!isProvenAntigravityTranscript(transcriptPath, expectedIde.conversation_id)) {
      this._failClosedToUnknown('transcript_provenance_unverified: official transcriptPath missing or does not prove ownership of bound conversation');
      return { accepted: false, reason: 'transcript_provenance_unverified' };
    }

    const turns = parseTranscriptCompletedTurns(transcriptPath);
    if (turns.length === 0) {
      this._failClosedToUnknown('no_completed_turns_found: transcript has no completed turn');
      return { accepted: false, reason: 'no_completed_turns_found' };
    }

    const latestTurn = turns[turns.length - 1];
    const opaqueCursor = encodeOpaqueCursor(latestTurn.stepIndex, latestTurn.fingerprint);
    const completedAt = latestTurn.createdAt || new Date().toISOString();

    const observation = this._buildObservation({
      trusted: true,
      latest_completed_cursor: opaqueCursor,
      completed_at: completedAt,
      latest_completed_result: this._buildCompletedResult(opaqueCursor, latestTurn.text || '', completedAt)
    });

    this._statusCore.recordEndpointObservation(this._endpointId, observation);

    return { accepted: true, observation };
  }

  reconcileOnStartup(transcriptPathOrOptions, identityProof = {}) {
    let transcriptPath;
    let identity;
    if (typeof transcriptPathOrOptions === 'object' && transcriptPathOrOptions !== null) {
      transcriptPath = transcriptPathOrOptions.transcriptPath;
      identity = transcriptPathOrOptions;
    } else {
      transcriptPath = transcriptPathOrOptions;
      identity = identityProof;
    }

    const expectedIde = this._ideIdentity;

    if (!identity?.conversationId || identity.conversationId !== expectedIde.conversation_id) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return {
        status: 'UNKNOWN',
        reason: `attribution_mismatch: conversation_id mismatch or unproved`
      };
    }

    const actualWorkspaces = identity.workspacePaths || identity.workspacePath;
    if (!matchesWorkspace(actualWorkspaces, expectedIde.workspace_identity)) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return {
        status: 'UNKNOWN',
        reason: `workspace_mismatch: expected ${expectedIde.workspace_identity}`
      };
    }

    const matchedWs = (Array.isArray(actualWorkspaces) ? actualWorkspaces : [actualWorkspaces])
      .find(w => normalizePath(w) === normalizePath(expectedIde.workspace_identity));
    if (!matchesRepository(matchedWs, expectedIde.repository_identity)) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return {
        status: 'UNKNOWN',
        reason: `repository_mismatch: expected ${expectedIde.repository_identity}`
      };
    }

    if (!isProvenAntigravityTranscript(transcriptPath, expectedIde.conversation_id)) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return {
        status: 'UNKNOWN',
        reason: 'transcript_provenance_unverified: transcript path does not prove ownership of bound conversation'
      };
    }

    const currentSnapshot = this._statusCore.getSnapshot();
    const ideFact = (currentSnapshot.endpoints?.ide_endpoints && currentSnapshot.endpoints.ide_endpoints[this._endpointId])
      || currentSnapshot.endpoints?.ide
      || {};
    const handledCursor = ideFact.last_handled_cursor;
    const turns = parseTranscriptCompletedTurns(transcriptPath);

    if (!handledCursor) {
      if (turns.length === 0) {
        this._statusCore.recordEndpointObservation(
          this._endpointId,
          this._buildObservation({ trusted: true, latest_completed_cursor: null })
        );
        return { status: 'RECONCILED' };
      }

      if (ideFact.latest_completed_cursor) {
        const decodedLatest = decodeOpaqueCursor(ideFact.latest_completed_cursor);
        const matchingTurn = turns.find(t => t.stepIndex === decodedLatest?.stepIndex);
        if (matchingTurn && matchingTurn.fingerprint === decodedLatest.fingerprint) {
          const subsequentTurns = turns.filter(t => t.stepIndex > decodedLatest.stepIndex);
          const effectiveTurn = subsequentTurns.length > 0 ? subsequentTurns[subsequentTurns.length - 1] : matchingTurn;
          const effectiveCursor = encodeOpaqueCursor(effectiveTurn.stepIndex, effectiveTurn.fingerprint);
          const completedAt = effectiveTurn.createdAt || ideFact.completed_at || new Date().toISOString();

          this._statusCore.recordEndpointObservation(
            this._endpointId,
            this._buildObservation({
              trusted: true,
              latest_completed_cursor: effectiveCursor,
              completed_at: completedAt,
              latest_completed_result: this._buildCompletedResult(effectiveCursor, effectiveTurn.text || '', completedAt)
            })
          );
          return { status: 'RECONCILED' };
        }
      }

      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return { status: 'UNKNOWN', reason: 'cannot_align_unhandled_history' };
    }

    const decodedHandled = decodeOpaqueCursor(handledCursor);
    if (!decodedHandled) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return { status: 'UNKNOWN', reason: 'malformed_handled_cursor' };
    }

    const handledTurn = turns.find(t => t.stepIndex === decodedHandled.stepIndex);
    if (!handledTurn || handledTurn.fingerprint !== decodedHandled.fingerprint) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return { status: 'UNKNOWN', reason: 'handled_cursor_drift_or_truncated' };
    }

    const subsequentTurns = turns.filter(t => t.stepIndex > decodedHandled.stepIndex);
    if (subsequentTurns.length === 0) {
      const completedAt = handledTurn.createdAt || ideFact.completed_at || new Date().toISOString();
      this._statusCore.recordEndpointObservation(
        this._endpointId,
        this._buildObservation({
          trusted: true,
          latest_completed_cursor: handledCursor,
          completed_at: completedAt,
          latest_completed_result: this._buildCompletedResult(handledCursor, handledTurn.text || '', completedAt)
        })
      );
      return { status: 'RECONCILED' };
    }

    const latestTurn = subsequentTurns[subsequentTurns.length - 1];
    const newOpaqueCursor = encodeOpaqueCursor(latestTurn.stepIndex, latestTurn.fingerprint);
    const completedAt = latestTurn.createdAt || new Date().toISOString();

    this._statusCore.recordEndpointObservation(
      this._endpointId,
      this._buildObservation({
        trusted: true,
        latest_completed_cursor: newOpaqueCursor,
        completed_at: completedAt,
        latest_completed_result: this._buildCompletedResult(newOpaqueCursor, latestTurn.text || '', completedAt)
      })
    );

    return { status: 'RECONCILED' };
  }
}
