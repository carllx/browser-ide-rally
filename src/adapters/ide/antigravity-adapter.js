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
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
 * 从本地 git 仓库探测或从路径校验 repository_identity (例如 carllx/browser-ide-rally)
 * @param {string} workspacePath 
 * @param {string} expectedRepository 
 * @returns {boolean}
 */
export function matchesRepository(workspacePath, expectedRepository) {
  if (!expectedRepository || typeof expectedRepository !== 'string') return false;
  const exp = expectedRepository.trim().toLowerCase();
  const normWs = normalizePath(workspacePath);
  if (!normWs || !fs.existsSync(normWs)) {
    return false;
  }

  // 1. 若工作区目录内包含 .git，通过 git remote 探测权威远程仓库标识
  const gitDir = path.join(normWs, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: normWs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim().toLowerCase();

      if (remoteUrl.includes(exp)) {
        return true;
      }
    } catch {
      // 若没有 git origin remote，降级核验目录后缀
    }
  }

  // 2. 目录名或路径后缀核验
  const repoName = exp.split('/').pop();
  return normWs.toLowerCase().endsWith(exp) || normWs.toLowerCase().endsWith(repoName);
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
   * 统一向 Status Core 记录 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION 观察
   * @param {string} reason 
   */
  _failClosedToUnknown(reason = 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION') {
    this._statusCore.recordEndpointObservation('ide', {
      conversation_id: this._binding.ide?.conversation_id,
      continuity_lost: true,
      reason
    });
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
      this._failClosedToUnknown(`workspace_mismatch: expected ${expectedIde.workspace_identity}`);
      return { accepted: false, reason: 'workspace_mismatch' };
    }

    // 3. repository identity 归属核验
    const matchedWs = (Array.isArray(workspacePaths) ? workspacePaths : [workspacePaths])
      .find(w => normalizePath(w) === normalizePath(expectedIde.workspace_identity));
    if (!matchesRepository(matchedWs, expectedIde.repository_identity)) {
      this._failClosedToUnknown(`repository_mismatch: expected ${expectedIde.repository_identity}`);
      return { accepted: false, reason: 'repository_mismatch' };
    }

    // 4. fullyIdle 最终性核验：中间步骤 / 仍有未完成后台任务时不产生完成事实
    if (fullyIdle !== true) {
      return {
        accepted: false,
        reason: 'intermediate_activity: fullyIdle is false, task still in progress'
      };
    }

    // 5. final terminationReason 核验
    if (!terminationReason || !FINAL_TERMINATION_REASONS.includes(terminationReason)) {
      return {
        accepted: false,
        reason: `non_final_termination_reason: got ${terminationReason}`
      };
    }

    // 6. 从 transcript 提取最新完成游标（必须由 hookPayload 显式提供真实路径，绝不猜测）
    if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
      this._failClosedToUnknown('transcript_not_found: official transcriptPath missing or invalid');
      return { accepted: false, reason: 'transcript_not_found' };
    }

    const turns = parseTranscriptCompletedTurns(transcriptPath);
    if (turns.length === 0) {
      this._failClosedToUnknown('no_completed_turns_found: transcript has no completed turn');
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
   * - 若存在未 handled 的 latest 游标，且后续出现新轮次 -> 正确推进至最新轮次
   * - 若历史截断、指纹不匹配、游标漂移或文件丢失 -> 坚决 fail-closed 到 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION
   * @param {string} transcriptPath 官方 transcript 路径（必需参数）
   * @returns {{ status: 'RECONCILED' | 'UNKNOWN', reason?: string }}
   */
  reconcileOnStartup(transcriptPath) {
    const expectedIde = this._binding.ide;

    if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return { status: 'UNKNOWN', reason: 'transcript_unavailable' };
    }

    const currentSnapshot = this._statusCore.getSnapshot();
    const ideFact = currentSnapshot.endpoints?.ide || {};
    const handledCursor = ideFact.last_handled_cursor;
    const turns = parseTranscriptCompletedTurns(transcriptPath);

    // 1. 如果此前从未处理过任何完成 (handledCursor 为空)
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

      // 如果已有持久化的 latest_completed_cursor，检查在 transcript 中的位置与指纹
      if (ideFact.latest_completed_cursor) {
        const decodedLatest = decodeOpaqueCursor(ideFact.latest_completed_cursor);
        const matchingTurn = turns.find(t => t.stepIndex === decodedLatest?.stepIndex);
        if (matchingTurn && matchingTurn.fingerprint === decodedLatest.fingerprint) {
          // 检查 latest 之后是否又有新完成轮次产生
          const subsequentTurns = turns.filter(t => t.stepIndex > decodedLatest.stepIndex);
          const effectiveTurn = subsequentTurns.length > 0 ? subsequentTurns[subsequentTurns.length - 1] : matchingTurn;
          const effectiveCursor = encodeOpaqueCursor(effectiveTurn.stepIndex, effectiveTurn.fingerprint);

          this._statusCore.recordEndpointObservation('ide', {
            conversation_id: expectedIde.conversation_id,
            binding_revision: this._binding.binding_revision,
            trusted: true,
            latest_completed_cursor: effectiveCursor,
            completed_at: effectiveTurn.createdAt || ideFact.completed_at
          });
          return { status: 'RECONCILED' };
        }
      }

      // 无法建立历史基线：必须 fail-closed 到 UNKNOWN
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return { status: 'UNKNOWN', reason: 'cannot_align_unhandled_history' };
    }

    // 2. 已有 handledCursor，解码核验
    const decodedHandled = decodeOpaqueCursor(handledCursor);
    if (!decodedHandled) {
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
      return { status: 'UNKNOWN', reason: 'malformed_handled_cursor' };
    }

    // 在当前 transcript 中寻找对应的 handled 步骤
    const handledTurn = turns.find(t => t.stepIndex === decodedHandled.stepIndex);
    if (!handledTurn || handledTurn.fingerprint !== decodedHandled.fingerprint) {
      // 历史截断、step_index 漂移或内容篡改：fail-closed 到 UNKNOWN
      this._failClosedToUnknown('UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
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
}
