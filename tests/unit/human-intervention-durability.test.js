/**
 * Human Intervention 持久化、版本锁与隔离性测试 (Human Intervention Durability Tests)
 * 验证 Issue #20 与契约评论 5737366873 要求的持久化缝隙与独立性不变式
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';

test('Human Intervention — 1. StatusCore set/clear 必须触发 _onMutation 钩子', () => {
  let mutations = 0;
  const binding = createBinding({
    binding_id: 'proj-human-mut',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-1' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-1',
      workspace_identity: '/ws/1',
      repository_identity: 'repo/1'
    }]
  });

  const core = createProjectStatusCore({
    binding,
    onMutation: () => {
      mutations++;
    }
  });

  assert.equal(mutations, 0);
  core.setHumanIntervention({ active: true, reason: 'Manual review requested' });
  assert.equal(mutations, 1);
  assert.equal(core.getSnapshot().human_intervention.active, true);
  assert.equal(core.getSnapshot().human_intervention.reason, 'Manual review requested');

  core.clearHumanIntervention();
  assert.equal(mutations, 2);
  assert.equal(core.getSnapshot().human_intervention.active, false);
  assert.equal(core.getSnapshot().human_intervention.reason, null);
});

test('Human Intervention — 2. ProjectRegistry 生产变异缝隙：自动落盘与重启恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-human-durable-'));
  const storagePath = path.join(tmpDir, 'registry.json');

  try {
    const reg1 = createProjectRegistry({ storagePath });
    const binding = createBinding({
      binding_id: 'proj-human-durable',
      binding_revision: 2,
      browser: { provider: 'chatgpt', conversation_id: 'conv-br-2' },
      ide_endpoints: [{
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-2',
        workspace_identity: '/ws/2',
        repository_identity: 'repo/2'
      }]
    });

    reg1.registerProject({ binding });
    reg1.saveToFile(storagePath);

    // 生产变异缝隙：assert 人工介入 (无手动 saveToFile)
    const assertRes = reg1.setProjectHumanIntervention('proj-human-durable', {
      active: true,
      reason: 'Blocked on external API keys',
      expected_binding_revision: 2
    });
    assert.equal(assertRes.success, true);
    assert.equal(assertRes.human_intervention.active, true);

    // 重启装配新的 Registry 实例并从 storagePath 恢复
    const reg2 = createProjectRegistry();
    reg2.loadFromFile(storagePath);
    const recoveredSnapshot = reg2.getProject('proj-human-durable').getSnapshot();
    assert.equal(recoveredSnapshot.human_intervention.active, true);
    assert.equal(recoveredSnapshot.human_intervention.reason, 'Blocked on external API keys');

    // 生产变异缝隙：clear 人工介入 (无手动 saveToFile)
    const clearRes = reg2.clearProjectHumanIntervention('proj-human-durable', {
      expected_binding_revision: 2
    });
    assert.equal(clearRes.success, true);
    assert.equal(clearRes.human_intervention.active, false);

    // 再次重启并核验持久化为 inactive
    const reg3 = createProjectRegistry();
    reg3.loadFromFile(storagePath);
    const snapshot3 = reg3.getProject('proj-human-durable').getSnapshot();
    assert.equal(snapshot3.human_intervention.active, false);
    assert.equal(snapshot3.human_intervention.reason, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Human Intervention — 3. expected_binding_revision 版本锁：版本过时或失配时 fail-closed 拦截且无副作用', () => {
  const binding = createBinding({
    binding_id: 'proj-rev-lock',
    binding_revision: 5,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-rev' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-rev',
      workspace_identity: '/ws/rev',
      repository_identity: 'repo/rev'
    }]
  });

  const reg = createProjectRegistry();
  reg.registerProject({ binding });

  // 1. 缺失 expected_binding_revision
  assert.throws(() => {
    reg.setProjectHumanIntervention('proj-rev-lock', {
      active: true,
      reason: 'Test'
    });
  }, /expected_binding_revision is required/i);

  // 2. 陈旧版本 (expected 4 !== actual 5)
  assert.throws(() => {
    reg.setProjectHumanIntervention('proj-rev-lock', {
      active: true,
      reason: 'Test',
      expected_binding_revision: 4
    });
  }, /STALE_OR_MISSING_BINDING_REVISION/i);

  assert.equal(reg.getProject('proj-rev-lock').getSnapshot().human_intervention.active, false);

  // 3. Clear 同样受版本锁守卫
  assert.throws(() => {
    reg.clearProjectHumanIntervention('proj-rev-lock', {
      expected_binding_revision: 6
    });
  }, /STALE_OR_MISSING_BINDING_REVISION/i);
});

test('Human Intervention — 4. 隔离性：Assert / Clear 人工介入绝对不修改 Endpoint Result、handled cursor 或 Action facts', () => {
  const binding = createBinding({
    binding_id: 'proj-isolation',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-iso' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-iso',
      workspace_identity: '/ws/iso',
      repository_identity: 'repo/iso'
    }]
  });

  const reg = createProjectRegistry();
  const core = reg.registerProject({ binding });

  // 初始化端点为 NEW
  core.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-br-iso-1',
    provider: 'chatgpt',
    conversation_id: 'conv-br-iso',
    endpoint_revision: 1
  });
  core.recordEndpointObservation('ide-1', {
    trusted: true,
    latest_completed_cursor: 'cur-ide-iso-1',
    endpoint_id: 'ide-1',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-iso',
    workspace_identity: '/ws/iso',
    repository_identity: 'repo/iso'
  });

  // 记录一个已存在的 Action
  core.recordActionFact({
    action_id: 'act-existing-1',
    action_type: 'open-focus',
    target_endpoint: 'browser',
    stage: 'TARGET_COMPLETED',
    binding_revision: 1
  });

  const beforeSnapshot = core.getSnapshot();
  assert.equal(beforeSnapshot.endpoints.browser.result_state, 'NEW');
  assert.equal(beforeSnapshot.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.equal(beforeSnapshot.actions.length, 1);

  // 执行 Assert Human Intervention
  reg.setProjectHumanIntervention('proj-isolation', {
    active: true,
    reason: 'Manual decision needed',
    expected_binding_revision: 1
  });

  const afterAssert = core.getSnapshot();
  assert.equal(afterAssert.human_intervention.active, true);
  assert.equal(afterAssert.endpoints.browser.result_state, 'NEW');
  assert.equal(afterAssert.endpoints.browser.latest_completed_cursor, 'cur-br-iso-1');
  assert.equal(afterAssert.endpoints.browser.last_handled_cursor, null);
  assert.equal(afterAssert.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.equal(afterAssert.endpoints.ide_endpoints['ide-1'].latest_completed_cursor, 'cur-ide-iso-1');
  assert.equal(afterAssert.endpoints.ide_endpoints['ide-1'].last_handled_cursor, null);
  assert.equal(afterAssert.actions.length, 1);
  assert.equal(afterAssert.actions[0].action_id, 'act-existing-1');

  // 执行 Clear Human Intervention
  reg.clearProjectHumanIntervention('proj-isolation', {
    expected_binding_revision: 1
  });

  const afterClear = core.getSnapshot();
  assert.equal(afterClear.human_intervention.active, false);
  assert.equal(afterClear.endpoints.browser.result_state, 'NEW');
  assert.equal(afterClear.endpoints.browser.latest_completed_cursor, 'cur-br-iso-1');
  assert.equal(afterClear.endpoints.browser.last_handled_cursor, null);
  assert.equal(afterClear.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  assert.equal(afterClear.endpoints.ide_endpoints['ide-1'].latest_completed_cursor, 'cur-ide-iso-1');
  assert.equal(afterClear.endpoints.ide_endpoints['ide-1'].last_handled_cursor, null);
  assert.equal(afterClear.actions.length, 1);
  assert.equal(afterClear.actions[0].action_id, 'act-existing-1');
});
