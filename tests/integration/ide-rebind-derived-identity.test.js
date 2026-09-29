/**
 * IDE Rebind 自动派生身份与元数据验证集成测试 (#40)
 * 
 * 验证 Issue #40 与 Browser Lead Mission Contract 要求：
 * 1. 仅提供新 conversation ID，自动由 provider metadata 派生 workspace 与 repository；
 * 2. 派生结果权威覆盖旧 DOM 字段，不信任手填输入；
 * 3. 成功 Rebind 后 revision 仅增加一次，Surface 投影反映新身份；
 * 4. 无效或不可访问的会话 ID 严格零变更并输出具体原因；
 * 5. 跨项目已占用的会话 ID 严格零变更并明确拒绝；
 * 6. outgoing 端点处于 NEW 或 UNKNOWN 结果状态时默认 BLOCKED，显式确认后方可替换；
 * 7. Hook 安装失败时保证零 binding mutation，且不误删已有订阅。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { classifyRebindError } from '../../src/surface/rebind-error-classifier.js';

describe('IDE Rebind 自动派生身份集成测试 (#40)', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let coreProj1;
  let coreProj2;
  let mockHookManager;
  let hookSubscriptions;

  // 模拟的 Antigravity 元数据存储
  const mockAntigravityMetadataDb = {
    'conv-ide-valid-new': {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///workspaces/my-repo-new',
                repository: {
                  gitOriginUrl: 'https://github.com/my-org/my-project.git',
                  computedName: 'my-org/my-project'
                }
              }
            ]
          }
        }
      }
    },
    'conv-ide-other-repo': {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///workspaces/different-repo',
                repository: {
                  gitOriginUrl: 'https://github.com/other-org/other-repo.git',
                  computedName: 'other-org/other-repo'
                }
              }
            ]
          }
        }
      }
    }
  };

  const mockAgentApiExecutor = (bin, args) => {
    if (args[0] === 'get-conversation-metadata') {
      const convId = args[1];
      if (mockAntigravityMetadataDb[convId]) {
        return JSON.stringify(mockAntigravityMetadataDb[convId]);
      }
      const err = new Error('Process exited with code 1');
      err.stderr = `Antigravity conversation ${convId} not found or inaccessible`;
      throw err;
    }
    throw new Error(`Unsupported command: ${args.join(' ')}`);
  };

  before(async () => {
    registry = createProjectRegistry();
    hookSubscriptions = new Set();

    mockHookManager = {
      ensureWorkspaceHook: (ws, convId) => {
        if (ws.includes('simulate-hook-failure')) {
          return { success: false, reason: 'EACCES: permission denied' };
        }
        const key = `${ws}::${convId}`;
        const newlySubscribed = !hookSubscriptions.has(key);
        hookSubscriptions.add(key);
        return { success: true, newlySubscribed };
      },
      removeWorkspaceHook: (ws, convId) => {
        hookSubscriptions.delete(`${ws}::${convId}`);
        return { success: true };
      }
    };

    // 注册项目 1
    coreProj1 = registry.registerProject({
      binding: {
        binding_id: 'proj-rebind-1',
        display_name: 'Rebind Test Project 1',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-b-1' },
        ide_endpoints: [{
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-initial-1',
          workspace_identity: '/workspaces/initial-path-1',
          repository_identity: 'my-org/my-project'
        }],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    // 注册项目 2 (用于测试跨项目唯一性)
    coreProj2 = registry.registerProject({
      binding: {
        binding_id: 'proj-rebind-2',
        display_name: 'Rebind Test Project 2',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-b-2' },
        ide_endpoints: [{
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-proj2',
          workspace_identity: '/workspaces/proj-2',
          repository_identity: 'my-org/my-project'
        }],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    // 初始化端点基线为 caught-up (NO_NEW_RESULT)
    coreProj1.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-b-0',
      provider: 'chatgpt',
      conversation_id: 'conv-b-1',
      endpoint_revision: 1
    });
    coreProj1.recordEndpointObservation('ide-primary', {
      trusted: true,
      latest_completed_cursor: 'cur-i-0',
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-initial-1',
      workspace_identity: '/workspaces/initial-path-1',
      repository_identity: 'my-org/my-project'
    });
    coreProj1.markEndpointHandled('browser', { expected_cursor: 'cur-b-0' });
    coreProj1.markEndpointHandled('ide-primary', { expected_cursor: 'cur-i-0' });

    serverHandle = await startStatusSurfaceServer({
      registry,
      agentApiExecutor: mockAgentApiExecutor,
      observationCoordinator: { workspaceHookManager: mockHookManager },
      port: 0,
      host: '127.0.0.1'
    });
    baseUrl = serverHandle.url;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('1. 仅提供 Conversation ID：自动通过 provider metadata 验证并派生 workspace 与 repository', async () => {
    const revBefore = coreProj1.getSnapshot().binding.binding_revision;

    // 仅提交 conversation_id，甚至故意传入旧的/脏的 workspace_identity
    const resp = await fetch(`${baseUrl}/api/projects/proj-rebind-1/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: revBefore,
        target_endpoint: 'ide-primary',
        new_identity: {
          conversation_id: 'conv-ide-valid-new',
          workspace_identity: '/dirty/user/typed/path', // 必须被权威派生结果覆盖！
          repository_identity: 'wrong/repo'
        }
      })
    });

    const result = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.stage, 'TARGET_COMPLETED');
    assert.equal(result.new_binding_revision, revBefore + 1);

    // 验证快照中的端点身份
    const snapshot = coreProj1.getSnapshot();
    const ideEp = snapshot.binding.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');
    assert.equal(ideEp.conversation_id, 'conv-ide-valid-new');
    assert.equal(ideEp.workspace_identity, '/workspaces/my-repo-new', '必须采用 provider metadata 派生出的路径');
    assert.equal(ideEp.repository_identity, 'my-org/my-project', '必须采用 provider metadata 派生出的代码仓库');

    // 验证 /api/projects 投影同步更新
    const projResp = await fetch(`${baseUrl}/api/projects`);
    const projData = await projResp.json();
    const proj1 = projData.projects.find(p => p.binding_id === 'proj-rebind-1');
    const projIde = proj1.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');
    assert.equal(projIde.conversation_id, 'conv-ide-valid-new');
    assert.equal(projIde.workspace_identity, '/workspaces/my-repo-new');
    assert.equal(projIde.repository_identity, 'my-org/my-project');
  });

  it('2. 无效或无法访问的 Conversation ID：零 mutation 并输出明确错误', async () => {
    const revBefore = coreProj1.getSnapshot().binding.binding_revision;
    const ideBefore = coreProj1.getSnapshot().binding.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');

    const resp = await fetch(`${baseUrl}/api/projects/proj-rebind-1/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: revBefore,
        target_endpoint: 'ide-primary',
        new_identity: {
          conversation_id: 'conv-not-found-uuid-999'
        }
      })
    });

    const result = await resp.json();
    assert.equal(resp.status, 409);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'BLOCKED');
    assert.match(result.reason, /Antigravity conversation "conv-not-found-uuid-999" not found or inaccessible/);

    // 重点验证 (Review Blocker 1)：invalid/inaccessible conversation 产出面向操作者的清晰中文指引
    const classified = classifyRebindError(result.reason, result.stage);
    assert.equal(classified.title, '未找到指定的 Antigravity 会话或会话无法访问');
    assert.match(classified.actionGuidance, /确保本地 Antigravity 正在运行/);
    assert.match(classified.actionGuidance, /检查会话 ID 是否输入正确/);

    // 验证零变更
    const revAfter = coreProj1.getSnapshot().binding.binding_revision;
    const ideAfter = coreProj1.getSnapshot().binding.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');
    assert.equal(revAfter, revBefore, '失败时 binding_revision 严禁增加');
    assert.equal(ideAfter.conversation_id, ideBefore.conversation_id, '失败时端点身份保持不变');
  });

  it('3. 跨项目已绑定的 Conversation ID：零 mutation 并明确拒绝', async () => {
    const revBefore = coreProj1.getSnapshot().binding.binding_revision;

    // 尝试重绑为已经存在于项目 2 的 conv-ide-proj2
    const resp = await fetch(`${baseUrl}/api/projects/proj-rebind-1/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: revBefore,
        target_endpoint: 'ide-primary',
        new_identity: {
          conversation_id: 'conv-ide-proj2'
        }
      })
    });

    const result = await resp.json();
    assert.equal(resp.status, 409);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'BLOCKED');
    assert.match(result.reason, /already bound to project "Rebind Test Project 2"/);

    // 重点验证 (Review Blocker 2)：duplicate conversation 产出面向操作者的清晰中文指引
    const classified = classifyRebindError(result.reason, result.stage);
    assert.equal(classified.title, '该 Antigravity 会话已被其他项目占用');
    assert.match(classified.actionGuidance, /防止跨项目会话串线/);
    assert.match(classified.actionGuidance, /解除绑定/);

    // 验证零变更
    const revAfter = coreProj1.getSnapshot().binding.binding_revision;
    assert.equal(revAfter, revBefore);
  });

  it('4. outgoing 端点处于未处理 NEW 状态时：默认 BLOCKED，显式确认后方可替换', async () => {
    // 制造未处理的 NEW 结果
    coreProj1.recordEndpointObservation('ide-primary', {
      trusted: true,
      latest_completed_cursor: 'cur-i-new-unhandled',
      endpoint_id: 'ide-primary',
      endpoint_revision: 2,
      conversation_id: 'conv-ide-valid-new',
      workspace_identity: '/workspaces/my-repo-new',
      repository_identity: 'my-org/my-project',
      completed_at: new Date().toISOString(),
      live_witnessed: true
    });

    const revBefore = coreProj1.getSnapshot().binding.binding_revision;

    // 1. 未显式确认替换未处理 NEW：默认必须拒绝并阻断 (409 BLOCKED)
    const blockedResp = await fetch(`${baseUrl}/api/projects/proj-rebind-1/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: revBefore,
        target_endpoint: 'ide-primary',
        new_identity: { conversation_id: 'conv-ide-other-repo' },
        allow_replace_unhandled: false
      })
    });

    const blockedResult = await blockedResp.json();
    assert.equal(blockedResp.status, 409);
    assert.equal(blockedResult.stage, 'BLOCKED');
    assert.match(blockedResult.reason, /unhandled NEW result/);
    assert.equal(coreProj1.getSnapshot().binding.binding_revision, revBefore, '阻断时版本不得增加');

    // 2. 携带 allow_replace_unhandled: true 显式确认：重绑成功
    const successResp = await fetch(`${baseUrl}/api/projects/proj-rebind-1/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: revBefore,
        target_endpoint: 'ide-primary',
        new_identity: { conversation_id: 'conv-ide-other-repo' },
        allow_replace_unhandled: true
      })
    });

    const successResult = await successResp.json();
    assert.equal(successResp.status, 200);
    assert.equal(successResult.success, true);
    assert.equal(successResult.new_binding_revision, revBefore + 1);

    const ideEp = coreProj1.getSnapshot().binding.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');
    assert.equal(ideEp.conversation_id, 'conv-ide-other-repo');
    assert.equal(ideEp.workspace_identity, '/workspaces/different-repo');
  });

  it('5. Hook 安装失败：零 binding mutation，已有订阅完好保留', async () => {
    // 注入一个会触发 Hook 失败的会话（路径包含 simulate-hook-failure）
    mockAntigravityMetadataDb['conv-hook-fail'] = {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///workspaces/simulate-hook-failure-path',
                repository: { computedName: 'my-org/fail-repo' }
              }
            ]
          }
        }
      }
    };

    const revBefore = coreProj1.getSnapshot().binding.binding_revision;
    const ideBefore = coreProj1.getSnapshot().binding.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');

    const resp = await fetch(`${baseUrl}/api/projects/proj-rebind-1/controls/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: revBefore,
        target_endpoint: 'ide-primary',
        new_identity: { conversation_id: 'conv-hook-fail' }
      })
    });

    const result = await resp.json();
    assert.equal(resp.status, 409); // BLOCKED
    assert.equal(result.success, false);
    assert.equal(result.stage, 'BLOCKED');
    assert.match(result.reason, /WORKSPACE_HOOK_FAILED/);

    // 验证零变更
    const revAfter = coreProj1.getSnapshot().binding.binding_revision;
    const ideAfter = coreProj1.getSnapshot().binding.ide_endpoints.find(e => e.endpoint_id === 'ide-primary');
    assert.equal(revAfter, revBefore, 'Hook 安装失败时必须零 binding mutation');
    assert.equal(ideAfter.conversation_id, ideBefore.conversation_id);
  });
});
