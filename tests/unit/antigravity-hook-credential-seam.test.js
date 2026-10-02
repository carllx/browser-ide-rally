/**
 * TDD Seam 3: Antigravity Hook ingress credential seam 测试
 * 验证 Issue #28 规范：
 * 1. a valid local Hook credential can ingest the intended Stop Hook;
 * 2. missing/invalid Hook credential fails closed with zero canonical mutation;
 * 3. Rally-down behavior remains inert/non-blocking for Antigravity;
 * 4. Browser/operator capability 与 Hook credential 严格分离。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_SCRIPT = path.resolve(__dirname, '../../scripts/antigravity-stop-hook.mjs');

describe('TDD Seam 3: Antigravity Hook ingress credential seam', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let hookSecret;
  let sessionToken;
  let coordinatorCalls;
  let mockCoordinator;

  before(async () => {
    registry = createProjectRegistry();
    coordinatorCalls = [];
    mockCoordinator = {
      handleAntigravityHook: (body) => {
        coordinatorCalls.push(body);
        return { accepted: true, binding_id: 'hook-test-proj' };
      }
    };

    serverHandle = await startStatusSurfaceServer({
      registry,
      observationCoordinator: mockCoordinator,
      port: 0
    });
    baseUrl = serverHandle.url;
    hookSecret = serverHandle.hookSecret;
    sessionToken = serverHandle.sessionToken;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('1. 缺少 Hook Credential 时 POST /api/hooks/antigravity 必须返回 401 且绝不调用协调器 (零突变)', async () => {
    coordinatorCalls = [];
    const res = await fetch(`${baseUrl}/api/hooks/antigravity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
        // 故意缺少 X-Rally-Hook-Secret
      },
      body: JSON.stringify({ conversationId: 'conv-test-hook-1' })
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.reason, /MISSING_OR_INVALID_HOOK_CREDENTIAL/i);

    // 验证协调器未被调用
    assert.equal(coordinatorCalls.length, 0);
  });

  it('2. 提供错误 Hook Credential 时返回 401 且绝不调用协调器 (零突变)', async () => {
    coordinatorCalls = [];
    const res = await fetch(`${baseUrl}/api/hooks/antigravity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rally-Hook-Secret': 'wrong-hook-secret-abcdef123456'
      },
      body: JSON.stringify({ conversationId: 'conv-test-hook-1' })
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.reason, /MISSING_OR_INVALID_HOOK_CREDENTIAL/i);

    assert.equal(coordinatorCalls.length, 0);
  });

  it('3. 使用 Browser Session Token 请求 Hook 端点必须被 401 拒绝 (凭据严格分离)', async () => {
    coordinatorCalls = [];
    const res = await fetch(`${baseUrl}/api/hooks/antigravity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rally-Hook-Secret': sessionToken // 传入 sessionToken 试图混用
      },
      body: JSON.stringify({ conversationId: 'conv-test-hook-1' })
    });

    assert.equal(res.status, 401);
    assert.equal(coordinatorCalls.length, 0);
  });

  it('4. 携带合法 Hook Credential 成功放行并完成摄取', async () => {
    coordinatorCalls = [];
    const res = await fetch(`${baseUrl}/api/hooks/antigravity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rally-Hook-Secret': hookSecret
      },
      body: JSON.stringify({ conversationId: 'conv-test-hook-1' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(coordinatorCalls.length, 1);
    assert.equal(coordinatorCalls[0].conversationId, 'conv-test-hook-1');
  });

  it('5. Bridge 脚本在 Rally 服务离线 (Rally-down) 时静默退出 0 且输出 "{}"，对 Antigravity 零阻断', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-bridge-down-'));
    try {
      const agentsDir = path.join(tempDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'rally-conversations.json'),
        JSON.stringify({ conversations: ['conv-down-test'] }),
        'utf8'
      );
      // 指向一个未监听的端口
      fs.writeFileSync(
        path.join(agentsDir, 'hook-url'),
        'http://127.0.0.1:49999/api/hooks/antigravity',
        'utf8'
      );

      const stdinPayload = JSON.stringify({
        conversationId: 'conv-down-test',
        workspacePath: tempDir
      });

      const proc = spawnSync('node', [BRIDGE_SCRIPT], {
        input: stdinPayload,
        encoding: 'utf8',
        cwd: tempDir,
        timeout: 3000
      });

      assert.equal(proc.status, 0);
      assert.equal(proc.stdout.trim(), '{}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('6. Bridge 脚本在遇到 401 凭据错误时静默退出 0 且输出 "{}"，对 Antigravity 零阻断', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-bridge-auth-'));
    try {
      const agentsDir = path.join(tempDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'rally-conversations.json'),
        JSON.stringify({ conversations: ['conv-auth-test'] }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(agentsDir, 'hook-url'),
        `${baseUrl}/api/hooks/antigravity`,
        'utf8'
      );
      // 故意提供错误的 token
      fs.writeFileSync(
        path.join(agentsDir, 'hook-secret'),
        'bad-secret-token',
        'utf8'
      );

      const stdinPayload = JSON.stringify({
        conversationId: 'conv-auth-test',
        workspacePath: tempDir
      });

      const proc = spawnSync('node', [BRIDGE_SCRIPT], {
        input: stdinPayload,
        encoding: 'utf8',
        cwd: tempDir,
        timeout: 3000
      });

      assert.equal(proc.status, 0);
      assert.equal(proc.stdout.trim(), '{}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
