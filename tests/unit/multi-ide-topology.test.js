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

test('[Multi-IDE] 9. 过时 pre-rebind IDE-B 观察被拒绝为 NO-OP，不篡改当前 NEW/游标/连续性事实', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  // 1. IDE-B 当前处于 endpoint_revision 1，现重绑至 endpoint_revision 2
  core.rebindEndpoint({
    endpoint_id: 'ide-b',
    identity: {
      conversation_id: 'conv-ide-b-v2',
      workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
      repository_identity: 'carllx/browser-ide-rally'
    },
    confirm_replace_unknown: true
  });

  // 2. 新代际 revision-2 的 B 产生受信任的 NEW 观察并推进
  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b-v2',
    endpoint_revision: 2,
    trusted: true,
    latest_completed_cursor: 'turn-ib-rev2-new'
  });

  // 3. 完整捕获此时 canonical B fact 快照
  let snap = core.getSnapshot();
  const canonicalBBeforeStale = { ...snap.endpoints.ide_endpoints['ide-b'] };
  assert.equal(canonicalBBeforeStale.result_state, 'NEW');
  assert.equal(canonicalBBeforeStale.latest_completed_cursor, 'turn-ib-rev2-new');
  assert.equal(canonicalBBeforeStale.continuity.trusted, true);

  // 4. 旧代际 revision-1 的 stale B 观察到达（试图提交旧版本数据）
  core.recordEndpointObservation('ide-b', {
    conversation_id: 'conv-ide-b-v2',
    endpoint_revision: 1, // 确凿过时代际
    continuity_lost: true,
    reason: 'stale_pre_rebind_failure',
    latest_completed_cursor: 'stale-cursor-b-rev1'
  });

  // 5. 验证 B 在语义上保持完全不变：still NEW, same latest cursor, same handled cursor, same trusted continuity
  snap = core.getSnapshot();
  const canonicalBAfterStale = snap.endpoints.ide_endpoints['ide-b'];
  assert.equal(canonicalBAfterStale.result_state, 'NEW');
  assert.equal(canonicalBAfterStale.latest_completed_cursor, canonicalBBeforeStale.latest_completed_cursor);
  assert.equal(canonicalBAfterStale.last_handled_cursor, canonicalBBeforeStale.last_handled_cursor);
  assert.equal(canonicalBAfterStale.continuity.trusted, true);
  assert.equal(canonicalBAfterStale.continuity.unknown_reason, null);

  // 6. IDE-A 保持不变
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

