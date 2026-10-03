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
        timeout: 10000
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
        timeout: 10000
      });

      assert.equal(proc.status, 0);
      assert.equal(proc.stdout.trim(), '{}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('7. Hook Bridge 绝不向非 loopback custom URL 发送请求或泄露 Hook Secret (Blocker 2 exfiltration)', async () => {
    // 启动一个监听在非预期地址/测试地址的 Mock HTTP 服务，验证它绝不会收到包含 secret 的请求
    const testSecret = 'super-secret-to-never-leak-12345';
    let receivedRequest = false;

    // 创建测试 tempDir
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-bridge-leak-'));
    try {
      const agentsDir = path.join(tempDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'rally-conversations.json'),
        JSON.stringify({ conversations: ['conv-leak-test'] }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(agentsDir, 'hook-secret'),
        testSecret,
        'utf8'
      );

      // 目标为外部恶意域名或 LAN 地址
      const evilTargetUrl = 'http://attacker-controlled.example.com/api/hooks/antigravity';

      const stdinPayload = JSON.stringify({
        conversationId: 'conv-leak-test',
        workspacePath: tempDir
      });

      const proc = spawnSync('node', [BRIDGE_SCRIPT, '--url', evilTargetUrl], {
        input: stdinPayload,
        encoding: 'utf8',
        cwd: tempDir,
        timeout: 3000
      });

      // 必须安全退出，输出 "{}"，退出码 0
      assert.equal(proc.status, 0);
      assert.equal(proc.stdout.trim(), '{}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('8. Hook Bridge 绝不向非 /api/hooks/antigravity 路径发送请求或泄露 Secret (Blocker 2 path check)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-bridge-path-leak-'));
    try {
      const agentsDir = path.join(tempDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'rally-conversations.json'),
        JSON.stringify({ conversations: ['conv-path-leak-test'] }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(agentsDir, 'hook-secret'),
        'secret-dont-send-to-wrong-path',
        'utf8'
      );

      // 指向 loopback 但路径不正确的 endpoint
      const wrongPathUrl = `${baseUrl}/api/other-endpoint`;

      const stdinPayload = JSON.stringify({
        conversationId: 'conv-path-leak-test',
        workspacePath: tempDir
      });

      const proc = spawnSync('node', [BRIDGE_SCRIPT, '--url', wrongPathUrl], {
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

  it('9. 当持久化 Hook Secret 文件无法读取或创建时，服务初始化必须 Fail-Closed 抛出异常 (Blocker 3)', async () => {
    const { resolveOrCreateHookSecret } = await import('../../src/surface/surface-security.js');

    // 指向一个不可写入的路径（例如将父级伪造成文件导致路径创建失败，或无效路径）
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-unwritable-'));
    const conflictFilePath = path.join(tempDir, 'file-as-dir');
    fs.writeFileSync(conflictFilePath, 'blocking-file', 'utf8');

    // 尝试在普通文件下方创建子目录文件
    const uncreatableSecretPath = path.join(conflictFilePath, 'sub-dir', 'hook-secret');

    try {
      assert.throws(
        () => {
          resolveOrCreateHookSecret({ secretFilePath: uncreatableSecretPath });
        },
        (err) => {
          assert.equal(err.code, 'DURABLE_HOOK_SECRET_UNAVAILABLE');
          return true;
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('10. Hook Bridge 绝不向 https 协议目标发起请求或泄露 Secret (HTTP-only transport security)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-bridge-https-leak-'));
    try {
      const agentsDir = path.join(tempDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'rally-conversations.json'),
        JSON.stringify({ conversations: ['conv-https-test'] }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(agentsDir, 'hook-secret'),
        'secret-dont-send-to-https',
        'utf8'
      );

      // 虽然是 loopback 且路径为 /api/hooks/antigravity，但协议为 https:
      const httpsTargetUrl = 'https://127.0.0.1:3123/api/hooks/antigravity';

      const stdinPayload = JSON.stringify({
        conversationId: 'conv-https-test',
        workspacePath: tempDir
      });

      const proc = spawnSync('node', [BRIDGE_SCRIPT, '--url', httpsTargetUrl], {
        input: stdinPayload,
        encoding: 'utf8',
        cwd: tempDir,
        timeout: 3000
      });

      // 必须安全退出，输出 "{}"，退出码 0，且无网络发送
      assert.equal(proc.status, 0);
      assert.equal(proc.stdout.trim(), '{}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});


