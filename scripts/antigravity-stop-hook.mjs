#!/usr/bin/env node

/**
 * Antigravity Stop Hook -> Rally Bridge Script
 * 
 * 职责：
 * 1. 从 stdin 读取 Antigravity 官方 Stop Hook 载荷；
 * 2. 检查工作区本地会话白名单 (.agents/rally-conversations.json)；
 *    - 若会话未绑定（不在白名单内）：立即向 stdout 输出 "{}" 并以 0 退出（零 HTTP 开销，不打扰 Rally）；
 * 3. 若会话已明确绑定：忠实保留原始载荷并以 POST 转发至 Rally /api/hooks/antigravity；
 * 4. 安全失败原则：网络错误、超时或目标服务未启动时静默退出，绝不阻断 Antigravity；
 * 5. 向 stdout 输出 "{}" 并以状态码 0 退出，符合 Antigravity Hook 契约。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const outputSafeResult = () => {
    try {
      process.stdout.write('{}\n');
    } catch (_) {}
  };

  let rawStdin = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      rawStdin += chunk;
    }
  } catch (_) {
    outputSafeResult();
    process.exit(0);
  }

  if (!rawStdin.trim()) {
    outputSafeResult();
    process.exit(0);
  }

  let hookPayload;
  try {
    hookPayload = JSON.parse(rawStdin);
  } catch (_) {
    outputSafeResult();
    process.exit(0);
  }

  const conversationId = hookPayload?.conversationId ? String(hookPayload.conversationId).trim() : null;
  if (!conversationId) {
    outputSafeResult();
    process.exit(0);
  }

  // 收集候选工作区路径（优先载荷中的 workspacePath，次之当前工作目录）
  const candidateWorkspaces = [];
  if (hookPayload.workspacePath && typeof hookPayload.workspacePath === 'string') {
    candidateWorkspaces.push(hookPayload.workspacePath.trim());
  }
  if (Array.isArray(hookPayload.workspacePaths)) {
    for (const ws of hookPayload.workspacePaths) {
      if (ws && typeof ws === 'string' && !candidateWorkspaces.includes(ws.trim())) {
        candidateWorkspaces.push(ws.trim());
      }
    }
  }
  const cwd = process.cwd();
  if (!candidateWorkspaces.includes(cwd)) {
    candidateWorkspaces.push(cwd);
  }

  // 本地过滤：检查工作区白名单
  let isAllowed = false;
  let matchedWorkspace = null;

  for (const ws of candidateWorkspaces) {
    try {
      const allowlistPath = path.resolve(ws, '.agents', 'rally-conversations.json');
      if (fs.existsSync(allowlistPath)) {
        const raw = fs.readFileSync(allowlistPath, 'utf8');
        const data = JSON.parse(raw);
        const conversations = Array.isArray(data?.conversations) ? data.conversations : [];
        if (conversations.includes(conversationId)) {
          isAllowed = true;
          matchedWorkspace = ws;
          break;
        }
      }
    } catch (_) {}
  }

  // 未绑定会话：立即短路退出，不发起任何 HTTP 请求
  if (!isAllowed) {
    outputSafeResult();
    process.exit(0);
  }

  // 已绑定会话：准备转发至 Rally
  let targetUrlStr = process.env.RALLY_SURFACE_URL;
  if (!targetUrlStr && matchedWorkspace) {
    try {
      const overrideUrlPath = path.resolve(matchedWorkspace, '.agents', 'hook-url');
      if (fs.existsSync(overrideUrlPath)) {
        targetUrlStr = fs.readFileSync(overrideUrlPath, 'utf8').trim();
      }
    } catch (_) {}
  }
  if (!targetUrlStr) {
    targetUrlStr = 'http://127.0.0.1:3123/api/hooks/antigravity';
  }

  try {
    const targetUrl = new URL(targetUrlStr);
    const postData = Buffer.from(JSON.stringify(hookPayload), 'utf8');

    await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + (targetUrl.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': postData.length
          },
          timeout: 2000
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(true));
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(postData);
      req.end();
    });
  } catch (_) {
    // 静默安全失败
  }

  outputSafeResult();
  process.exit(0);
}

main();
