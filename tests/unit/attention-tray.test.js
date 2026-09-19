/**
 * Attention Tray 派生规范与纯度测试 (Attention Tray Derivation Tests)
 * 验证 Issue #20 与契约评论 5737366873 规定的 Attention 派生语义
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { deriveAttentionTray, deriveProjectAttentionItems } from '../../src/surface/attention-tray.js';

test('Attention Tray — 1. Dual / Multi NEW: Browser NEW + IDE-A NEW + IDE-B NEW 分别独立生成 exact-source Tray 条目', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-multi-new',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-tray' },
    ide_endpoints: [
      {
        endpoint_id: 'ide-a',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-a',
        workspace_identity: '/ws/repo',
        repository_identity: 'github.com/org/repo'
      },
      {
        endpoint_id: 'ide-b',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-b',
        workspace_identity: '/ws/repo',
        repository_identity: 'github.com/org/repo'
      }
    ]
  });

  const core = reg.registerProject({ binding });
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-br-1',
    provider: 'chatgpt',
    conversation_id: 'conv-br-tray',
    endpoint_revision: 1
  });
  core.recordEndpointObservation('ide-a', {
    trusted: true,
    latest_completed_cursor: 'cur-a-1',
    endpoint_id: 'ide-a',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-a',
    workspace_identity: '/ws/repo',
    repository_identity: 'github.com/org/repo'
  });
  core.recordEndpointObservation('ide-b', {
    trusted: true,
    latest_completed_cursor: 'cur-b-1',
    endpoint_id: 'ide-b',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-b',
    workspace_identity: '/ws/repo',
    repository_identity: 'github.com/org/repo'
  });

  const tray = deriveAttentionTray(reg);
  assert.equal(tray.total_count, 3);
  assert.equal(tray.items.length, 3);

  const brItem = tray.items.find(i => i.source_kind === 'ENDPOINT' && i.target_endpoint === 'browser');
  const ideAItem = tray.items.find(i => i.source_kind === 'ENDPOINT' && i.target_endpoint === 'ide-a');
  const ideBItem = tray.items.find(i => i.source_kind === 'ENDPOINT' && i.target_endpoint === 'ide-b');

  assert.ok(brItem, 'Browser NEW item exists');
  assert.ok(ideAItem, 'IDE-A NEW item exists');
  assert.ok(ideBItem, 'IDE-B NEW item exists');

  assert.equal(brItem.binding_id, 'proj-multi-new');
  assert.equal(brItem.cursor, 'cur-br-1');
  assert.equal(ideAItem.binding_id, 'proj-multi-new');
  assert.equal(ideAItem.cursor, 'cur-a-1');
  assert.equal(ideBItem.binding_id, 'proj-multi-new');
  assert.equal(ideBItem.cursor, 'cur-b-1');

  // 严禁 Baton / Owner / Next Actor 字段
  assert.equal(tray.baton, undefined);
  assert.equal(tray.owner, undefined);
  assert.equal(tray.next_actor, undefined);
  assert.equal(brItem.owner, undefined);
  assert.equal(brItem.baton, undefined);
});

test('Attention Tray — 2. Human + Dual NEW 共存：独立条目共存且清除 Human 绝不影响 Endpoint NEW', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-coexist',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-co' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-co',
      workspace_identity: '/ws/co',
      repository_identity: 'repo/co'
    }]
  });

  const core = reg.registerProject({ binding });
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-br-co',
    provider: 'chatgpt',
    conversation_id: 'conv-br-co',
    endpoint_revision: 1
  });
  core.recordEndpointObservation('ide-1', {
    trusted: true,
    latest_completed_cursor: 'cur-ide-co',
    endpoint_id: 'ide-1',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-co',
    workspace_identity: '/ws/co',
    repository_identity: 'repo/co'
  });

  // 激活 Human Intervention
  core.setHumanIntervention({ active: true, reason: 'Confirm database migration plan' });

  const tray = deriveAttentionTray(reg);
  assert.equal(tray.total_count, 3);

  const humanItem = tray.items.find(i => i.source_kind === 'HUMAN_INTERVENTION');
  assert.ok(humanItem);
  assert.equal(humanItem.reason, 'Confirm database migration plan');
  assert.equal(humanItem.binding_id, 'proj-coexist');

  // 清除 Human Intervention
  core.clearHumanIntervention();

  const trayAfterClear = deriveAttentionTray(reg);
  assert.equal(trayAfterClear.total_count, 2);
  assert.equal(trayAfterClear.items.some(i => i.source_kind === 'HUMAN_INTERVENTION'), false);
  // Endpoint NEW 毫发无损
  assert.equal(trayAfterClear.items.filter(i => i.source_kind === 'ENDPOINT').length, 2);
});

test('Attention Tray — 3. Action Attention：仅 BLOCKED、FAILED、UNKNOWN 动作产生注意力条目，正常动作不进入', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-actions-tray',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-act' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-act',
      workspace_identity: '/ws/act',
      repository_identity: 'repo/act'
    }]
  });

  const core = reg.registerProject({ binding });

  // 正常阶段动作：不应进入 Tray
  core.recordActionFact({
    action_id: 'act-req',
    action_type: 'open-focus',
    target_endpoint: 'browser',
    stage: 'REQUESTED',
    binding_revision: 1
  });
  core.recordActionFact({
    action_id: 'act-sub',
    action_type: 'send',
    target_endpoint: 'browser',
    stage: 'SUBMITTED_LOCALLY',
    binding_revision: 1
  });
  core.recordActionFact({
    action_id: 'act-del',
    action_type: 'send',
    target_endpoint: 'browser',
    stage: 'ACCEPTED_OR_DELIVERED',
    binding_revision: 1
  });
  core.recordActionFact({
    action_id: 'act-comp',
    action_type: 'rebind',
    target_endpoint: 'ide-1',
    stage: 'TARGET_COMPLETED',
    binding_revision: 1
  });

  const trayEmpty = deriveAttentionTray(reg);
  assert.equal(trayEmpty.total_count, 0);

  // 异常/受阻动作：产生 Action Attention
  core.recordActionFact({
    action_id: 'act-blocked',
    action_type: 'open-focus',
    target_endpoint: 'browser',
    stage: 'BLOCKED',
    binding_revision: 1,
    evidence: 'SECURITY_REJECT: Unauthorized focus request'
  });
  core.recordActionFact({
    action_id: 'act-failed',
    action_type: 'open-focus',
    target_endpoint: 'browser',
    stage: 'FAILED',
    binding_revision: 1,
    evidence: 'Process terminated abnormally'
  });
  core.recordActionFact({
    action_id: 'act-unknown',
    action_type: 'send',
    target_endpoint: 'ide-1',
    stage: 'UNKNOWN',
    binding_revision: 1,
    evidence: 'Delivery state unconfirmed within timeout'
  });

  const trayWithActions = deriveAttentionTray(reg);
  assert.equal(trayWithActions.total_count, 3);

  const blockedItem = trayWithActions.items.find(i => i.action_id === 'act-blocked');
  const failedItem = trayWithActions.items.find(i => i.action_id === 'act-failed');
  const unknownItem = trayWithActions.items.find(i => i.action_id === 'act-unknown');

  assert.ok(blockedItem);
  assert.equal(blockedItem.source_kind, 'ACTION');
  assert.equal(blockedItem.stage, 'BLOCKED');
  assert.equal(blockedItem.attention_classification, 'ACTION_BLOCKED');

  assert.ok(failedItem);
  assert.equal(failedItem.source_kind, 'ACTION');
  assert.equal(failedItem.stage, 'FAILED');
  assert.equal(failedItem.attention_classification, 'ACTION_FAILED');

  assert.ok(unknownItem);
  assert.equal(unknownItem.source_kind, 'ACTION');
  assert.equal(unknownItem.stage, 'UNKNOWN');
  assert.equal(unknownItem.attention_classification, 'ACTION_UNKNOWN');
});

test('Attention Tray — 4. Target Ambiguity：基于已有确定性证据分类为目标歧义，无第二状态库', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-ambiguity',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-amb' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-amb',
      workspace_identity: '/ws/amb',
      repository_identity: 'repo/amb'
    }]
  });

  const core = reg.registerProject({ binding });

  // 记录一个由多匹配歧义导致的 BLOCKED Action
  core.recordActionFact({
    action_id: 'act-amb-1',
    action_type: 'open-focus',
    target_endpoint: 'browser',
    stage: 'BLOCKED',
    binding_revision: 1,
    evidence: 'TARGET_LOOKUP_FAIL: Ambiguous match: 2 tabs match conversation "conv-br-amb"'
  });

  const tray = deriveAttentionTray(reg);
  assert.equal(tray.total_count, 1);
  const item = tray.items[0];

  assert.equal(item.source_kind, 'ACTION');
  assert.equal(item.attention_classification, 'TARGET_AMBIGUITY');
  assert.equal(item.action_id, 'act-amb-1');
  assert.equal(item.target_endpoint, 'browser');
});

test('Attention Tray — 5. Rebind blocked by unhandled NEW：Tray 暴露受阻 Action，绝不自动设置 canonical Human Intervention', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-rebind-blocked',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-reb' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-reb',
      workspace_identity: '/ws/reb',
      repository_identity: 'repo/reb'
    }]
  });

  const core = reg.registerProject({ binding });
  core.recordEndpointObservation('ide-1', {
    trusted: true,
    latest_completed_cursor: 'cur-reb-1',
    endpoint_id: 'ide-1',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-reb',
    workspace_identity: '/ws/reb',
    repository_identity: 'repo/reb'
  });

  // 记录受阻 Rebind Action
  core.recordActionFact({
    action_id: 'act-reb-block',
    action_type: 'rebind',
    target_endpoint: 'ide-1',
    stage: 'BLOCKED',
    binding_revision: 1,
    evidence: 'Cannot replace ide-1 endpoint with unhandled NEW result without explicit confirmation'
  });

  // 派生 Attention Tray
  const tray = deriveAttentionTray(reg);
  // 包含 1 个 IDE Endpoint NEW + 1 个 Rebind Blocked Action
  assert.equal(tray.total_count, 2);

  const rebindItem = tray.items.find(i => i.action_id === 'act-reb-block');
  assert.ok(rebindItem);
  assert.equal(rebindItem.source_kind, 'ACTION');
  assert.equal(rebindItem.attention_classification, 'REBIND_BLOCKED_UNHANDLED');

  // 严格核验：底层的 canonical Human Intervention 保持为 false，未被擅自修改！
  const snapshot = core.getSnapshot();
  assert.equal(snapshot.human_intervention.active, false);
  assert.equal(snapshot.human_intervention.reason, null);
});

test('Attention Tray — 6. Cross-project anti-confusion：两相似仓库/项目分别保留 exact distinct binding_id', () => {
  const reg = createProjectRegistry();
  const binding1 = createBinding({
    binding_id: 'repo-prod',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-prod' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-prod-ide',
      workspace_identity: '/ws/shared-repo',
      repository_identity: 'org/shared-repo'
    }]
  });
  const binding2 = createBinding({
    binding_id: 'repo-staging',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-staging' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-staging-ide',
      workspace_identity: '/ws/shared-repo-staging',
      repository_identity: 'org/shared-repo'
    }]
  });

  const core1 = reg.registerProject({ binding: binding1 });
  const core2 = reg.registerProject({ binding: binding2 });

  core1.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-prod-1',
    provider: 'chatgpt',
    conversation_id: 'conv-prod',
    endpoint_revision: 1
  });
  core2.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-staging-1',
    provider: 'chatgpt',
    conversation_id: 'conv-staging',
    endpoint_revision: 1
  });

  const tray = deriveAttentionTray(reg);
  assert.equal(tray.total_count, 2);

  const prodItem = tray.items.find(i => i.binding_id === 'repo-prod');
  const stagingItem = tray.items.find(i => i.binding_id === 'repo-staging');

  assert.ok(prodItem);
  assert.ok(stagingItem);
  assert.equal(prodItem.cursor, 'cur-prod-1');
  assert.equal(stagingItem.cursor, 'cur-staging-1');
  assert.notEqual(prodItem.item_id, stagingItem.item_id);
});

test('Attention Tray — 7. Tray purity：派生 Tray 绝不修改底层规范快照、无副作用', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-purity',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-pur' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-pur',
      workspace_identity: '/ws/pur',
      repository_identity: 'repo/pur'
    }]
  });

  const core = reg.registerProject({ binding });
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-pur-1',
    provider: 'chatgpt',
    conversation_id: 'conv-br-pur',
    endpoint_revision: 1
  });

  const snapshotBefore = JSON.stringify(core.getSnapshot());

  // 派生并多次读取
  const tray1 = deriveAttentionTray(reg);
  const tray2 = deriveAttentionTray(reg);
  assert.equal(tray1.total_count, 1);
  assert.equal(tray2.total_count, 1);

  const snapshotAfter = JSON.stringify(core.getSnapshot());
  assert.equal(snapshotBefore, snapshotAfter, 'Snapshot must not be modified by deriving Attention Tray');
});

