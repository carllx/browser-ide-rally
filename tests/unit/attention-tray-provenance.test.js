/**
 * Attention Tray 机器可读溯源、UNKNOWN 摘要与确定性投影测试
 * (Attention Tray Provenance, UNKNOWN Summary, and Deterministic Projection Tests)
 *
 * 覆盖 Issue #20 审查反馈中针对 Attention Tray 的三个关键边界：
 * 1. [Blocker 2 回归] UNKNOWN 端点不生成 Tray item，但暴露 unknown_endpoint_count 与 has_unknown_endpoints；
 * 2. [Blocker 3 回归] 机器可读 source provenance 显式暴露（source_plane, source_id, source_state, source_timestamp）；
 * 3. [Blocker 4 回归] 纯投影确定性（消除 wall-clock derived_at，相同的快照二次调用 deepStrictEqual）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { deriveAttentionTray } from '../../src/surface/attention-tray.js';

test('Attention Tray Provenance — 1. [Blocker 2 回归] UNKNOWN 端点不生成 Tray item，但正确派生 unknown_endpoint_count 与 has_unknown_endpoints', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-unknown-summary',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-unk' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-unk',
      workspace_identity: '/ws/unk',
      repository_identity: 'repo/unk'
    }]
  });

  const core = reg.registerProject({ binding });
  // 端点默认未受信且为 UNKNOWN 状态
  const trayInitial = deriveAttentionTray(reg);
  assert.equal(trayInitial.total_count, 0, 'UNKNOWN 端点严禁生成 Tray item');
  assert.equal(trayInitial.items.length, 0);
  assert.equal(trayInitial.has_unknown_endpoints, true);
  assert.equal(trayInitial.unknown_endpoint_count, 2); // browser 与 ide-1 均处于 UNKNOWN

  // 推进一个端点为受信且无新结果，另一个保持 UNKNOWN
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-br-1',
    provider: 'chatgpt',
    conversation_id: 'conv-br-unk',
    endpoint_revision: 1
  });
  core.markEndpointHandled('browser', { expected_cursor: 'cur-br-1' });

  const trayPartial = deriveAttentionTray(reg);
  assert.equal(trayPartial.total_count, 0);
  assert.equal(trayPartial.has_unknown_endpoints, true);
  assert.equal(trayPartial.unknown_endpoint_count, 1); // 仅剩 ide-1 为 UNKNOWN

  // 两端均受信且无新结果
  core.recordEndpointObservation('ide-1', {
    trusted: true,
    latest_completed_cursor: 'cur-ide-1',
    endpoint_id: 'ide-1',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-unk',
    workspace_identity: '/ws/unk',
    repository_identity: 'repo/unk'
  });
  core.markEndpointHandled('ide-1', { expected_cursor: 'cur-ide-1' });

  const trayClean = deriveAttentionTray(reg);
  assert.equal(trayClean.total_count, 0);
  assert.equal(trayClean.has_unknown_endpoints, false);
  assert.equal(trayClean.unknown_endpoint_count, 0);
});

test('Attention Tray Provenance — 2. [Blocker 3 回归] 机器可读 source provenance 显式暴露：Endpoint NEW, Human Intervention, Action items', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-provenance',
    binding_revision: 2,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-prov' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-prov',
      workspace_identity: '/ws/prov',
      repository_identity: 'repo/prov'
    }]
  });

  const core = reg.registerProject({ binding });

  // 1. Endpoint NEW 事实
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-br-p1',
    completed_at: '2026-09-19T08:00:00.000Z',
    latest_completed_result: {
      result_ref: 'ref-br-artifact',
      content_snippet: 'clean output'
    },
    provider: 'chatgpt',
    conversation_id: 'conv-br-prov',
    endpoint_revision: 2
  });

  // 2. Human Intervention 事实
  core.setHumanIntervention({
    active: true,
    reason: 'Security check required'
  });

  // 3. Action 异常事实
  core.recordActionFact({
    action_id: 'act-prov-1',
    action_type: 'continue',
    target_endpoint: 'ide-1',
    stage: 'BLOCKED',
    binding_revision: 2,
    evidence: { reason: 'AMBIGUOUS_MATCHES: multiple tabs matched' },
    created_at: '2026-09-19T08:01:00.000Z',
    updated_at: '2026-09-19T08:01:05.000Z'
  });

  const tray = deriveAttentionTray(reg);
  assert.equal(tray.total_count, 3);

  // 校验 Endpoint NEW 条目
  const epItem = tray.items.find(i => i.source_kind === 'ENDPOINT');
  assert.ok(epItem);
  assert.equal(epItem.binding_id, 'proj-provenance');
  assert.equal(epItem.source_plane, 'endpoint');
  assert.equal(epItem.source_id, 'browser');
  assert.equal(epItem.source_state, 'NEW');
  assert.equal(epItem.source_timestamp, '2026-09-19T08:00:00.000Z');
  // 验证数据最小化（不包含未过滤的任意正文）
  assert.equal(epItem.content_snippet, undefined);
  assert.equal(epItem.transcript, undefined);

  // 校验 Human Intervention 条目
  const humanItem = tray.items.find(i => i.source_kind === 'HUMAN_INTERVENTION');
  assert.ok(humanItem);
  assert.equal(humanItem.binding_id, 'proj-provenance');
  assert.equal(humanItem.source_plane, 'human_intervention');
  assert.equal(humanItem.source_id, 'human_intervention');
  assert.equal(humanItem.source_state, 'ACTIVE');
  assert.equal(humanItem.reason, 'Security check required');
  assert.ok(humanItem.source_timestamp);

  // 校验 Action 条目
  const actItem = tray.items.find(i => i.source_kind === 'ACTION');
  assert.ok(actItem);
  assert.equal(actItem.binding_id, 'proj-provenance');
  assert.equal(actItem.source_plane, 'action');
  assert.equal(actItem.source_id, 'act-prov-1');
  assert.equal(actItem.source_state, 'BLOCKED');
  assert.equal(actItem.source_stage, 'BLOCKED');
  assert.equal(actItem.source_timestamp, '2026-09-19T08:01:05.000Z');
  assert.equal(actItem.action_type, 'continue');
  assert.equal(actItem.attention_classification, 'TARGET_AMBIGUITY');
});

test('Attention Tray Provenance — 3. [Blocker 4 回归] 纯投影确定性：相同规范快照调用两次产生深度相等输出 (deepStrictEqual)，无 wall-clock', () => {
  const reg = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-deterministic',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-det' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-det',
      workspace_identity: '/ws/det',
      repository_identity: 'repo/det'
    }]
  });

  const core = reg.registerProject({ binding });
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-det-1',
    completed_at: '2026-09-19T08:00:00.000Z',
    provider: 'chatgpt',
    conversation_id: 'conv-br-det',
    endpoint_revision: 1
  });
  core.setHumanIntervention({ active: true, reason: 'Deterministic review' });

  const snapshots = reg.listProjects();

  const tray1 = deriveAttentionTray(snapshots);
  const tray2 = deriveAttentionTray(snapshots);

  // 必须完全 deep-equal，无 wall-clock 漂移字段
  assert.deepStrictEqual(tray1, tray2);
  assert.equal(tray1.derived_at, undefined, 'derived_at wall-clock timestamp must not exist in pure projection');
});
