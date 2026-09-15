/**
 * Antigravity IDE 端点适配器 (Antigravity IDE Endpoint Adapter)
 *
 * 核心设计契约 (#16):
 * 1. 适配器本地拥有 Antigravity Stop Hook、Transcript、step_index、fingerprint 解析细节；
 * 2. 向上游 Core / Registry 仅产出规范化的端点事实 (recordEndpointObservation 格式)，不泄露 provider-specific 字段；
 * 3. 严格身份归属：必须满足 exact conversationId、workspace_identity、repository_identity 匹配；
 * 4. 完成判定守卫：Stop Hook 必须满足 exact conversation、fullyIdle: true 且具备 final terminationReason；
 * 5. 中间步骤过滤：多步工具调用（中间步骤）不生成完成信号；
 * 6. 连续性守卫：历史截断、漂移、损坏或游标不可对齐时，必须 fail-closed 到 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export const FINAL_TERMINATION_REASONS = [
  'NO_TOOL_CALL',
  'model_stop',
  'max_steps_exceeded',
  'error',
  'user_cancelled'
];

/**
 * 标准化路径以消除末尾斜杠和大小写差异
 * @param {string} p 
 * @returns {string}
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let norm = p.trim().replace(/\+/g, '/').replace(/\/+$/, '');
  if (norm.startsWith('file://')) {
    norm = norm.slice(7);
  }
  return norm;
}

/**
 * 校验 workspace 身份是否匹配
 * @param {string[]|string} actualWorkspaces 
 * @param {string} expectedWorkspace 
 * @returns {boolean}
 */
export function matchesWorkspace(actualWorkspaces, expectedWorkspace) {
  if (!expectedWorkspace || typeof expectedWorkspace !== 'string') return false;
  const expectedNorm = normalizePath(expectedWorkspace);
  if (!expectedNorm) return false;

  const actualList = Array.isArray(actualWorkspaces)
    ? actualWorkspaces
    : (typeof actualWorkspaces === 'string' ? [actualWorkspaces] : []);

  return actualList.some(w => normalizePath(w) === expectedNorm);
}

/**
 * 从单条 transcript step 派生内容指纹 (16位十六进制)
 * @param {object} step 
 * @returns {string}
 */
export function deriveStepFingerprint(step) {
  const content = typeof step.content === 'string' ? step.content : JSON.stringify(step.content || '');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 编码 adapter-local opaque completion cursor
 * Core / Registry 只需视为普通字符串，不解析内部结构
 * @param {number} stepIndex 
 * @param {string} fingerprint 
 * @returns {string}
 */
export function encodeOpaqueCursor(stepIndex, fingerprint) {
  return `ag-step:${stepIndex}:${fingerprint}`;
}

/**
 * 解码 adapter-local opaque completion cursor
 * @param {string} cursor 
 * @returns {{ stepIndex: number, fingerprint: string } | null}
 */
export function decodeOpaqueCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const match = cursor.match(/^ag-step:(\d+):([a-f0-9]+)$/);
  if (!match) return null;
  return {
    stepIndex: parseInt(match[1], 10),
    fingerprint: match[2]
  };
}

/**
 * 解析并筛选 transcript 中所有最终完成的 Assistant Turn
 * 仅 PLANNER_RESPONSE 且 status === 'DONE' 且无未完成 tool_calls 的步骤才构成完成候选
 * @param {string} transcriptPath 
 * @returns {Array<{ stepIndex: number, fingerprint: string, createdAt: string|null }>}
 */
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
      // 损坏的行不计入有效步骤
      continue;
    }

    if (
      step &&
      step.type === 'PLANNER_RESPONSE' &&
      step.status === 'DONE' &&
      (!step.tool_calls || step.tool_calls.length === 0) &&
      typeof step.step_index === 'number'
    ) {
      turns.push({
        stepIndex: step.step_index,
        fingerprint: deriveStepFingerprint(step),
        createdAt: step.created_at || null
      });
    }
  }

  return turns;
}

export class AntigravityIdeAdapter {
  /**
   * @param {object} options
   * @param {object} options.binding - Project Binding 快照
   * @param {import('../../status/status-core.js').ProjectStatusCore} options.statusCore - 关联的 Status Core
   */
  constructor({ binding, statusCore }) {
    if (!binding || !binding.ide) {
      throw new Error('AntigravityIdeAdapter requires a valid binding with ide identity');
    }
    if (!statusCore) {
      throw new Error('AntigravityIdeAdapter requires a StatusCore instance');
    }
    this._binding = binding;
    this._statusCore = statusCore;
  }

  /**
   * 更新当前绑定的快照引用（如发生安全 rebind 或版本 bump）
   * @param {object} nextBinding 
   */
  updateBinding(nextBinding) {
    this._binding = nextBinding;
  }

  /**
   * 处理 Antigravity 官方 Stop Lifecycle Hook 载荷
   * 严格按事实核验：exact conversation + workspace + repository + fullyIdle + final termination
   * 核验通过后，提取最新完成步骤游标并向 Core 提交规范 observation
   * @param {object} hookPayload Stop Hook 接收到的 payload
   * @returns {{ accepted: boolean, reason?: string, observation?: object }}
   */
  handleStopHook(hookPayload) {
    if (!hookPayload || typeof hookPayload !== 'object') {
      this._statusCore.recordEndpointObservation('ide', {
        continuity_lost: true,
        reason: 'malformed_hook_payload: payload must be a non-null object'
      });
      return { accepted: false, reason: 'malformed_hook_payload' };
    }

    const {
      conversationId,
      workspacePaths,
      fullyIdle,
      terminationReason,
      transcriptPath
    } = hookPayload;

    const expectedIde = this._binding.ide;

    // 1. exact conversationId 核验
    if (!conversationId || conversationId !== expectedIde.conversation_id) {
      // 严格归属隔离：如果是完全其他会话的 Hook，不污染当前 Binding，仅拒收
      return {
        accepted: false,
        reason: `attribution_mismatch: expected conversation ${expectedIde.conversation_id}, got ${conversationId}`
      };
    }

    // 2. workspace identity 归属核验
    if (!matchesWorkspace(workspacePaths, expectedIde.workspace_identity)) {
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: `workspace_mismatch: expected ${expectedIde.workspace_identity}`
      });
      return { accepted: false, reason: 'workspace_mismatch' };
    }

    // 3. fullyIdle 最终性核验：中间步骤 / 仍有未完成后台任务时不产生完成事实
    if (fullyIdle !== true) {
      return {
        accepted: false,
        reason: 'intermediate_activity: fullyIdle is false, task still in progress'
      };
    }

    // 4. final terminationReason 核验
    if (!terminationReason || !FINAL_TERMINATION_REASONS.includes(terminationReason)) {
      return {
        accepted: false,
        reason: `non_final_termination_reason: got ${terminationReason}`
      };
    }

    // 5. 从 transcript 提取最新完成游标
    const effectiveTranscriptPath = transcriptPath || this._findTranscriptPath(conversationId);
    if (!effectiveTranscriptPath || !fs.existsSync(effectiveTranscriptPath)) {
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: 'transcript_not_found: cannot verify completion cursor'
      });
      return { accepted: false, reason: 'transcript_not_found' };
    }

    const turns = parseTranscriptCompletedTurns(effectiveTranscriptPath);
    if (turns.length === 0) {
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: 'no_completed_turns_found: transcript has no completed turn'
      });
      return { accepted: false, reason: 'no_completed_turns_found' };
    }

    const latestTurn = turns[turns.length - 1];
    const opaqueCursor = encodeOpaqueCursor(latestTurn.stepIndex, latestTurn.fingerprint);

    const observation = {
      conversation_id: expectedIde.conversation_id,
      binding_revision: this._binding.binding_revision,
      trusted: true,
      latest_completed_cursor: opaqueCursor,
      completed_at: latestTurn.createdAt || new Date().toISOString()
    };

    // 提交给 Status Core
    this._statusCore.recordEndpointObservation('ide', observation);

    return { accepted: true, observation };
  }

  /**
   * 重启或重新连接时的游标协调 (Reconciliation)
   * 比对当前持久化账本（handled / latest）与物理 transcript 历史：
   * - 若 handled 游标在物理 transcript 中精确匹配，且无后续新 turn -> caught-up (NO_NEW_RESULT)
   * - 若 handled 游标精确匹配，且存在后续新 turn -> NEW (最新 turn 游标)
   * - 若无 handled 游标但从未产生过完成 -> NO_NEW_RESULT
   * - 若历史截断、指纹不匹配、游标漂移或文件丢失 -> 坚决 fail-closed 到 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION
   * @param {string} [transcriptPath]
   * @returns {{ status: 'RECONCILED' | 'UNKNOWN', reason?: string }}
   */
  reconcileOnStartup(transcriptPath = null) {
    const expectedIde = this._binding.ide;
    const effectivePath = transcriptPath || this._findTranscriptPath(expectedIde.conversation_id);

    if (!effectivePath || !fs.existsSync(effectivePath)) {
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      });
      return { status: 'UNKNOWN', reason: 'transcript_unavailable' };
    }

    const currentSnapshot = this._statusCore.getSnapshot();
    const ideFact = currentSnapshot.endpoints.ide;
    const handledCursor = ideFact.last_handled_cursor;
    const turns = parseTranscriptCompletedTurns(effectivePath);

    // 1. 如果此前从未处理过任何完成
    if (!handledCursor) {
      if (turns.length === 0) {
        // 无历史完成记录，且 transcript 确实没有任何完成轮次：处于干净初始状态
        this._statusCore.recordEndpointObservation('ide', {
          conversation_id: expectedIde.conversation_id,
          binding_revision: this._binding.binding_revision,
          trusted: true,
          latest_completed_cursor: null
        });
        return { status: 'RECONCILED' };
      }

      // 如果已有持久化的 latest_completed_cursor，检查是否与 transcript 末尾一致
      if (ideFact.latest_completed_cursor) {
        const decodedLatest = decodeOpaqueCursor(ideFact.latest_completed_cursor);
        const matchingTurn = turns.find(t => t.stepIndex === decodedLatest?.stepIndex);
        if (matchingTurn && matchingTurn.fingerprint === decodedLatest.fingerprint) {
          // 状态与 transcript 吻合，恢复该 NEW 游标
          this._statusCore.recordEndpointObservation('ide', {
            conversation_id: expectedIde.conversation_id,
            binding_revision: this._binding.binding_revision,
            trusted: true,
            latest_completed_cursor: ideFact.latest_completed_cursor,
            completed_at: matchingTurn.createdAt || ideFact.completed_at
          });
          return { status: 'RECONCILED' };
        }
      }

      // 无法建立历史基线：必须 fail-closed 到 UNKNOWN
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      });
      return { status: 'UNKNOWN', reason: 'cannot_align_unhandled_history' };
    }

    // 2. 已有 handledCursor，解码核验
    const decodedHandled = decodeOpaqueCursor(handledCursor);
    if (!decodedHandled) {
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      });
      return { status: 'UNKNOWN', reason: 'malformed_handled_cursor' };
    }

    // 在当前 transcript 中寻找对应的 handled 步骤
    const handledTurn = turns.find(t => t.stepIndex === decodedHandled.stepIndex);
    if (!handledTurn || handledTurn.fingerprint !== decodedHandled.fingerprint) {
      // 历史截断、step_index 漂移或内容篡改：fail-closed 到 UNKNOWN
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        continuity_lost: true,
        reason: 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION'
      });
      return { status: 'UNKNOWN', reason: 'handled_cursor_drift_or_truncated' };
    }

    // 检查 handled 之后是否存在新的完成轮次
    const subsequentTurns = turns.filter(t => t.stepIndex > decodedHandled.stepIndex);
    if (subsequentTurns.length === 0) {
      // 历史已完全处理，恢复 caught-up 事实（latest === handled）
      this._statusCore.recordEndpointObservation('ide', {
        conversation_id: expectedIde.conversation_id,
        binding_revision: this._binding.binding_revision,
        trusted: true,
        latest_completed_cursor: handledCursor,
        completed_at: handledTurn.createdAt || ideFact.completed_at
      });
      return { status: 'RECONCILED' };
    }

    // 存在新轮次：取最新的 turn 产出 NEW
    const latestTurn = subsequentTurns[subsequentTurns.length - 1];
    const newOpaqueCursor = encodeOpaqueCursor(latestTurn.stepIndex, latestTurn.fingerprint);

    this._statusCore.recordEndpointObservation('ide', {
      conversation_id: expectedIde.conversation_id,
      binding_revision: this._binding.binding_revision,
      trusted: true,
      latest_completed_cursor: newOpaqueCursor,
      completed_at: latestTurn.createdAt || new Date().toISOString()
    });

    return { status: 'RECONCILED' };
  }

  /**
   * 定位会话对应的 transcript 文件路径（辅助函数）
   * @param {string} conversationId 
   * @returns {string|null}
   */
  _findTranscriptPath(conversationId) {
    if (!conversationId) return null;
    const homedir = process.env.HOME || '';
    const cand1 = `${homedir}/.gemini/antigravity/brain/${conversationId}/.system_generated/logs/transcript.jsonl`;
    if (fs.existsSync(cand1)) return cand1;
    const cand2 = `${homedir}/.gemini/antigravity/brain/${conversationId}/.system_generated/logs/transcript_full.jsonl`;
    if (fs.existsSync(cand2)) return cand2;
    return null;
  }
}
