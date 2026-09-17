/**
 * Multi-IDE Topology 验收与隔离测试套件 (#21)
 *
 * 核心验证：
 * 1. Browser NEW + IDE-A NEW + IDE-B NEW 同时并存；
 * 2. Browser NEW + IDE-A NEW + IDE-B UNKNOWN 独立并存；
 * 3. same workspace/repository + different IDE conversations 依然严格按 stable endpoint ID 隔离；
 * 4. IDE-A completion 不推进 IDE-B；
 * 5. Mark handled IDE-A 仅改变 IDE-A，IDE-B 与 Browser 毫发无损；
 * 6. 添加 IDE-B 保持 Browser 与 IDE-A 事实不变；
 * 7. 重绑 IDE-B 仅重置/reconcile IDE-B，Browser 与 IDE-A 保持不变；
 * 8. NEW / UNKNOWN 端点移除/重绑必须显式确认，且确认绝不伪装为 Mark handled；
 * 9. 过时 pre-rebind IDE-B 观察不污染 IDE-A，且被 IDE-B 拒绝；
 * 10. Sibling IDE-B 配置变更 (add/rebind/remove) 不使有效的 IDE-A adapter 观察失效；
 * 11. 重启独立恢复两个 IDE 的 handled 游标，不将 handled 回放为 NEW；
 * 12. v1 durable single-IDE storage 确定性迁移至 schema v2，非法/损坏 schema 严格 fail-closed；
 * 13. 机器快照暴露所有 IDE stable endpoint IDs，多 IDE 场景下 legacy ide 属性不可解析；
 * 14. 禁止移除到 0 个 IDE 端点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry, CURRENT_SCHEMA_VERSION, DETERMINISTIC_MIGRATED_IDE_ID } from '../../src/registry/project-registry.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';

function createTempStoragePath(prefix = 'rally-multi-ide-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir: tmpDir,
    file: path.join(tmpDir, 'registry.json'),
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

function makeMultiIdeBinding(id = 'proj-multi-001') {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-001'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-a',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-a',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'carllx/browser-ide-rally'
      },
      {
        endpoint_id: 'ide-b',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-b',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'carllx/browser-ide-rally'
      }
    ]
  });
}

test('[Multi-IDE] 1. Browser NEW + IDE-A NEW + IDE-B NEW 同时并存且不压缩', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-001',
    binding_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-b-1'
  });

  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });

  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ib-1'
  });

  const snap = core.getSnapshot();
  assert.equal(snap.endpoints.browser.result_state, 'NEW');
  assert.equal(snap.endpoints.browser.latest_completed_cursor, 'turn-b-1');

  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, 'turn-ia-1');

  assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].latest_completed_cursor, 'turn-ib-1');

  // 多 IDE 场景下，legacy endpoints.ide 必须为 null（不可模糊解析）
  assert.equal(snap.endpoints.ide, null);

  const compact = core.toCompactView();
  assert.match(compact, /Browser: NEW/);
  assert.match(compact, /ide-a:NEW/);
  assert.match(compact, /ide-b:NEW/);
  assert.doesNotMatch(compact, /Baton|owner|whose_turn/i);
});

test('[Multi-IDE] 2. Browser NEW + IDE-A NEW + IDE-B UNKNOWN 独立并存', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-001',
    binding_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-b-1'
  });

  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });

  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b',
    endpoint_revision: 1,
    continuity_lost: true,
    reason: 'transcript_drift'
  });

  const snap = core.getSnapshot();
  assert.equal(snap.endpoints.browser.result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].unknown_reason, 'transcript_drift');
});

test('[Multi-IDE] 3. same workspace/repo + different IDE conversations 严格隔离', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // 尝试将 IDE-A 的 observation 发送给 IDE-B 的 endpoint ID -> 会话不匹配 fail-closed
  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-a', // 错误的 convId
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });

  const snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide_endpoints['ide-b'].unknown_reason, /attribution_mismatch/);
});

test('[Multi-IDE] 4. IDE-A completion 不推进 IDE-B', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });

  const snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].latest_completed_cursor, null);
});

test('[Multi-IDE] 5. Mark handled IDE-A 仅修改 IDE-A，IDE-B 与 Browser 毫发无损', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-001',
    binding_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-b-1'
  });
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });
  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ib-1'
  });

  const snapBefore = core.getSnapshot();
  const browserBeforeJson = JSON.stringify(snapBefore.endpoints.browser);
  const ideBBeforeJson = JSON.stringify(snapBefore.endpoints.ide_endpoints['ide-b']);

  const res = core.markEndpointHandled('ide-a', { expected_cursor: 'turn-ia-1' });
  assert.equal(res.success, true);
  assert.equal(res.handled_cursor, 'turn-ia-1');

  const snapAfter = core.getSnapshot();
  assert.equal(snapAfter.endpoints.ide_endpoints['ide-a'].result_state, 'NO_NEW_RESULT');
  assert.equal(snapAfter.endpoints.ide_endpoints['ide-a'].last_handled_cursor, 'turn-ia-1');

  assert.equal(JSON.stringify(snapAfter.endpoints.browser), browserBeforeJson);
  assert.equal(JSON.stringify(snapAfter.endpoints.ide_endpoints['ide-b']), ideBBeforeJson);
});

test('[Multi-IDE] 6. 动态添加 IDE-C 保持 Browser 与 IDE-A/B 事实不变', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-001',
    binding_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-b-1'
  });
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });

  core.addIdeEndpoint({
    endpoint_id: 'ide-c',
    identity: {
      conversation_id: 'conv-ide-c',
      workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  const snap = core.getSnapshot();
  assert.equal(snap.binding.binding_revision, 2);
  assert.equal(snap.endpoints.browser.result_state, 'NEW');
  assert.equal(snap.endpoints.browser.latest_completed_cursor, 'turn-b-1');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, 'turn-ia-1');
  assert.equal(snap.endpoints.ide_endpoints['ide-c'].result_state, 'UNKNOWN');
});

test('[Multi-IDE] 7. 重绑 IDE-B 仅重置 IDE-B，Browser 与 IDE-A 保持不变', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });
  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ib-1'
  });
  core.markEndpointHandled('ide-b', { expected_cursor: 'turn-ib-1' });

  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-b'].result_state, 'NO_NEW_RESULT');

  // 重绑 IDE-B 到新 conversation
  core.rebindEndpoint({
    endpoint_id: 'ide-b',
    identity: {
      conversation_id: 'conv-ide-b-rebound',
      workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  const snap = core.getSnapshot();
  assert.equal(snap.binding.binding_revision, 2);
  // IDE-A 事实与 NEW 状态毫发无损
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, 'turn-ia-1');
  // IDE-B 重置为 UNKNOWN
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].unknown_reason, 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].latest_completed_cursor, null);
});

test('[Multi-IDE] 8. NEW / UNKNOWN 端点移除与重绑守卫（显式确认且不伪装 handled）', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // 1. IDE-A 为 NEW
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-unhandled'
  });

  assert.throws(() => {
    core.removeIdeEndpoint('ide-a');
  }, /Cannot remove IDE endpoint "ide-a" with unhandled NEW result without explicit confirmation/);

  assert.throws(() => {
    core.rebindEndpoint({
      endpoint_id: 'ide-a',
      identity: {
        conversation_id: 'conv-ide-a-new',
        workspace_identity: '/w',
        repository_identity: 'c/r'
      }
    });
  }, /Cannot replace ide-a endpoint with unhandled NEW result without explicit confirmation/);

  // 2. IDE-B 为初始 UNKNOWN
  assert.throws(() => {
    core.removeIdeEndpoint('ide-b');
  }, /Cannot remove IDE endpoint "ide-b" in UNKNOWN state without explicit confirmation/);

  // 显式确认移除 IDE-B
  core.removeIdeEndpoint('ide-b', { confirm_replace_unknown: true });
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-b'], undefined);

  // 显式确认重绑处于 NEW 的 IDE-A，绝不把 turn-ia-unhandled 标记为 handled
  core.rebindEndpoint({
    endpoint_id: 'ide-a',
    identity: {
      conversation_id: 'conv-ide-a-rebound',
      workspace_identity: '/w',
      repository_identity: 'c/r'
    },
    allow_discard_unhandled: true
  });
  const snapA = core.getSnapshot().endpoints.ide_endpoints['ide-a'];
  assert.equal(snapA.result_state, 'UNKNOWN');
  assert.equal(snapA.last_handled_cursor, null); // 绝不伪装 handled！
});

test('[Multi-IDE] 9. 过时 pre-rebind IDE-B 观察不污染 IDE-A，且被 IDE-B 拒绝', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // IDE-B 当前处于 endpoint_revision 1，现重绑至 endpoint_revision 2
  core.rebindEndpoint({
    endpoint_id: 'ide-b',
    identity: {
      conversation_id: 'conv-ide-b-v2',
      workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
      repository_identity: 'carllx/browser-ide-rally'
    },
    confirm_replace_unknown: true
  });

  // 旧的 IDE-B 观察尝试提交（携带旧的 endpoint_revision 1）
  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b-v2',
    endpoint_revision: 1, // 旧版本
    trusted: true,
    latest_completed_cursor: 'stale-cursor-b'
  });

  const snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide_endpoints['ide-b'].unknown_reason, /stale_endpoint_revision: expected ep_rev 2, got ep_rev 1/);
  // IDE-A 仍然完全干净
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'UNKNOWN');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, null);
});

test('[Multi-IDE] 10. Sibling IDE-B 配置变更不使有效的 IDE-A observation 失效', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // 初始 IDE-A 与 IDE-B 均处于 endpoint_revision 1, project binding_revision 1
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-1'
  });
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-a'].result_state, 'NEW');

  // 现在重绑 IDE-B，使项目 binding_revision 从 1 跃迁到 2
  core.rebindEndpoint({
    endpoint_id: 'ide-b',
    identity: {
      conversation_id: 'conv-ide-b-rebound',
      workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
      repository_identity: 'carllx/browser-ide-rally'
    },
    confirm_replace_unknown: true
  });
  assert.equal(core.getSnapshot().binding.binding_revision, 2);

  // IDE-A 适配器再次发送有效 observation（带自身有效的 endpoint_revision 1）
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-2'
  });

  const snap = core.getSnapshot();
  // 核心断言：IDE-A 绝不因为 Sibling IDE-B 的重绑而失效，成功更新并保持 NEW！
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, 'turn-ia-2');
});

test('[Multi-IDE] 11. 重启独立恢复两个 IDE 的 handled 游标，不回放为 NEW', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg1 = createProjectRegistry({ storagePath: file });
    const core1 = reg1.registerProject({ binding: makeMultiIdeBinding('proj-restart-multi') });

    core1.recordEndpointObservation('ide-a', {
      conversation_id: 'conv-ide-a',
      endpoint_revision: 1,
      trusted: true,
      latest_completed_cursor: 'turn-ia-100'
    });
    core1.markEndpointHandled('ide-a', { expected_cursor: 'turn-ia-100' });

    core1.recordEndpointObservation('ide-b', {
      conversation_id: 'conv-ide-b',
      endpoint_revision: 1,
      trusted: true,
      latest_completed_cursor: 'turn-ib-200'
    });
    core1.markEndpointHandled('ide-b', { expected_cursor: 'turn-ib-200' });

    assert.equal(core1.getSnapshot().endpoints.ide_endpoints['ide-a'].result_state, 'NO_NEW_RESULT');
    assert.equal(core1.getSnapshot().endpoints.ide_endpoints['ide-b'].result_state, 'NO_NEW_RESULT');

    reg1.saveToFile(file);

    // 重启加载
    const reg2 = createProjectRegistry({ storagePath: file });
    const core2 = reg2.getProject('proj-restart-multi');
    const snap2 = core2.getSnapshot();

    assert.equal(snap2.endpoints.ide_endpoints['ide-a'].result_state, 'NO_NEW_RESULT');
    assert.equal(snap2.endpoints.ide_endpoints['ide-a'].last_handled_cursor, 'turn-ia-100');

    assert.equal(snap2.endpoints.ide_endpoints['ide-b'].result_state, 'NO_NEW_RESULT');
    assert.equal(snap2.endpoints.ide_endpoints['ide-b'].last_handled_cursor, 'turn-ib-200');
  } finally {
    cleanup();
  }
});

test('[Multi-IDE] 12. v1 durable single-IDE storage 确定性迁移至 schema v2', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    // 构造原生的 schema_version: 1 数据
    const v1Data = {
      schema_version: 1,
      saved_at: '2026-09-15T10:00:00.000Z',
      projects: {
        'proj-v1-test': {
          binding: {
            binding_id: 'proj-v1-test',
            binding_revision: 1,
            browser: { provider: 'chatgpt', conversation_id: 'conv-b-v1' },
            ide: {
              conversation_id: 'conv-i-v1',
              workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
              repository_identity: 'carllx/browser-ide-rally'
            },
            capabilities: ['rally.echo'],
            paused: false
          },
          endpoints: {
            browser: {
              endpoint: 'browser',
              latest_completed_cursor: 'b-cursor-1',
              last_handled_cursor: 'b-cursor-1',
              continuity: { trusted: true, unknown_reason: null }
            },
            ide: {
              endpoint: 'ide',
              latest_completed_cursor: 'i-cursor-1',
              last_handled_cursor: 'i-cursor-1',
              continuity: { trusted: true, unknown_reason: null }
            }
          }
        }
      }
    };

    fs.writeFileSync(file, JSON.stringify(v1Data, null, 2), 'utf-8');

    const reg = createProjectRegistry({ storagePath: file });
    const core = reg.getProject('proj-v1-test');
    const snap = core.getSnapshot();

    // 验证确定性迁移：IDE 映射为 DETERMINISTIC_MIGRATED_IDE_ID
    assert.ok(snap.endpoints.ide_endpoints[DETERMINISTIC_MIGRATED_IDE_ID]);
    const migratedFact = snap.endpoints.ide_endpoints[DETERMINISTIC_MIGRATED_IDE_ID];
    assert.equal(migratedFact.result_state, 'NO_NEW_RESULT');
    assert.equal(migratedFact.latest_completed_cursor, 'i-cursor-1');
    assert.equal(migratedFact.last_handled_cursor, 'i-cursor-1');

    // 保存后导出一律为 CURRENT_SCHEMA_VERSION (2)
    reg.saveToFile(file);
    const reloadedRaw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(reloadedRaw.schema_version, CURRENT_SCHEMA_VERSION);
  } finally {
    cleanup();
  }
});

test('[Multi-IDE] 13. 禁止移除至 0 个 IDE 端点', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // 移除 ide-b 成功
  core.removeIdeEndpoint('ide-b', { confirm_replace_unknown: true });
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-b'], undefined);

  // 尝试移除最后的 ide-a -> 严格禁止！
  assert.throws(() => {
    core.removeIdeEndpoint('ide-a', { confirm_replace_unknown: true });
  }, /Cannot remove the last IDE endpoint; Rally project requires at least one IDE endpoint slot/);
});

test('[Multi-IDE] 14. 校验 multi-IDE 强制要求 endpoint_revision 与 exact provider identity', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // 14a. 多 IDE 下若省略 endpoint_revision，必须严格 fail-closed 拒收
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    // 故意不传 endpoint_revision，传了 binding_revision: 1
    binding_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-invalid'
  });
  let snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide_endpoints['ide-a'].unknown_reason, /missing_endpoint_revision/);

  // 14b. 若携带了不匹配的 workspace_identity，必须严格 fail-closed 拒收
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    workspace_identity: '/wrong/workspace/path',
    trusted: true,
    latest_completed_cursor: 'turn-ia-invalid-ws'
  });
  snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide_endpoints['ide-a'].unknown_reason, /workspace_mismatch/);

  // 14c. 若携带了不匹配的 repository_identity，必须严格 fail-closed 拒收
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    repository_identity: 'wrong/repo',
    trusted: true,
    latest_completed_cursor: 'turn-ia-invalid-repo'
  });
  snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide_endpoints['ide-a'].unknown_reason, /repository_mismatch/);
});
