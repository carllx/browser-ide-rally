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
    assert.match(loggedWarning, /Failed to (?:cleanup|reconcile) workspace hooks?/i);
  } finally {
    cleanup();
  }
});

test('Seam 3.5: 活跃 sibling 存在但本地 allowlist 缺失 sibling conversation 时，移出操作以 active registry 为权威修复并保留 Hook', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const bindingA = createBinding({
      binding_id: 'proj-a-departing',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-a', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-a-departing',
        workspace_identity: workspacePath,
        repository_identity: 'repo-shared'
      }]
    });
    const bindingB = createBinding({
      binding_id: 'proj-b-surviving',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-b', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-b-surviving',
        workspace_identity: workspacePath,
        repository_identity: 'repo-shared'
      }]
    });

    registry.registerProject({ binding: bindingA });
    registry.registerProject({ binding: bindingB });

    const hookMgr = new WorkspaceHookManager();
    // 模拟不完整的本地 allowlist：只记录了即将离开的 conv-a-departing，遗漏了 conv-b-surviving
    hookMgr.ensureWorkspaceHook(workspacePath, 'conv-a-departing');
    const allowlistPath = path.join(workspacePath, '.agents', 'rally-conversations.json');
    const hooksJsonPath = path.join(workspacePath, '.agents', 'hooks.json');
    fs.writeFileSync(allowlistPath, JSON.stringify({ conversations: ['conv-a-departing'] }, null, 2), 'utf8');

    // 移出项目 A
    const req = makeMockRequest({ expected_binding_revision: 1 });
    const res = makeMockResponse();
    await handleProjectRemovalRequest({
      req,
      res,
      bindingId: 'proj-a-departing',
      registry,
      workspaceHookManager: hookMgr
    });

    assert.equal(res.statusCode, 200);
    assert.equal(registry.hasProject('proj-a-departing'), false);
    assert.equal(registry.hasProject('proj-b-surviving'), true);

    // 权威对齐结果：Rally Hook 绝对没有被误删！
    assert.equal(fs.existsSync(hooksJsonPath), true);
    const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(hooksData['rally-ide-stop-hook'], 'Rally stop hook must survive for active sibling');

    // 白名单根据 active registry 权威真值被自动修复为包含 conv-b-surviving
    assert.equal(fs.existsSync(allowlistPath), true);
    const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    assert.deepEqual(allowlist.conversations, ['conv-b-surviving']);
  } finally {
    cleanup();
  }
});

test('Seam 3.6: 本地 allowlist 损坏时，活跃 sibling 仍需该工作区，Hook 必须保留且 allowlist 被自动修复', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const bindingA = createBinding({
      binding_id: 'proj-corrupt-a',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-ca', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-ca',
        workspace_identity: workspacePath,
        repository_identity: 'repo-shared'
      }]
    });
    const bindingB = createBinding({
      binding_id: 'proj-corrupt-b',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-cb', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-cb',
        workspace_identity: workspacePath,
        repository_identity: 'repo-shared'
      }]
    });

    registry.registerProject({ binding: bindingA });
    registry.registerProject({ binding: bindingB });

    const hookMgr = new WorkspaceHookManager();
    hookMgr.ensureWorkspaceHook(workspacePath, 'conv-ca');

    const allowlistPath = path.join(workspacePath, '.agents', 'rally-conversations.json');
    const hooksJsonPath = path.join(workspacePath, '.agents', 'hooks.json');
    // 写入畸形的非 JSON 内容模拟 allowlist 文件损坏
    fs.writeFileSync(allowlistPath, '<<<MALFORMED JSON CONTENT>>>', 'utf8');

    // 移出项目 A
    const req = makeMockRequest({ expected_binding_revision: 1 });
    const res = makeMockResponse();
    await handleProjectRemovalRequest({
      req,
      res,
      bindingId: 'proj-corrupt-a',
      registry,
      workspaceHookManager: hookMgr
    });

    assert.equal(res.statusCode, 200);

    // Rally Hook 完好保留
    const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(hooksData['rally-ide-stop-hook']);

    // 白名单恢复为合法的 JSON，并以 active registry 为准记录 conv-cb
    const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    assert.deepEqual(allowlist.conversations, ['conv-cb']);
  } finally {
    cleanup();
  }
});

test('Seam 3.7: 存在第三方 hooks 时，移出完全孤立的工作区仅删除 Rally Hook，严格保留第三方 hooks', async () => {
  const { workspacePath, cleanup } = createTempWorkspace();
  try {
    const registry = createProjectRegistry();
    const binding = createBinding({
      binding_id: 'proj-third-party',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-conv-tp', branch: 'main' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-tp',
        workspace_identity: workspacePath,
        repository_identity: 'repo-tp'
      }]
    });
    registry.registerProject({ binding });

    const hookMgr = new WorkspaceHookManager();
    hookMgr.ensureWorkspaceHook(workspacePath, 'conv-tp');

    const hooksJsonPath = path.join(workspacePath, '.agents', 'hooks.json');
    // 在 hooks.json 中添加第三方 hook
    const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    hooksData['third-party-linter-hook'] = {
      Stop: [{ type: 'command', command: 'run-linter.sh' }]
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksData, null, 2), 'utf8');

    // 移出该项目
    const req = makeMockRequest({ expected_binding_revision: 1 });
    const res = makeMockResponse();
    await handleProjectRemovalRequest({
      req,
      res,
      bindingId: 'proj-third-party',
      registry,
      workspaceHookManager: hookMgr
    });

    assert.equal(res.statusCode, 200);

    // hooks.json 仍然存在，第三方 hook 严格保留，rally hook 被删除
    assert.equal(fs.existsSync(hooksJsonPath), true);
    const updatedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(updatedHooks['rally-ide-stop-hook'], undefined);
    assert.ok(updatedHooks['third-party-linter-hook']);
  } finally {
    cleanup();
  }
});
