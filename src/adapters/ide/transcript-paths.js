/**
 * Antigravity IDE Transcript 路径推导工具模块
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * 推导指定 Antigravity 会话的默认规范 Transcript 路径
 * 优先返回已存在的 transcript.jsonl 或 transcript_full.jsonl；若均不存在则返回默认 transcript.jsonl
 * @param {string} conversationId
 * @param {string} [baseDir]
 * @returns {string}
 */
export function resolveDefaultAntigravityTranscriptPath(conversationId, baseDir = null) {
  if (!conversationId || typeof conversationId !== 'string') return '';
  const trimmed = conversationId.trim();
  const dir = baseDir
    ? path.join(baseDir, trimmed, '.system_generated', 'logs')
    : path.join(os.homedir(), '.gemini', 'antigravity', 'brain', trimmed, '.system_generated', 'logs');

  const compactPath = path.join(dir, 'transcript.jsonl');
  const fullPath = path.join(dir, 'transcript_full.jsonl');

  if (fs.existsSync(compactPath)) {
    return compactPath;
  }
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }
  return compactPath;
}
