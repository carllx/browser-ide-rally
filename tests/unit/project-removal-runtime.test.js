import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import { WorkspaceHookManager } from '../../src/runtime/workspace-hook-manager.js';
import { ObservationRuntimeCoordinator } from '../../src/runtime/observation-runtime-coordinator.js';
import { handleProjectRemovalRequest } from '../../src/surface/project-removal-controller.js';

function createTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-ws-hook-test-'));
  return {
    workspacePath: dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  };
}

function makeMockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    },
    end(data) {
      this.body = data;
    }
  };
}

import { Readable } from 'node:stream';

function makeMockRequest(bodyObj) {
  const stream = new Readable({
    read() {
      this.push(JSON.stringify(bodyObj));
      this.push(null);
    }
  });
  stream.headers = { 'content-type': 'application/json' };
  return stream;
}

test('Seam 3.1: 孤立工作区 Hook 与白名单在项目移出后被彻底清理', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const binding = createBinding({
      binding_id: 'proj-orphan',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-1', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-orphan-ide',
        workspace_identity: workspacePath,
        repository_identity: 'repo-1'
      }]
    });
    registry.registerProject({ binding });

    const hookMgr = new WorkspaceHookManager();
    // 预先安装 Hook
    const installRes = hookMgr.ensureWorkspaceHook(workspacePath, 'conv-orphan-ide');
    assert.equal(installRes.success, true);

    const allowlistPath = path.join(workspacePath, '.agents', 'rally-conversations.json');
    const hooksJsonPath = path.join(workspacePath, '.agents', 'hooks.json');
    assert.equal(fs.existsSync(allowlistPath), true);
    assert.equal(fs.existsSync(hooksJsonPath), true);

    // 执行移出
    const req = await makeMockRequest({ expected_binding_revision: 1 });
    const res = makeMockResponse();
    await handleProjectRemovalRequest({
      req,
      res,
      bindingId: 'proj-orphan',
      registry,
      workspaceHookManager: hookMgr
    });

    assert.equal(res.statusCode, 200);
    assert.equal(registry.hasProject('proj-orphan'), false);

    // 孤立工作区：白名单与 Rally Stop Hook 被清理
    assert.equal(fs.existsSync(allowlistPath), false);
    if (fs.existsSync(hooksJsonPath)) {
      const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.equal(hooksData['rally-ide-stop-hook'], undefined);
    }
  } finally {
    cleanup();
  }
});

test('Seam 3.2: 共享工作区在移出一个项目后，保留存活项目的白名单与 Hook', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const bindingA = createBinding({
      binding_id: 'proj-shared-a',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-a', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-a',
        workspace_identity: workspacePath,
        repository_identity: 'repo-shared'
      }]
    });
    const bindingB = createBinding({
      binding_id: 'proj-shared-b',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-b', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-b',
        workspace_identity: workspacePath,
        repository_identity: 'repo-shared'
      }]
    });

    registry.registerProject({ binding: bindingA });
    registry.registerProject({ binding: bindingB });

    const hookMgr = new WorkspaceHookManager();
    hookMgr.ensureWorkspaceHook(workspacePath, 'conv-ide-a');
    hookMgr.ensureWorkspaceHook(workspacePath, 'conv-ide-b');

    const allowlistPath = path.join(workspacePath, '.agents', 'rally-conversations.json');
    const hooksJsonPath = path.join(workspacePath, '.agents', 'hooks.json');

    // 移出项目 A
    const req = await makeMockRequest({ expected_binding_revision: 1 });
    const res = makeMockResponse();
    await handleProjectRemovalRequest({
      req,
      res,
      bindingId: 'proj-shared-a',
      registry,
      workspaceHookManager: hookMgr
    });

    assert.equal(res.statusCode, 200);
    assert.equal(registry.hasProject('proj-shared-a'), false);
    assert.equal(registry.hasProject('proj-shared-b'), true);

    // 共享工作区：白名单中仍然包含 conv-ide-b，且 Rally Hook 依旧存在
    assert.equal(fs.existsSync(allowlistPath), true);
    const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    assert.deepEqual(allowlist.conversations, ['conv-ide-b']);

    assert.equal(fs.existsSync(hooksJsonPath), true);
    const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(hooksData['rally-ide-stop-hook']);
  } finally {
    cleanup();
  }
});

test('Seam 3.3: 项目移出后，Hook Ingress 拒绝路由该会话 (Fail-Closed) 且 Browser 不再轮询', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const binding = createBinding({
      binding_id: 'proj-runtime-check',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-rt', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-rt-ide',
        workspace_identity: workspacePath,
        repository_identity: 'repo-rt'
      }]
    });
    registry.registerProject({ binding });

    let observedBrowserCount = 0;
    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => {
        observedBrowserCount++;
        return {
          trusted: true,
          latest_completed_cursor: 'cursor-1'
        };
      }
    };

    const coordinator = new ObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter
    });

    // 移出前：Hook Ingress 能正常匹配
    const hookBefore = coordinator.handleAntigravityHook({
      conversationId: 'conv-rt-ide'
    });
    // 会因为未准备真实 transcript 报错，但已进入路由（accepted: false, reason 包含 transcript 或其他，但绝非 unknown_conversation_not_bound）
    assert.notEqual(hookBefore.reason, 'unknown_conversation_not_bound');

    // 移出前：单次轮询能观察到项目
    const pollStats1 = await coordinator.browserDriver.pollOnce();
    assert.equal(pollStats1.recordedCount, 1);

    // 执行移出
    registry.removeProject('proj-runtime-check', { expected_binding_revision: 1 });

    // 移出后：Hook Ingress 严格 Fail-Closed
    const hookAfter = coordinator.handleAntigravityHook({
      conversationId: 'conv-rt-ide'
    });
    assert.equal(hookAfter.accepted, false);
    assert.equal(hookAfter.reason, 'unknown_conversation_not_bound');

    // 移出后：Browser 驱动器执行轮询，项目列表为空，不再轮询该项目
    const pollStats2 = await coordinator.browserDriver.pollOnce();
    assert.equal(pollStats2.recordedCount, 0);
    assert.equal(pollStats2.skippedCount, 0);
  } finally {
    cleanup();
  }
});

test('Seam 3.4: Hook 清理异常容错 (Fail-Visible，绝不破坏 active registry 的原子提交)', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const binding = createBinding({
      binding_id: 'proj-fail-visible',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-fv', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-fv-ide',
        workspace_identity: workspacePath,
        repository_identity: 'repo-fv'
      }]
    });
    registry.registerProject({ binding });

    // 构造一个在 removeWorkspaceHook 抛出 IO 异常的 mock hook manager
    const faultyHookMgr = {
      removeWorkspaceHook: () => {
        throw new Error('EPERM: operation not permitted on .agents/hooks.json');
      }
    };

    let loggedWarning = null;
    const mockLogger = {
      warn: (msg) => { loggedWarning = msg; },
      error: () => {},
      log: () => {}
    };

    const req = await makeMockRequest({ expected_binding_revision: 1 });
    const res = makeMockResponse();
    await handleProjectRemovalRequest({
      req,
      res,
      bindingId: 'proj-fail-visible',
      registry,
      workspaceHookManager: faultyHookMgr,
      logger: mockLogger
    });

    // 核心契约：注册表原子移出成功，HTTP 返回 200，Hook 清理异常被记录且不回滚注册表
    assert.equal(res.statusCode, 200);
    assert.equal(registry.hasProject('proj-fail-visible'), false);
    assert.equal(registry.hasRemovedProject('proj-fail-visible'), true);
    assert.ok(loggedWarning);
    assert.match(loggedWarning, /Failed to cleanup workspace hook/);
  } finally {
    cleanup();
  }
});
