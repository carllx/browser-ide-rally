/**
 * 状态表面投影单元测试 (Surface Projection Unit Tests)
 * 验证 Issue #17 规定的投影领域不变式与防混淆语义
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { projectStatusSurface, projectRegistrySurface } from '../../src/surface/surface-projection.js';

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
});
