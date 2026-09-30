/**
 * Conversation Rotation Active Uniqueness Integration Test
 * 
 * 聚焦验证 Issue #41 关键会话唯一性守卫 (Browser Review 5907407553):
 * 1. 仅排除目标槽位 (Target Slot Exclusion)：当前项目内的 Sibling IDE 活跃会话严禁被抢占，且零状态/代际变异；
 * 2. 跨项目活跃会话唯一性拦截：跨项目的活跃 IDE / Browser 会话严禁被 Rebind 抢占；
 * 3. Browser 端点具备有效 Provider 区分度：同一 conv_id 但不同 provider 允许共存，同 provider + 同 conv_id 严格拦截；
 * 4. 退役代际绝不占位：转入 retired_generations 的旧代际不阻塞其他项目重绑该会话。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

describe('Issue #41: 活跃会话唯一性守卫与目标槽位排除', () => {
  test('1. 同一项目内 Sibling IDE 活跃会话抢占被严格拦截，且零活跃/退役变异', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-sibling-test',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-init' },
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-primary',
            workspace_identity: '/ws/main',
            repository_identity: 'org/repo'
          },
          {
            endpoint_id: 'ide-secondary',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-secondary',
            workspace_identity: '/ws/sub',
            repository_identity: 'org/repo'
          }
        ]
      })
    });

    const snapBefore = core.getSnapshot();
    const revBefore = snapBefore.binding.binding_revision;
    const actionsBefore = snapBefore.actions.length;
    const updatedAtBefore = snapBefore.updated_at;

    // 尝试将 ide-primary 重绑到同一项目内活跃的 ide-secondary 会话
    assert.throws(() => {
      reg.rebindProjectEndpoint('proj-sibling-test', {
        endpoint_id: 'ide-primary',
        identity: {
          conversation_id: 'conv-ide-secondary',
          workspace_identity: '/ws/main',
          repository_identity: 'org/repo'
        }
      });
    }, /Antigravity conversation "conv-ide-secondary" is already bound to endpoint "ide-secondary" in the same project/);

    // 验证严格零变异
    const snapAfter = core.getSnapshot();
    assert.equal(snapAfter.binding.binding_revision, revBefore, '版本绝对不得递增');
    assert.equal(snapAfter.actions.length, actionsBefore, '不得创建 Action');
    assert.equal(snapAfter.updated_at, updatedAtBefore, 'updated_at 不得改变');
    assert.equal(core.getRetiredGenerations().length, 0, '不得追加退役代际');
    assert.equal(snapAfter.binding.ide_endpoints[0].conversation_id, 'conv-ide-primary');
    assert.equal(snapAfter.binding.ide_endpoints[1].conversation_id, 'conv-ide-secondary');
  });

  test('2. 跨项目活跃会话冲突拦截 (IDE + Browser)', () => {
    const reg = createProjectRegistry();
    const core1 = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-p1',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-p1' },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-p1',
          workspace_identity: '/ws/p1',
          repository_identity: 'org/repo1'
        }]
      })
    });

    reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-p2',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-p2' },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-p2',
          workspace_identity: '/ws/p2',
          repository_identity: 'org/repo2'
        }]
      })
    });

    const revBefore = core1.getSnapshot().binding.binding_revision;

    // 1. 尝试将 p1 IDE 重绑到 p2 的活跃 IDE 会话
    assert.throws(() => {
      reg.rebindProjectEndpoint('proj-p1', {
        endpoint_id: 'ide-1',
        identity: {
          conversation_id: 'conv-ide-p2',
          workspace_identity: '/ws/p1',
          repository_identity: 'org/repo1'
        }
      });
    }, /Antigravity conversation "conv-ide-p2" is already bound to project/);

    // 2. 尝试将 p1 Browser 重绑到 p2 的活跃 Browser 会话 (同 provider)
    assert.throws(() => {
      reg.rebindProjectEndpoint('proj-p1', {
        endpoint_id: 'browser',
        identity: {
          provider: 'chatgpt',
          conversation_id: 'conv-br-p2'
        }
      });
    }, /Browser conversation "conv-br-p2" is already bound to project/);

    // 验证零变异
    assert.equal(core1.getSnapshot().binding.binding_revision, revBefore);
    assert.equal(core1.getRetiredGenerations().length, 0);
  });

  test('3. Browser 唯一性必须具备 effective provider 区分度', () => {
    const reg = createProjectRegistry();
    const core1 = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-b1',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-shared-id' },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-b1',
          workspace_identity: '/ws/b1',
          repository_identity: 'org/b1'
        }]
      })
    });

    const core2 = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-b2',
        binding_revision: 1,
        browser: { provider: 'claude', conversation_id: 'conv-different-init' },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-b2',
          workspace_identity: '/ws/b2',
          repository_identity: 'org/b2'
        }]
      })
    });

    // 3a. 同一 conversation_id 但不同 provider（如 'claude' vs 'chatgpt'）允许合法共存
    const okSnap = reg.rebindProjectEndpoint('proj-b2', {
      endpoint_id: 'browser',
      identity: {
        provider: 'claude',
        conversation_id: 'conv-shared-id' // 与 proj-b1 相同 conv_id，但 provider 不同
      }
    });
    assert.equal(okSnap.binding.browser.provider, 'claude');
    assert.equal(okSnap.binding.browser.conversation_id, 'conv-shared-id');

    // 3b. 若重绑至相同 provider + 相同 conversation_id，必须严格拦截
    assert.throws(() => {
      reg.rebindProjectEndpoint('proj-b2', {
        endpoint_id: 'browser',
        identity: {
          provider: 'chatgpt',
          conversation_id: 'conv-shared-id' // proj-b1 正在使用的 chatgpt:conv-shared-id
        }
      });
    }, /Browser conversation "conv-shared-id" is already bound to project/);
  });

  test('4. 退役代际绝不占位：转入 retired_generations 的旧代际不阻塞其他项目重绑该会话', () => {
    const reg = createProjectRegistry();
    const core1 = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-p1',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-p1' },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-p1',
          workspace_identity: '/ws/p1',
          repository_identity: 'org/repo1'
        }]
      })
    });

    const core2 = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-p2',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-p2' },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-p2',
          workspace_identity: '/ws/p2',
          repository_identity: 'org/repo2'
        }]
      })
    });

    // 项目 2 将 ide-1 轮换至新会话，原 conv-ide-p2 转入退役历史
    reg.rebindProjectEndpoint('proj-p2', {
      endpoint_id: 'ide-1',
      identity: {
        conversation_id: 'conv-ide-p2-next',
        workspace_identity: '/ws/p2',
        repository_identity: 'org/repo2'
      }
    });
    assert.equal(core2.getRetiredGenerations().length, 1);
    assert.equal(core2.getRetiredGenerations()[0].identity.conversation_id, 'conv-ide-p2');

    // 此时项目 1 可以合法 Rebind 到已退役的 conv-ide-p2 会话！
    const okSnap = reg.rebindProjectEndpoint('proj-p1', {
      endpoint_id: 'ide-1',
      identity: {
        conversation_id: 'conv-ide-p2',
        workspace_identity: '/ws/p1',
        repository_identity: 'org/repo1'
      }
    });
    assert.equal(okSnap.binding.ide_endpoints[0].conversation_id, 'conv-ide-p2');
  });

  test('5. Rebind 支持 endpoint alias，且同一目标 Rebind 依然是严格零变更 No-Op', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({
      binding: createBinding({
        binding_id: 'proj-alias-test',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-init' },
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-alias-1',
            workspace_identity: '/ws/main',
            repository_identity: 'org/repo'
          }
        ]
      })
    });

    const snapBefore = core.getSnapshot();
    const revBefore = snapBefore.binding.binding_revision;
    const actionsBefore = snapBefore.actions.length;
    const updatedAtBefore = snapBefore.updated_at;

    // 5a. 使用 endpoint: 'ide-primary' alias 进行同目标 Rebind
    const snapSame1 = reg.rebindProjectEndpoint('proj-alias-test', {
      endpoint: 'ide-primary',
      identity: {
        conversation_id: 'conv-ide-alias-1',
        workspace_identity: '/ws/main',
        repository_identity: 'org/repo'
      }
    });

    assert.equal(snapSame1.binding.binding_revision, revBefore, '同目标 Rebind 绝对不得递增版本');
    assert.equal(snapSame1.actions.length, actionsBefore, '不得创建任何 Action');
    assert.equal(snapSame1.updated_at, updatedAtBefore, 'updated_at 绝对不得变异');
    assert.equal(core.getRetiredGenerations().length, 0, '不得追加退役代际');

    // 5b. 单槽位下使用 endpoint: 'ide' alias 进行同目标 Rebind
    const snapSame2 = reg.rebindProjectEndpoint('proj-alias-test', {
      endpoint: 'ide',
      identity: {
        conversation_id: 'conv-ide-alias-1',
        workspace_identity: '/ws/main',
        repository_identity: 'org/repo'
      }
    });

    assert.equal(snapSame2.binding.binding_revision, revBefore, 'ide alias 同目标绝对不得递增版本');
    assert.equal(snapSame2.actions.length, actionsBefore, 'ide alias 同目标不得创建 Action');
    assert.equal(snapSame2.updated_at, updatedAtBefore, 'ide alias 同目标 updated_at 不得改变');
    assert.equal(core.getRetiredGenerations().length, 0, 'ide alias 同目标不得追加退役代际');
  });
});
