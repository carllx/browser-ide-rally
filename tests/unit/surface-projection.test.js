/**
 * 状态表面投影单元测试 (Surface Projection Unit Tests)
 * 验证 Issue #17 规定的投影领域不变式与防混淆语义
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBinding } from '../../src/controller/binding.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { projectStatusSurface, projectRegistrySurface, canEndpointMarkHandled } from '../../src/surface/surface-projection.js';

describe('Surface Projection 单元测试', () => {
  const baseBinding = {
    binding_id: 'proj-alpha',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-chat-1'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-a',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-a',
        workspace_identity: '/ws/shared-repo',
        repository_identity: 'github.com/org/repo'
      },
      {
        endpoint_id: 'ide-b',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-b',
        workspace_identity: '/ws/shared-repo',
        repository_identity: 'github.com/org/repo'
      }
    ],
    capabilities: ['read', 'write'],
    paused: false
  };

  it('1. 正确投影单个项目并保留 Browser 与多 IDE 的独立结果状态', () => {
    const core = createProjectStatusCore({ binding: baseBinding });
    const snapshot = core.getSnapshot();
    const surface = projectStatusSurface(snapshot);

    assert.equal(surface.binding_id, 'proj-alpha');
    assert.equal(surface.binding_revision, 1);
    assert.equal(surface.paused, false);

    // 默认初始状态均为 UNKNOWN
    assert.equal(surface.browser.result_state, 'UNKNOWN');
    assert.equal(surface.browser.can_mark_handled, false);
    assert.equal(surface.ide_endpoints.length, 2);
    assert.equal(surface.ide_endpoints[0].endpoint_id, 'ide-a');
    assert.equal(surface.ide_endpoints[0].result_state, 'UNKNOWN');
    assert.equal(surface.ide_endpoints[1].endpoint_id, 'ide-b');
    assert.equal(surface.ide_endpoints[1].result_state, 'UNKNOWN');

    // 独立平面
    assert.equal(surface.human_intervention.active, false);
    assert.deepEqual(surface.actions, []);
  });

  it('2. Triple NEW: Browser + IDE-A + IDE-B 同时为 NEW 且互不压缩掩盖', () => {
    const core = createProjectStatusCore({ binding: baseBinding });

    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'browser-cursor-100',
      completed_at: '2026-09-17T10:00:00.000Z',
      provider: 'chatgpt',
      conversation_id: 'conv-chat-1',
      endpoint_revision: 1
    });

    core.recordEndpointObservation('ide-a', {
      trusted: true,
      latest_completed_cursor: 'ide-a-cursor-200',
      completed_at: '2026-09-17T10:01:00.000Z',
      endpoint_id: 'ide-a',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-a',
      workspace_identity: '/ws/shared-repo',
      repository_identity: 'github.com/org/repo'
    });

    core.recordEndpointObservation('ide-b', {
      trusted: true,
      latest_completed_cursor: 'ide-b-cursor-300',
      completed_at: '2026-09-17T10:02:00.000Z',
      endpoint_id: 'ide-b',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-b',
      workspace_identity: '/ws/shared-repo',
      repository_identity: 'github.com/org/repo'
    });

    const surface = projectStatusSurface(core.getSnapshot());

    assert.equal(surface.browser.result_state, 'NEW');
    assert.equal(surface.browser.latest_completed_cursor, 'browser-cursor-100');
    assert.equal(surface.browser.can_mark_handled, true);

    const ideA = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-a');
    assert.equal(ideA.result_state, 'NEW');
    assert.equal(ideA.latest_completed_cursor, 'ide-a-cursor-200');
    assert.equal(ideA.can_mark_handled, true);

    const ideB = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-b');
    assert.equal(ideB.result_state, 'NEW');
    assert.equal(ideB.latest_completed_cursor, 'ide-b-cursor-300');
    assert.equal(ideB.can_mark_handled, true);
  });

  it('3. Sibling NEW + UNKNOWN：UNKNOWN 绝不展示为 idle，且 can_mark_handled 为 false', () => {
    const core = createProjectStatusCore({ binding: baseBinding });

    // IDE-A 推进为 NEW
    core.recordEndpointObservation('ide-a', {
      trusted: true,
      latest_completed_cursor: 'cursor-a',
      endpoint_id: 'ide-a',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-a'
    });

    // IDE-B 报告 continuity_lost
    core.recordEndpointObservation('ide-b', {
      continuity_lost: true,
      reason: 'continuity_lost',
      endpoint_id: 'ide-b',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-b'
    });

    const surface = projectStatusSurface(core.getSnapshot());
    const ideA = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-a');
    const ideB = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-b');

    assert.equal(ideA.result_state, 'NEW');
    assert.equal(ideA.can_mark_handled, true);

    assert.equal(ideB.result_state, 'UNKNOWN');
    assert.equal(ideB.continuity.trusted, false);
    assert.equal(ideB.continuity.unknown_reason, 'continuity_lost');
    assert.equal(ideB.can_mark_handled, false);
  });

  it('4. 同一仓库/工作区多端点能够精确识别防串台标记', () => {
    const core = createProjectStatusCore({ binding: baseBinding });
    const surface = projectStatusSurface(core.getSnapshot());

    assert.equal(surface.disambiguation.has_shared_ide_workspace, true);
    assert.equal(surface.disambiguation.has_shared_ide_repository, true);

    // 两端点仍然保有截然不同的会话与端点 ID
    const ideA = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-a');
    const ideB = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-b');
    assert.equal(ideA.conversation_id, 'conv-ide-a');
    assert.equal(ideB.conversation_id, 'conv-ide-b');
  });

  it('5. 人工介入平面独立共存，不成为端点状态', () => {
    const core = createProjectStatusCore({ binding: baseBinding });
    core.setHumanIntervention({ active: true, reason: 'Manual review of PR #42 required' });

    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'c-1',
      provider: 'chatgpt',
      conversation_id: 'conv-chat-1',
      endpoint_revision: 1
    });

    const surface = projectStatusSurface(core.getSnapshot());

    assert.equal(surface.human_intervention.active, true);
    assert.equal(surface.human_intervention.reason, 'Manual review of PR #42 required');
    // 端点仍然是独立的 NEW 状态
    assert.equal(surface.browser.result_state, 'NEW');
  });

  it('6. Action 事实平面保留细粒度生命周期 stage，严禁折叠为 generic sent', () => {
    const core = createProjectStatusCore({ binding: baseBinding });
    core.recordActionFact({
      action_id: 'act-1',
      action_type: 'relay',
      target_endpoint: 'ide-a',
      stage: 'REQUESTED'
    });
    core.recordActionFact({
      action_id: 'act-2',
      action_type: 'relay',
      target_endpoint: 'ide-b',
      stage: 'ACCEPTED_OR_DELIVERED'
    });

    const surface = projectStatusSurface(core.getSnapshot());
    assert.equal(surface.actions.length, 2);
    assert.equal(surface.actions[0].stage, 'REQUESTED');
    assert.equal(surface.actions[1].stage, 'ACCEPTED_OR_DELIVERED');
  });

  it('7. projectRegistrySurface 能够对跨项目相似/同仓库端点注入 disambiguation 提示', () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: baseBinding });

    const secondBinding = {
      binding_id: 'proj-beta',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'conv-2' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-beta-ide',
        workspace_identity: '/ws/beta',
        repository_identity: 'github.com/org/repo' // 与 proj-alpha 相同的仓库
      }],
      capabilities: ['read', 'write'],
      paused: false
    };
    reg.registerProject({ binding: secondBinding });

    const surfaces = projectRegistrySurface(reg);
    assert.equal(surfaces.length, 2);
    assert.equal(surfaces[0].disambiguation.shared_repo_with_other_projects, true);
    assert.equal(surfaces[1].disambiguation.shared_repo_with_other_projects, true);
  });

  it('8. 浏览器分支 (branch) 可明确识别且不引入任何 mainline 推断', () => {
    const branchBinding = {
      ...baseBinding,
      binding_id: 'proj-branch-test',
      browser: {
        provider: 'chatgpt',
        conversation_id: 'conv-branch-1',
        branch: 'feat/experiment-branch'
      }
    };
    const core = createProjectStatusCore({ binding: branchBinding });
    const surface = projectStatusSurface(core.getSnapshot());

    assert.equal(surface.browser.conversation_id, 'conv-branch-1');
    assert.equal(surface.browser.branch, 'feat/experiment-branch');
    assert.equal('mainline' in surface.browser, false);
    assert.equal('baton' in surface.browser, false);
  });

  it('9. canEndpointMarkHandled 纯函数严格校验受信、NEW 及有效游标', () => {
    // 正常 NEW 且受信
    const validFact = {
      result_state: 'NEW',
      latest_completed_cursor: 'c-1',
      continuity: { trusted: true }
    };
    assert.equal(canEndpointMarkHandled(validFact), true);

    // 数字游标 (0 或 123) 亦为有效游标
    assert.equal(canEndpointMarkHandled({ ...validFact, latest_completed_cursor: 0 }), true);

    // 未受信
    assert.equal(canEndpointMarkHandled({ ...validFact, continuity: { trusted: false } }), false);

    // 游标为 null
    assert.equal(canEndpointMarkHandled({ ...validFact, latest_completed_cursor: null }), false);

    // 非 NEW 状态 (NO_NEW_RESULT)
    assert.equal(canEndpointMarkHandled({ ...validFact, result_state: 'NO_NEW_RESULT' }), false);
  });

  it('10. 规范链路：createBinding(...) -> ProjectRegistry -> Core -> snapshot -> surface 保证 conversation_id 与 branch 完整存活并渲染', () => {
    const canonicalBinding = createBinding({
      binding_id: 'proj-canonical-branch',
      browser: {
        provider: 'chatgpt',
        conversation_id: 'conv-canonical-001',
        branch: 'feat/canonical-branch-flow'
      },
      ide_endpoints: [{
        endpoint_id: 'ide-agent',
        endpoint_revision: 1,
        conversation_id: 'conv-canonical-ide',
        workspace_identity: '/ws/canonical',
        repository_identity: 'github.com/org/canonical'
      }]
    });

    // 确认 createBinding 保留了 branch
    assert.equal(canonicalBinding.browser.branch, 'feat/canonical-branch-flow');
    assert.equal(canonicalBinding.browser.conversation_id, 'conv-canonical-001');

    // 经由 ProjectRegistry / Status Core 真实链路
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: canonicalBinding });
    const snapshot = core.getSnapshot();

    assert.equal(snapshot.binding.browser.conversation_id, 'conv-canonical-001');
    assert.equal(snapshot.binding.browser.branch, 'feat/canonical-branch-flow');

    // 表面投影
    const surface = projectStatusSurface(snapshot);
    assert.equal(surface.browser.conversation_id, 'conv-canonical-001');
    assert.equal(surface.browser.branch, 'feat/canonical-branch-flow');
    assert.equal('mainline' in surface.browser, false);
    assert.equal('baton' in surface.browser, false);
  });

  it('11. updateBinding 严格拦截对 browser.branch 的静默修改漏洞', () => {
    const canonicalBinding = createBinding({
      binding_id: 'proj-branch-guard',
      browser: {
        provider: 'chatgpt',
        conversation_id: 'conv-guard-001',
        branch: 'feat/initial-branch'
      },
      ide_endpoints: [{
        endpoint_id: 'ide-agent',
        endpoint_revision: 1,
        conversation_id: 'conv-guard-ide',
        workspace_identity: '/ws/guard',
        repository_identity: 'github.com/org/guard'
      }]
    });

    const core = createProjectStatusCore({ binding: canonicalBinding });

    // 尝试通过 updateBinding 静默变更 branch
    const tamperedBinding = {
      ...canonicalBinding,
      browser: {
        ...canonicalBinding.browser,
        branch: 'feat/tampered-branch'
      }
    };

    assert.throws(() => {
      core.updateBinding(tamperedBinding);
    }, /Identity-changing rebind is prohibited in Status Core; use rebindEndpoint\(\)/);
  });

  it('12. 注册表 durable 持久化与重启恢复完整保留 browser.branch 事实', () => {
    const tmpFile = `/tmp/rally-reg-branch-test-${Date.now()}.json`;
    try {
      const reg1 = createProjectRegistry({ storagePath: tmpFile });
      const b = createBinding({
        binding_id: 'proj-durable-branch',
        browser: {
          provider: 'chatgpt',
          conversation_id: 'conv-durable-001',
          branch: 'feat/durable-branch-persist'
        },
        ide_endpoints: [{
          endpoint_id: 'ide-1',
          conversation_id: 'conv-ide-1',
          workspace_identity: '/ws/durable',
          repository_identity: 'github.com/org/durable'
        }]
      });
      reg1.registerProject({ binding: b });
      reg1.saveToFile(tmpFile);

      // 从文件重新载入
      const reg2 = createProjectRegistry({ storagePath: tmpFile });
      const reloadedCore = reg2.getProject('proj-durable-branch');
      const surface = projectStatusSurface(reloadedCore.getSnapshot());

      assert.equal(surface.browser.conversation_id, 'conv-durable-001');
      assert.equal(surface.browser.branch, 'feat/durable-branch-persist');
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });
});

