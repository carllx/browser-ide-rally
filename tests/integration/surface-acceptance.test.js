/**
 * Issue #17 综合验收测试套件 (Surface Acceptance Test Suite)
 * 严格覆盖 Issue #17 与契约评论 5711394249 规定的全部验收准则
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { projectRegistrySurface } from '../../src/surface/surface-projection.js';
import { renderStatusSurfaceHtml } from '../../src/surface/surface-template.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

describe('Issue #17 综合验收测试', () => {
  let registry;
  let serverHandle;
  let baseUrl;

  // 场景 1: 多项目同时渲染，包含相似命名的项目 (anti-confusion)
  // 场景 2: Triple NEW (Browser NEW + IDE-A NEW + IDE-B NEW)
  // 场景 3: Sibling IDE NEW + UNKNOWN (Fail-closed，绝无 IDLE)
  // 场景 4: 同一仓库/工作区但在不同项目及不同端点/会话
  // 场景 5: Human Intervention 与 Endpoint NEW 共存
  // 场景 6: Action facts 细粒度生命周期各阶段共存
  before(async () => {
    registry = createProjectRegistry();

    // 项目 1: Triple NEW 项目
    const core1 = registry.registerProject({
      binding: {
        binding_id: 'rally-core-service',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-browser-service' },
        ide_endpoints: [
          {
            endpoint_id: 'ide-agent-primary',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-agent-1',
            workspace_identity: '/repo/rally-core',
            repository_identity: 'github.com/carllx/browser-ide-rally'
          },
          {
            endpoint_id: 'ide-agent-secondary',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-agent-2',
            workspace_identity: '/repo/rally-core',
            repository_identity: 'github.com/carllx/browser-ide-rally'
          }
        ],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    core1.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-b-1',
      provider: 'chatgpt',
      conversation_id: 'conv-browser-service',
      endpoint_revision: 1
    });
    core1.recordEndpointObservation('ide-agent-primary', {
      trusted: true,
      latest_completed_cursor: 'cur-ide-1',
      endpoint_id: 'ide-agent-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-agent-1',
      workspace_identity: '/repo/rally-core',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });
    core1.recordEndpointObservation('ide-agent-secondary', {
      trusted: true,
      latest_completed_cursor: 'cur-ide-2',
      endpoint_id: 'ide-agent-secondary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-agent-2',
      workspace_identity: '/repo/rally-core',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });

    // 项目 2: 名字极度相似的项目 (rally-core-service-staging)，且共用仓库但会话不同
    const core2 = registry.registerProject({
      binding: {
        binding_id: 'rally-core-service-staging',
        binding_revision: 2,
        browser: { provider: 'chatgpt', conversation_id: 'conv-browser-staging' },
        ide_endpoints: [
          {
            endpoint_id: 'ide-worker-a',
            endpoint_revision: 1,
            conversation_id: 'conv-staging-worker-a',
            workspace_identity: '/repo/rally-core-staging',
            repository_identity: 'github.com/carllx/browser-ide-rally'
          },
          {
            endpoint_id: 'ide-worker-b',
            endpoint_revision: 1,
            conversation_id: 'conv-staging-worker-b',
            workspace_identity: '/repo/rally-core-staging',
            repository_identity: 'github.com/carllx/browser-ide-rally'
          }
        ],
        capabilities: ['read'],
        paused: true
      }
    });

    // 兄弟端点: worker-a 为 NEW，worker-b 为 UNKNOWN (continuity_lost)
    core2.recordEndpointObservation('ide-worker-a', {
      trusted: true,
      latest_completed_cursor: 'cur-worker-a-99',
      endpoint_id: 'ide-worker-a',
      endpoint_revision: 1,
      conversation_id: 'conv-staging-worker-a',
      workspace_identity: '/repo/rally-core-staging',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });
    core2.recordEndpointObservation('ide-worker-b', {
      continuity_lost: true,
      reason: 'continuity_lost',
      endpoint_id: 'ide-worker-b',
      endpoint_revision: 1,
      conversation_id: 'conv-staging-worker-b',
      workspace_identity: '/repo/rally-core-staging',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });

    // 项目 3: 包含活跃人工介入与 Action Facts 的项目
    const core3 = registry.registerProject({
      binding: {
        binding_id: 'rally-infra-ops',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-infra-browser' },
        ide_endpoints: [
          {
            endpoint_id: 'ide-deployer',
            endpoint_revision: 1,
            conversation_id: 'conv-infra-ide',
            workspace_identity: '/repo/infra',
            repository_identity: 'github.com/carllx/infra'
          }
        ],
        capabilities: ['read', 'write'],
        paused: false
      }
    });

    core3.setHumanIntervention({ active: true, reason: 'Production database schema migration requires confirmation' });
    core3.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'infra-b-cursor',
      provider: 'chatgpt',
      conversation_id: 'conv-infra-browser',
      endpoint_revision: 1
    });

    core3.recordActionFact({
      action_id: 'act-101',
      action_type: 'relay',
      target_endpoint: 'ide-deployer',
      stage: 'REQUESTED'
    });
    core3.recordActionFact({
      action_id: 'act-102',
      action_type: 'relay',
      target_endpoint: 'browser',
      stage: 'ACCEPTED_OR_DELIVERED'
    });

    serverHandle = await startStatusSurfaceServer({ registry, port: 0 });
    baseUrl = serverHandle.url;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  it('验收准则 1: 多个项目绑定能同时呈现在同一个本地状态表面中', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    assert.equal(data.projects.length, 3);
    const ids = data.projects.map(p => p.binding_id);
    assert.deepEqual(ids, ['rally-core-service', 'rally-core-service-staging', 'rally-infra-ops']);

    const htmlRes = await fetch(`${baseUrl}/`);
    const html = await htmlRes.text();
    for (const id of ids) {
      assert.equal(html.includes(id), true);
    }
  });

  it('验收准则 2 & 3: Browser=NEW + IDE-A=NEW + IDE-B=NEW Triple NEW 独立且同时可见', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    const proj1 = data.projects.find(p => p.binding_id === 'rally-core-service');

    assert.equal(proj1.browser.result_state, 'NEW');
    assert.equal(proj1.ide_endpoints.length, 2);
    assert.equal(proj1.ide_endpoints[0].result_state, 'NEW');
    assert.equal(proj1.ide_endpoints[1].result_state, 'NEW');

    // 检查 HTML 渲染：没有被压缩或吞并
    const htmlRes = await fetch(`${baseUrl}/`);
    const html = await htmlRes.text();
    assert.match(html, /cur-b-1/);
    assert.match(html, /cur-ide-1/);
    assert.match(html, /cur-ide-2/);
  });

  it('验收准则 4: 同一仓库/工作区多 IDE 端点依据稳定端点 ID 与会话绑定精确区分防串台', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    const proj1 = data.projects.find(p => p.binding_id === 'rally-core-service');

    const ep1 = proj1.ide_endpoints[0];
    const ep2 = proj1.ide_endpoints[1];

    assert.equal(ep1.workspace_identity, ep2.workspace_identity);
    assert.equal(ep1.repository_identity, ep2.repository_identity);
    assert.notEqual(ep1.endpoint_id, ep2.endpoint_id);
    assert.notEqual(ep1.conversation_id, ep2.conversation_id);
    assert.equal(proj1.disambiguation.has_shared_ide_workspace, true);
    assert.equal(proj1.disambiguation.shared_repo_with_other_projects, true);

    const htmlRes = await fetch(`${baseUrl}/`);
    const html = await htmlRes.text();
    assert.match(html, /内部共用工作区/);
    assert.match(html, /跨项目同名仓库/);
  });

  it('验收准则 5: Sibling IDE NEW + UNKNOWN 并存，UNKNOWN 绝不展示为 idle 且明确区别于 NO_NEW_RESULT', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    const proj2 = data.projects.find(p => p.binding_id === 'rally-core-service-staging');

    const workerA = proj2.ide_endpoints.find(e => e.endpoint_id === 'ide-worker-a');
    const workerB = proj2.ide_endpoints.find(e => e.endpoint_id === 'ide-worker-b');

    assert.equal(workerA.result_state, 'NEW');
    assert.equal(workerA.can_mark_handled, true);

    assert.equal(workerB.result_state, 'UNKNOWN');
    assert.equal(workerB.can_mark_handled, false);
    assert.equal(workerB.continuity.unknown_reason, 'continuity_lost');

    const htmlRes = await fetch(`${baseUrl}/`);
    const html = await htmlRes.text();
    // 验证 UNKNOWN 不含 idle
    assert.match(html, /UNKNOWN \(continuity_lost\)/);
    assert.equal(html.includes('IDLE'), false);
    assert.equal(html.includes('idle'), false);
  });

  it('验收准则 6: 相似项目 (rally-core-service 与 staging) 具备足够的 binding_id 与环境可见性', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    assert.match(html, /rally-core-service<\/h2>/);
    assert.match(html, /rally-core-service-staging<\/h2>/);
    assert.match(html, /PAUSED/); // staging 是 paused
  });

  it('验收准则 7: 活跃会话身份可见，且不推断 Browser branch mainline / owner / Baton', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    for (const p of data.projects) {
      assert.equal(typeof p.browser.conversation_id, 'string');
      // 确认字段中无 baton 或 owner
      assert.equal('baton' in p, false);
      assert.equal('owner' in p, false);
      assert.equal('whose_turn' in p, false);
      assert.equal('next_actor' in p, false);
    }
  });

  it('验收准则 8: Human Intervention 与 Action Facts 属于独立平面，不转为端点状态', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    const proj3 = data.projects.find(p => p.binding_id === 'rally-infra-ops');

    // Human Intervention 独立可见
    assert.equal(proj3.human_intervention.active, true);
    assert.match(proj3.human_intervention.reason, /Production database schema migration/);

    // 端点自身依然是规范的 NEW
    assert.equal(proj3.browser.result_state, 'NEW');

    // Action 事实细粒度 stages 独立可见，不被折叠为 generic sent
    assert.equal(proj3.actions.length, 2);
    assert.equal(proj3.actions[0].stage, 'REQUESTED');
    assert.equal(proj3.actions[1].stage, 'ACCEPTED_OR_DELIVERED');

    const htmlRes = await fetch(`${baseUrl}/`);
    const html = await htmlRes.text();
    assert.match(html, /HUMAN INTERVENTION REQUIRED/);
    assert.match(html, /REQUESTED/);
    assert.match(html, /ACCEPTED_OR_DELIVERED/);
  });

  it('验收准则 9: Exact-endpoint Mark handled 隔离性验证（精确单端推进，同级与异构端点完全不受影响）', async () => {
    // 标记 rally-core-service 的 ide-agent-primary handled
    const res = await fetch(`${baseUrl}/api/projects/rally-core-service/endpoints/ide-agent-primary/handled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_cursor: 'cur-ide-1' })
    });
    assert.equal(res.status, 200);

    const snapshot = registry.getProject('rally-core-service').getSnapshot();
    // primary 变为了 NO_NEW_RESULT
    assert.equal(snapshot.endpoints.ide_endpoints['ide-agent-primary'].result_state, 'NO_NEW_RESULT');
    // secondary 依然为 NEW
    assert.equal(snapshot.endpoints.ide_endpoints['ide-agent-secondary'].result_state, 'NEW');
    // Browser 依然为 NEW
    assert.equal(snapshot.endpoints.browser.result_state, 'NEW');
  });

  it('验收准则 10: 表现层折叠展开与筛选等操作纯客户端行为，绝不篡改 Status Core 规范事实', async () => {
    // 获取当前状态
    const beforeState = registry.getProject('rally-core-service').exportState();

    // 在模板生成的客户端脚本中，折叠与筛选仅通过 DOM classList 操作，不包含任何外部写 API
    // 验证整个表面仅暴露 POST .../handled，无任何写入折叠展开的 API
    const res = await fetch(`${baseUrl}/api/projects/rally-core-service/endpoints/ide-agent-primary/expand`, {
      method: 'POST'
    });
    assert.equal(res.status, 404);

    const afterState = registry.getProject('rally-core-service').exportState();
    assert.deepEqual(beforeState, afterState);
  });
});
