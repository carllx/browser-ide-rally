/**
 * Issue #20 Attention Tray 与 Human Intervention 契约验收套件
 * (Attention Tray and Human Intervention Acceptance Test Suite)
 *
 * 严格覆盖 Browser Mission Contract (Issue #20 comment 5737366873) 规定的 10 大必测场景：
 * 1. Human + dual NEW coexistence
 * 2. Human clear isolation
 * 3. Human durability
 * 4. Multi-IDE dual/multi NEW
 * 5. Attention Actions
 * 6. Target ambiguity
 * 7. Blocked rebind with unhandled NEW
 * 8. Cross-project anti-confusion
 * 9. Tray purity
 * 10. Surface/API integration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { deriveAttentionTray } from '../../src/surface/attention-tray.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { executeSafeRebind } from '../../src/controller/safe-rebind.js';

describe('Issue #20 综合契约验收套件', () => {
  let registry;
  let serverHandle;
  let baseUrl;
  let tmpStorageDir;
  let durableStoragePath;

  before(async () => {
    tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-issue-20-'));
    durableStoragePath = path.join(tmpStorageDir, 'registry.json');

    registry = createProjectRegistry({ storagePath: durableStoragePath });

    // 预备测试项目 1: 多端点协同项目 (rally-core)
    const core1 = registry.registerProject({
      binding: createBinding({
        binding_id: 'rally-core',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-core' },
        ide_endpoints: [
          {
            endpoint_id: 'ide-a',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-a',
            workspace_identity: '/ws/core',
            repository_identity: 'github.com/carllx/browser-ide-rally'
          },
          {
            endpoint_id: 'ide-b',
            endpoint_revision: 1,
            conversation_id: 'conv-ide-b',
            workspace_identity: '/ws/core',
            repository_identity: 'github.com/carllx/browser-ide-rally'
          }
        ],
        capabilities: ['read', 'write']
      })
    });

    registry.saveToFile(durableStoragePath);

    serverHandle = await startStatusSurfaceServer({ registry, port: 0, host: '127.0.0.1' });
    baseUrl = serverHandle.url;
  });

  after(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
    if (tmpStorageDir) {
      fs.rmSync(tmpStorageDir, { recursive: true, force: true });
    }
  });

  it('1. Human + dual NEW coexistence: Browser NEW + IDE-A NEW + Human Intervention 独立并存，互不掩盖', () => {
    const core = registry.getProject('rally-core');

    // 观测 Browser 为 NEW
    core.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'cur-br-10',
      provider: 'chatgpt',
      conversation_id: 'conv-br-core',
      endpoint_revision: 1
    });

    // 观测 IDE-A 为 NEW
    core.recordEndpointObservation('ide-a', {
      trusted: true,
      latest_completed_cursor: 'cur-idea-10',
      endpoint_id: 'ide-a',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-a',
      workspace_identity: '/ws/core',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });

    // 声明 Human Intervention
    core.setHumanIntervention({ active: true, reason: 'Pending security review' });

    const tray = deriveAttentionTray(registry);

    const humanItem = tray.items.find(i => i.source_kind === 'HUMAN_INTERVENTION' && i.binding_id === 'rally-core');
    const brItem = tray.items.find(i => i.source_kind === 'ENDPOINT' && i.target_endpoint === 'browser');
    const ideAItem = tray.items.find(i => i.source_kind === 'ENDPOINT' && i.target_endpoint === 'ide-a');

    assert.ok(humanItem, 'Human intervention item must exist');
    assert.equal(humanItem.reason, 'Pending security review');
    assert.ok(brItem, 'Browser NEW item must exist');
    assert.equal(brItem.cursor, 'cur-br-10');
    assert.ok(ideAItem, 'IDE-A NEW item must exist');
    assert.equal(ideAItem.cursor, 'cur-idea-10');

    // 验证底层规范事实：端点状态均完整保留，无一被冲刷掩盖
    const snap = core.getSnapshot();
    assert.equal(snap.human_intervention.active, true);
    assert.equal(snap.endpoints.browser.result_state, 'NEW');
    assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  });

  it('2. Human clear isolation: 清除 Human Intervention 时，端点状态、游标与动作事实毫发无损', () => {
    const core = registry.getProject('rally-core');

    // 记录一个已存在的 Action
    core.recordActionFact({
      action_id: 'act-sample-iso',
      action_type: 'open-focus',
      target_endpoint: 'browser',
      stage: 'TARGET_COMPLETED',
      binding_revision: 1
    });

    // 清除 Human Intervention
    core.clearHumanIntervention();

    const snap = core.getSnapshot();
    assert.equal(snap.human_intervention.active, false);
    assert.equal(snap.endpoints.browser.result_state, 'NEW');
    assert.equal(snap.endpoints.browser.latest_completed_cursor, 'cur-br-10');
    assert.equal(snap.endpoints.browser.last_handled_cursor, null);
    assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
    assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, 'cur-idea-10');
    assert.equal(snap.endpoints.ide_endpoints['ide-a'].last_handled_cursor, null);
    assert.equal(snap.actions.some(a => a.action_id === 'act-sample-iso'), true);
  });

  it('3. Human durability: 具备 storagePath 时通过生产变异缝隙 assert/clear 自动持久化，重启无损恢复', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-durable-spec-'));
    const storeFile = path.join(tmpDir, 'durable-reg.json');

    try {
      const reg1 = createProjectRegistry({ storagePath: storeFile });
      reg1.registerProject({
        binding: createBinding({
          binding_id: 'proj-dur-test',
          binding_revision: 3,
          browser: { provider: 'chatgpt', conversation_id: 'conv-dur-br' },
          ide_endpoints: [{
            endpoint_id: 'ide-1',
            endpoint_revision: 1,
            conversation_id: 'conv-dur-ide',
            workspace_identity: '/ws/dur',
            repository_identity: 'repo/dur'
          }]
        })
      });
      reg1.saveToFile(storeFile);

      // 1. Assert (无手动 saveToFile)
      reg1.setProjectHumanIntervention('proj-dur-test', {
        active: true,
        reason: 'Awaiting schema migration',
        expected_binding_revision: 3
      });

      // 2. 重启装配新的 Registry
      const reg2 = createProjectRegistry();
      reg2.loadFromFile(storeFile);
      const snap2 = reg2.getProject('proj-dur-test').getSnapshot();
      assert.equal(snap2.human_intervention.active, true);
      assert.equal(snap2.human_intervention.reason, 'Awaiting schema migration');

      // 3. Clear (无手动 saveToFile)
      reg2.clearProjectHumanIntervention('proj-dur-test', {
        expected_binding_revision: 3
      });

      // 4. 再次重启装配
      const reg3 = createProjectRegistry();
      reg3.loadFromFile(storeFile);
      const snap3 = reg3.getProject('proj-dur-test').getSnapshot();
      assert.equal(snap3.human_intervention.active, false);
      assert.equal(snap3.human_intervention.reason, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. Multi-IDE dual/multi NEW: Browser NEW + IDE-A NEW + IDE-B NEW 分别创建独立的 exact-source Tray 条目', () => {
    const core = registry.getProject('rally-core');

    // IDE-B 也观测为 NEW
    core.recordEndpointObservation('ide-b', {
      trusted: true,
      latest_completed_cursor: 'cur-ideb-10',
      endpoint_id: 'ide-b',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-b',
      workspace_identity: '/ws/core',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });

    const tray = deriveAttentionTray(registry);

    const items = tray.items.filter(i => i.binding_id === 'rally-core' && i.source_kind === 'ENDPOINT');
    assert.equal(items.length, 3, 'Triple NEW must produce 3 independent items');

    const br = items.find(i => i.target_endpoint === 'browser');
    const ideA = items.find(i => i.target_endpoint === 'ide-a');
    const ideB = items.find(i => i.target_endpoint === 'ide-b');

    assert.ok(br && br.cursor === 'cur-br-10');
    assert.ok(ideA && ideA.cursor === 'cur-idea-10');
    assert.ok(ideB && ideB.cursor === 'cur-ideb-10');
  });

  it('5. Attention Actions: 仅 BLOCKED、FAILED、UNKNOWN 产生注意力条目；正常动作不产生注意力', () => {
    const core = registry.getProject('rally-core');

    // 正常状态
    core.recordActionFact({
      action_id: 'act-normal-1',
      action_type: 'send',
      target_endpoint: 'browser',
      stage: 'SUBMITTED_LOCALLY',
      binding_revision: 1
    });

    // 异常/受阻状态
    core.recordActionFact({
      action_id: 'act-spec-blocked',
      action_type: 'open-focus',
      target_endpoint: 'ide-a',
      stage: 'BLOCKED',
      binding_revision: 1,
      evidence: 'SECURITY_REJECT: Target rejected focus'
    });

    core.recordActionFact({
      action_id: 'act-spec-failed',
      action_type: 'send',
      target_endpoint: 'ide-b',
      stage: 'FAILED',
      binding_revision: 1,
      evidence: 'IPC pipe broken'
    });

    core.recordActionFact({
      action_id: 'act-spec-unknown',
      action_type: 'send',
      target_endpoint: 'browser',
      stage: 'UNKNOWN',
      binding_revision: 1,
      evidence: 'Confirmation timeout'
    });

    const tray = deriveAttentionTray(registry);

    assert.equal(tray.items.some(i => i.action_id === 'act-normal-1'), false);

    const bItem = tray.items.find(i => i.action_id === 'act-spec-blocked');
    const fItem = tray.items.find(i => i.action_id === 'act-spec-failed');
    const uItem = tray.items.find(i => i.action_id === 'act-spec-unknown');

    assert.ok(bItem && bItem.stage === 'BLOCKED');
    assert.ok(fItem && fItem.stage === 'FAILED');
    assert.ok(uItem && uItem.stage === 'UNKNOWN');
  });

  it('6. Target ambiguity: 确定性受阻的目标歧义被分类为 TARGET_AMBIGUITY，无第二状态库', () => {
    const core = registry.getProject('rally-core');

    core.recordActionFact({
      action_id: 'act-amb-evidence',
      action_type: 'open-focus',
      target_endpoint: 'browser',
      stage: 'BLOCKED',
      binding_revision: 1,
      evidence: 'TARGET_LOOKUP_FAIL: Ambiguous match: 2 tabs match conversation "conv-br-core"'
    });

    const tray = deriveAttentionTray(registry);
    const ambItem = tray.items.find(i => i.action_id === 'act-amb-evidence');

    assert.ok(ambItem);
    assert.equal(ambItem.source_kind, 'ACTION');
    assert.equal(ambItem.attention_classification, 'TARGET_AMBIGUITY');
    assert.equal(ambItem.target_endpoint, 'browser');
  });

  it('7. Blocked rebind with unhandled NEW: Rebind 动作受阻进入 Tray，绝不擅自设置 canonical Human Intervention', () => {
    const core = registry.getProject('rally-core');

    // ide-a 当前为 NEW，尝试未确认的 rebind
    assert.throws(() => {
      executeSafeRebind({
        registry,
        projectBindingId: 'rally-core',
        targetEndpoint: 'ide-a',
        expectedBindingRevision: 1,
        newIdentity: {
          conversation_id: 'conv-new-ide-a',
          workspace_identity: '/ws/core',
          repository_identity: 'github.com/carllx/browser-ide-rally'
        }
      });
    }, /unhandled NEW/);

    const tray = deriveAttentionTray(registry);
    const blockedRebindItem = tray.items.find(i => i.action_type === 'rebind' && i.stage === 'BLOCKED');

    assert.ok(blockedRebindItem);
    assert.equal(blockedRebindItem.attention_classification, 'REBIND_BLOCKED_UNHANDLED');

    // 领域不变式守护：规范 Human Intervention 绝不被自动设置！
    const snap = core.getSnapshot();
    assert.equal(snap.human_intervention.active, false);
    assert.equal(snap.human_intervention.reason, null);
  });

  it('8. Cross-project anti-confusion: 两个相似仓库/项目产生 exact distinct binding_id 条目，互不交叉指向', () => {
    // 注册相似项目 rally-core-staging
    const core2 = registry.registerProject({
      binding: createBinding({
        binding_id: 'rally-core-staging',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'conv-br-staging' },
        ide_endpoints: [{
          endpoint_id: 'ide-staging-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-staging-1',
          workspace_identity: '/ws/staging',
          repository_identity: 'github.com/carllx/browser-ide-rally' // 同名代码仓库
        }]
      })
    });

    core2.recordEndpointObservation('ide-staging-1', {
      trusted: true,
      latest_completed_cursor: 'cur-staging-100',
      endpoint_id: 'ide-staging-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-staging-1',
      workspace_identity: '/ws/staging',
      repository_identity: 'github.com/carllx/browser-ide-rally'
    });

    const tray = deriveAttentionTray(registry);

    const stagingItems = tray.items.filter(i => i.binding_id === 'rally-core-staging');
    const prodItems = tray.items.filter(i => i.binding_id === 'rally-core');

    assert.equal(stagingItems.length, 1);
    assert.equal(stagingItems[0].target_endpoint, 'ide-staging-1');
    assert.equal(stagingItems[0].cursor, 'cur-staging-100');

    // 互不串台
    for (const item of stagingItems) {
      assert.notEqual(item.binding_id, 'rally-core');
    }
    for (const item of prodItems) {
      assert.notEqual(item.binding_id, 'rally-core-staging');
    }
  });

  it('9. Tray purity: 多次派生与读取 Attention Tray 纯函数零副作用，快照分毫不差', () => {
    const core = registry.getProject('rally-core');
    const snapBefore = JSON.stringify(core.getSnapshot());

    const t1 = deriveAttentionTray(registry);
    const t2 = deriveAttentionTray(registry);
    assert.equal(t1.total_count, t2.total_count);

    const snapAfter = JSON.stringify(core.getSnapshot());
    assert.equal(snapBefore, snapAfter);
  });

  it('10. Surface/API integration: HTTP API 暴露 attention_tray 与版本锁定的 Assert/Clear 人工介入', async () => {
    // 10a. GET /api/projects 附加 attention_tray
    const resProjects = await fetch(`${baseUrl}/api/projects`);
    assert.equal(resProjects.status, 200);
    const jsonProjects = await resProjects.json();
    assert.ok(jsonProjects.attention_tray, 'attention_tray field must be exposed');
    assert.equal(Array.isArray(jsonProjects.attention_tray.items), true);

    // 10b. GET /api/attention-tray 独立端点
    const resTray = await fetch(`${baseUrl}/api/attention-tray`);
    assert.equal(resTray.status, 200);
    const jsonTray = await resTray.json();
    assert.ok(jsonTray.attention_tray);
    assert.equal(jsonTray.attention_tray.items.length, jsonProjects.attention_tray.items.length);

    // 10c. GET / HTML 页面同时包含 Attention Tray 与项目卡片
    const resHtml = await fetch(`${baseUrl}/`);
    assert.equal(resHtml.status, 200);
    const html = await resHtml.text();
    assert.match(html, /class="attention-tray-container"/);
    assert.match(html, /Attention Tray/);
    assert.match(html, /rally-core/);
    assert.match(html, /rally-core-staging/);

    // 10d. POST assert human intervention - 成功
    const resAssert = await fetch(`${baseUrl}/api/projects/rally-core-staging/human-intervention/assert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        reason: 'Staging manual migration lock'
      })
    });
    assert.equal(resAssert.status, 200);
    const assertJson = await resAssert.json();
    assert.equal(assertJson.success, true);
    assert.equal(assertJson.human_intervention.active, true);
    assert.equal(assertJson.human_intervention.reason, 'Staging manual migration lock');

    // 10e. POST assert human intervention - 409 版本失配 fail-closed
    const resStaleAssert = await fetch(`${baseUrl}/api/projects/rally-core-staging/human-intervention/assert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 999,
        reason: 'Stale attempt'
      })
    });
    assert.equal(resStaleAssert.status, 409);
    const staleJson = await resStaleAssert.json();
    assert.equal(staleJson.stage, 'BLOCKED');

    // 10f. POST clear human intervention - 成功
    const resClear = await fetch(`${baseUrl}/api/projects/rally-core-staging/human-intervention/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1
      })
    });
    assert.equal(resClear.status, 200);
    const clearJson = await resClear.json();
    assert.equal(clearJson.success, true);
    assert.equal(clearJson.human_intervention.active, false);

    // 10g. POST clear human intervention - 409 版本失配 fail-closed
    const resStaleClear = await fetch(`${baseUrl}/api/projects/rally-core-staging/human-intervention/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 999
      })
    });
    assert.equal(resStaleClear.status, 409);
  });
});
