/**
 * Antigravity IDE Transcript 路径推导工具模块
 */

import path from 'node:path';
import os from 'node:os';

/**
 * 推导指定 Antigravity 会话的默认规范 Transcript 路径
 * @param {string} conversationId
 * @param {string} [baseDir]
 * @returns {string}
 */
export function resolveDefaultAntigravityTranscriptPath(conversationId, baseDir = null) {
  if (!conversationId || typeof conversationId !== 'string') return '';
  const trimmed = conversationId.trim();
  return baseDir
    ? path.join(baseDir, trimmed, '.system_generated', 'logs', 'transcript.jsonl')
    : path.join(os.homedir(), '.gemini', 'antigravity', 'brain', trimmed, '.system_generated', 'logs', 'transcript.jsonl');
}
