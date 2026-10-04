import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry, ProjectRegistry, CURRENT_SCHEMA_VERSION } from '../../src/registry/project-registry.js';

import { createBinding } from '../../src/controller/binding.js';

function createTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-reg-removal-test-'));
  const storagePath = path.join(dir, 'registry.json');
  return {
    storagePath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  };
}

function makeSampleBinding(id, { displayName = null, browserConv = null, ideConv = null, ws = null } = {}) {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    display_name: displayName || id,
    browser: {
      provider: 'chatgpt',
      conversation_id: browserConv || `conv-browser-${id}`,
      branch: 'main'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: ideConv || `conv-ide-${id}`,
        workspace_identity: ws || `/tmp/ws-${id}`,
        repository_identity: `repo-${id}`
      }
    ]
  });
}

test('Seam 1.1: 精确 binding_id + expected_binding_revision 成功从活跃集合移出并留存规范事实', () => {
  const { storagePath, cleanup } = createTempStorage();
  try {
    const registry = createProjectRegistry({ storagePath });
    const binding = makeSampleBinding('proj-a');
    const core = registry.registerProject({ binding });

    // 录入一些真实事实：action、retired_generations、human_intervention
    core.setHumanIntervention({ active: true, reason: '需要人工排查' });
    core.recordActionFact({
      action_id: 'act-1',
      action_type: 'send',
      source_endpoint: 'ide-primary',
      target_endpoint: 'browser',
      stage: 'ACCEPTED_OR_DELIVERED'
    });

    const snapshotBefore = core.getSnapshot();
    assert.equal(registry.listProjects().length, 1);
    assert.equal(registry.hasProject('proj-a'), true);

    // 执行移出
    const removeResult = registry.removeProject('proj-a', { expected_binding_revision: 1 });
    assert.equal(removeResult.success, true);
    assert.equal(removeResult.binding_id, 'proj-a');

    // 活跃集合不再包含该项目
    assert.equal(registry.hasProject('proj-a'), false);
    assert.equal(registry.listProjects().length, 0);
    assert.throws(() => registry.getProject('proj-a'), /not found in registry/i);

    // 留存事实可查询且内容完整
    assert.equal(registry.hasRemovedProject('proj-a'), true);
    const retained = registry.getRemovedProject('proj-a');
    assert.ok(retained);
    assert.equal(retained.binding.binding_id, 'proj-a');
    assert.equal(retained.human_intervention.active, true);
    assert.equal(retained.actions.length, 1);
    assert.equal(retained.actions[0].action_id, 'act-1');
  } finally {
    cleanup();
  }
});

test('Seam 1.2: 过期或缺失 binding_revision 必须 Fail-Closed 且 Zero Mutation', () => {
  const registry = new ProjectRegistry();
  const binding = makeSampleBinding('proj-stale');
  registry.registerProject({ binding });

  // 1. 缺失 revision
  assert.throws(
    () => registry.removeProject('proj-stale', {}),
    /expected_binding_revision is required/i
  );
  assert.equal(registry.hasProject('proj-stale'), true);

  // 2. 过期 revision (期望 2，实际 1)
  assert.throws(
    () => registry.removeProject('proj-stale', { expected_binding_revision: 2 }),
    (err) => {
      assert.equal(err.code, 'STALE_OR_MISSING_BINDING_REVISION');
      return true;
    }
  );
  assert.equal(registry.hasProject('proj-stale'), true);
  assert.equal(registry.listProjects().length, 1);
  assert.equal(registry.hasRemovedProject('proj-stale'), false);
});

test('Seam 1.3: 移出不存在的项目抛出异常且 Zero Mutation', () => {
  const registry = new ProjectRegistry();
  const binding = makeSampleBinding('proj-live');
  registry.registerProject({ binding });

  assert.throws(
    () => registry.removeProject('non-existent', { expected_binding_revision: 1 }),
    /Project "non-existent" not found in registry/i
  );
  assert.equal(registry.listProjects().length, 1);
});

test('Seam 1.4: 持久化写盘失败时内存中原子回滚 (Rollback on Persistence Failure)', () => {
  const { storagePath, cleanup } = createTempStorage();
  try {
    const registry = createProjectRegistry({ storagePath });
    const binding = makeSampleBinding('proj-rollback');
    registry.registerProject({ binding });

    assert.equal(registry.hasProject('proj-rollback'), true);

    // 劫持 saveToFile 模拟 IO 写入失败
    const originalSave = registry.saveToFile.bind(registry);
    registry.saveToFile = () => {
      throw new Error('EACCES: permission denied, disk failure');
    };

    assert.throws(
      () => registry.removeProject('proj-rollback', { expected_binding_revision: 1 }),
      /permission denied, disk failure/i
    );

    // 内存必须原子回滚：项目依然在活跃项目集合中，且不在 removed 集合中
    assert.equal(registry.hasProject('proj-rollback'), true);
    assert.equal(registry.listProjects().length, 1);
    assert.equal(registry.hasRemovedProject('proj-rollback'), false);

    // 恢复 saveToFile 后能够正常持久化
    registry.saveToFile = originalSave;
  } finally {
    cleanup();
  }
});

test('Seam 1.5: 重启后已移出项目保持不在活跃集合，且留存事实完整持久化 (Durable Persistence & Restart)', () => {
  const { storagePath, cleanup } = createTempStorage();
  try {
    // 启动 1：注册并移出
    const reg1 = createProjectRegistry({ storagePath });
    const binding1 = makeSampleBinding('proj-removed', {
      displayName: '已移出项目',
      browserConv: 'conv-b-1',
      ideConv: 'conv-i-1'
    });
    const binding2 = makeSampleBinding('proj-sibling', {
      displayName: '保留兄弟项目',
      browserConv: 'conv-b-2',
      ideConv: 'conv-i-2'
    });

    reg1.registerProject({ binding: binding1 });
    reg1.registerProject({ binding: binding2 });

    reg1.removeProject('proj-removed', { expected_binding_revision: 1 });
    assert.equal(reg1.listProjects().length, 1);
    assert.equal(reg1.hasProject('proj-removed'), false);
    assert.equal(reg1.hasProject('proj-sibling'), true);

    // 启动 2：从存储重新加载
    const reg2 = createProjectRegistry({ storagePath });
    assert.equal(reg2.listProjects().length, 1);
    assert.equal(reg2.hasProject('proj-removed'), false);
    assert.equal(reg2.hasProject('proj-sibling'), true);

    // 留存事实依然存在且完整
    assert.equal(reg2.hasRemovedProject('proj-removed'), true);
    const retained = reg2.getRemovedProject('proj-removed');
    assert.equal(retained.binding.display_name, '已移出项目');
    assert.equal(retained.binding.browser.conversation_id, 'conv-b-1');

    // 兄弟项目规范事实未改变
    const siblingSnap = reg2.getProject('proj-sibling').getSnapshot();
    assert.equal(siblingSnap.binding.display_name, '保留兄弟项目');
    assert.equal(siblingSnap.binding.browser.conversation_id, 'conv-b-2');
  } finally {
    cleanup();
  }
});

test('Seam 1.6: 活跃会话唯一性校验不再受已移出项目阻塞', () => {
  const registry = new ProjectRegistry();
  const binding = makeSampleBinding('proj-old', {
    displayName: '同名项目',
    browserConv: 'reusable-browser-conv',
    ideConv: 'reusable-ide-conv'
  });
  registry.registerProject({ binding });

  // 移出原项目
  registry.removeProject('proj-old', { expected_binding_revision: 1 });

  // 新项目使用相同 displayName、browser conversation 和 ide conversation 必须成功注册，不被判定为冲突
  const newBinding = makeSampleBinding('proj-new', {
    displayName: '同名项目',
    browserConv: 'reusable-browser-conv',
    ideConv: 'reusable-ide-conv'
  });

  assert.doesNotThrow(() => {
    registry.registerProject({ binding: newBinding });
  });
  assert.equal(registry.hasProject('proj-new'), true);
});

test('Seam 1.7: 已移出的 binding_id 严禁被重新注册，防止历史留存证据被静默覆盖', () => {
  const registry = new ProjectRegistry();
  const binding = makeSampleBinding('proj-unique-id');
  registry.registerProject({ binding });

  registry.removeProject('proj-unique-id', { expected_binding_revision: 1 });
  assert.equal(registry.hasRemovedProject('proj-unique-id'), true);

  // 尝试重新注册完全相同的 binding_id => 必须拒绝，防止覆盖 retained evidence
  const duplicateBinding = makeSampleBinding('proj-unique-id', { displayName: '不同名称' });
  assert.throws(
    () => registry.registerProject({ binding: duplicateBinding }),
    /already present in retained evidence/i
  );
});

test('Seam 1.8: durable storage 中同时存在相同活跃与移出 binding_id 时 loader 必须 Fail Closed', () => {
  const { storagePath, cleanup } = createTempStorage();
  try {
    const maliciousPayload = {
      schema_version: CURRENT_SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      projects: {
        'proj-conflict': {
          binding: makeSampleBinding('proj-conflict'),
          endpoints: {},
          retired_generations: []
        }
      },
      removed_projects: {
        'proj-conflict': {
          binding: makeSampleBinding('proj-conflict'),
          endpoints: {},
          retired_generations: [],
          removed_at: new Date().toISOString()
        }
      }
    };
    fs.writeFileSync(storagePath, JSON.stringify(maliciousPayload, null, 2), 'utf8');

    const registry = new ProjectRegistry();
    assert.throws(
      () => registry.loadFromFile(storagePath),
      /collision/i
    );
  } finally {
    cleanup();
  }
});
