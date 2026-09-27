/**
 * Ordering Ledger Lifecycle & Multi-IDE Gap Reconciliation Regressions
 * 
 * 严格覆盖 Browser Lead Review Blockers 1 & 3:
 * 1. 多个 IDE 端点在 gap 中同时推进：不得伪造任意 exact latest endpoint，枚举顺序无关，槽位均不标记 is_latest_result (Blocker 1)；
 * 2. Rebind 当前为 latest 的 Browser：旧结果绝不能在新会话上保持 BROWSER_LATEST (Blocker 3)；
 * 3. Rebind/Remove 当前为 latest 的 IDE：旧的 exact latest endpoint 绝不存活 (Blocker 3)；
 * 4. Add 新的空 IDE 端点：现有有效的 latest 保持稳定，不发生错误挪动 (Blocker 3)；
 * 5. Remove/Rebind 非 latest 端点：现有有效的 latest 端点与证据保持完好 (Blocker 3)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { projectStatusSurface } from '../../src/surface/surface-projection.js';

test('Blocker 1 Regression: 多个 IDE 端点离线推进时，派生 side-level IDE_LATEST 且枚举顺序无关', () => {
  // Case A: 端点配置顺序 [ide-alpha, ide-beta]
  const bindingA = createBinding({
    binding_id: 'proj-b1-a',
    display_name: 'B1 A',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv' },
    ide_endpoints: [
      { endpoint_id: 'ide-alpha', endpoint_revision: 1, conversation_id: 'c-alpha', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-beta', endpoint_revision: 1, conversation_id: 'c-beta', workspace_identity: '/ws/b', repository_identity: 'repo/b' }
    ]
  });
  const coreA = createProjectStatusCore({ binding: bindingA });
  // 建立基准
  coreA.recordEndpointObservation('browser', { conversation_id: 'b-conv', trusted: true, latest_completed_cursor: 'b_0', live_witnessed: true });
  coreA.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_0' });
  coreA.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_0' });

  // 模拟 gap：Browser 未变，两端 IDE 均离线推进
  coreA.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_1' });
  coreA.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_1' });
  const snapA = coreA.reconcileProjectOrdering();

  // Case B: 反转端点配置顺序 [ide-beta, ide-alpha]
  const bindingB = createBinding({
    binding_id: 'proj-b1-b',
    display_name: 'B1 B',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv' },
    ide_endpoints: [
      { endpoint_id: 'ide-beta', endpoint_revision: 1, conversation_id: 'c-beta', workspace_identity: '/ws/b', repository_identity: 'repo/b' },
      { endpoint_id: 'ide-alpha', endpoint_revision: 1, conversation_id: 'c-alpha', workspace_identity: '/ws/a', repository_identity: 'repo/a' }
    ]
  });
  const coreB = createProjectStatusCore({ binding: bindingB });
  coreB.recordEndpointObservation('browser', { conversation_id: 'b-conv', trusted: true, latest_completed_cursor: 'b_0', live_witnessed: true });
  coreB.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_0' });
  coreB.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_0' });

  // 同样两端离线推进
  coreB.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_1' });
  coreB.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_1' });
  const snapB = coreB.reconcileProjectOrdering();

  // 1. 验证枚举顺序反转不改变语义
  assert.equal(snapA.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapB.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapA.ordering_evidence.latest_side, 'ide');
  assert.equal(snapB.ordering_evidence.latest_side, 'ide');
  assert.equal(snapA.ordering_evidence.latest_endpoint, null);
  assert.equal(snapB.ordering_evidence.latest_endpoint, null);
  assert.deepEqual(snapA.ordering_evidence.candidate_endpoints, ['ide-alpha', 'ide-beta']);
  assert.deepEqual(snapB.ordering_evidence.candidate_endpoints, ['ide-alpha', 'ide-beta']);

  // 2. 验证 Surface 投影：全局显示 IDE_LATEST，但槽位级别均不标记 is_latest_result: true
  const surfaceA = projectStatusSurface(snapA);
  assert.equal(surfaceA.latest_result_indicator, 'IDE_LATEST');
  for (const epSlot of surfaceA.ide_endpoints) {
    assert.equal(epSlot.is_latest_result, false, `Slot ${epSlot.endpoint_id} must not be falsely marked as exact latest`);
  }
  assert.equal(surfaceA.browser.is_latest_result, false);
});

test('Blocker 3 Regression 1: Rebind 当前为 latest 的 Browser，旧结果绝不在新会话上保持 BROWSER_LATEST', () => {
  const binding = createBinding({
    binding_id: 'proj-b3-browser-rebind',
    display_name: 'Browser Rebind Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-old' },
    ide: { conversation_id: 'i-conv', workspace_identity: '/ws/test', repository_identity: 'repo/test' }
  });
  const core = createProjectStatusCore({ binding });

  // 初始：Browser live 完成 -> BROWSER_LATEST
  core.recordEndpointObservation('browser', {
    conversation_id: 'b-conv-old',
    trusted: true,
    latest_completed_cursor: 'b_old_c1',
    live_witnessed: true
  });

  const snapBefore = core.getSnapshot();
  assert.equal(snapBefore.ordering_evidence.latest_endpoint, 'browser');
  assert.equal(projectStatusSurface(snapBefore).latest_result_indicator, 'BROWSER_LATEST');

  // 安全 Rebind Browser 至新会话 (包含 allow_discard_unhandled: true)
  const reboundSnap = core.rebindEndpoint({
    endpoint: 'browser',
    identity: { provider: 'chatgpt', conversation_id: 'b-conv-new' },
    allow_discard_unhandled: true
  });

  // 验证：新会话上绝不遗留旧会话的 BROWSER_LATEST
  // 因为此时 IDE 端也没有任何已完成结果，安全降级为 NONE
  assert.equal(reboundSnap.ordering_evidence.latest_endpoint, null);
  assert.equal(reboundSnap.ordering_evidence.certainty, 'NONE');
  assert.equal(reboundSnap.ordering_evidence.checkpoint_cursors.browser, null);
  assert.equal(projectStatusSurface(reboundSnap).latest_result_indicator, 'NONE');
  assert.equal(projectStatusSurface(reboundSnap).browser.is_latest_result, false);
});

test('Blocker 3 Regression 2: 若有其他端点完成结果，Rebind 当前 latest 端点时安全 Fail-Closed 为 UNCERTAIN', () => {
  const binding = createBinding({
    binding_id: 'proj-b3-rebind-uncertain',
    display_name: 'Rebind Uncertain Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide: { conversation_id: 'i-conv-1', workspace_identity: '/ws/test', repository_identity: 'repo/test' }
  });
  const core = createProjectStatusCore({ binding });

  // IDE 有已完成结果，Browser 后续 live 完成建立 BROWSER_LATEST
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1' });
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1', live_witnessed: true });

  assert.equal(core.getSnapshot().ordering_evidence.latest_endpoint, 'browser');

  // Rebind Browser：因为 IDE 端仍存在已完成结果 i_c1，旧 Browser latest 废弃后无法判定相对顺序 -> UNCERTAIN
  const reboundSnap = core.rebindEndpoint({
    endpoint: 'browser',
    identity: { provider: 'chatgpt', conversation_id: 'b-conv-2' },
    allow_discard_unhandled: true
  });

  assert.equal(reboundSnap.ordering_evidence.certainty, 'UNCERTAIN');
  assert.equal(reboundSnap.ordering_evidence.latest_endpoint, null);
  assert.equal(reboundSnap.ordering_evidence.checkpoint_cursors.browser, null);
  assert.equal(reboundSnap.ordering_evidence.checkpoint_cursors.ide['ide'], 'i_c1');
  assert.equal(projectStatusSurface(reboundSnap).latest_result_indicator, 'UNCERTAIN');
});

test('Blocker 3 Regression 3: Rebind/Remove 当前为 latest 的 IDE，旧的 exact latest endpoint 绝不存活', () => {
  const binding = createBinding({
    binding_id: 'proj-b3-ide-remove',
    display_name: 'IDE Remove Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide_endpoints: [
      { endpoint_id: 'ide-alpha', endpoint_revision: 1, conversation_id: 'c-alpha', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-beta', endpoint_revision: 1, conversation_id: 'c-beta', workspace_identity: '/ws/b', repository_identity: 'repo/b' }
    ]
  });
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_1' });
  core.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_beta_1' });
  core.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'b_alpha_1', live_witnessed: true });

  assert.equal(core.getSnapshot().ordering_evidence.latest_endpoint, 'ide-alpha');

  // 移除作为 latest 的 ide-alpha 端点
  const afterRemoveSnap = core.removeIdeEndpoint('ide-alpha', { allow_discard_unhandled: true });

  // 验证：ide-alpha 不再存在于 checkpoint 亦不再作为 latest，降级为 UNCERTAIN
  assert.equal(afterRemoveSnap.ordering_evidence.latest_endpoint, null);
  assert.equal(afterRemoveSnap.ordering_evidence.certainty, 'UNCERTAIN');
  assert.equal(afterRemoveSnap.ordering_evidence.checkpoint_cursors.ide['ide-alpha'], undefined);
  assert.equal(afterRemoveSnap.ordering_evidence.checkpoint_cursors.ide['ide-beta'], 'b_beta_1');
});

test('Blocker 3 Regression 4: Add 新的空 IDE 端点，现有有效 latest 保持稳定不发生错误挪动', () => {
  const binding = createBinding({
    binding_id: 'proj-b3-add-empty',
    display_name: 'Add Empty IDE Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide_endpoints: [
      { endpoint_id: 'ide-alpha', endpoint_revision: 1, conversation_id: 'c-alpha', workspace_identity: '/ws/a', repository_identity: 'repo/a' }
    ]
  });
  const core = createProjectStatusCore({ binding });

  // ide-alpha 建立 live latest
  core.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_1', live_witnessed: true });

  assert.equal(core.getSnapshot().ordering_evidence.latest_endpoint, 'ide-alpha');
  assert.equal(projectStatusSurface(core.getSnapshot()).latest_result_indicator, 'IDE_LATEST');

  // 动态增加新的空端点 ide-beta
  const afterAddSnap = core.addIdeEndpoint({
    endpoint_id: 'ide-beta',
    identity: { conversation_id: 'c-beta', workspace_identity: '/ws/b', repository_identity: 'repo/b' }
  });

  // 验证：现有 valid latest 稳定保持，不发生挪动
  assert.equal(afterAddSnap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(afterAddSnap.ordering_evidence.latest_endpoint, 'ide-alpha');
  assert.equal(afterAddSnap.ordering_evidence.checkpoint_cursors.ide['ide-beta'], null);
  assert.equal(projectStatusSurface(afterAddSnap).latest_result_indicator, 'IDE_LATEST');
});

test('Blocker 3 Regression 5: Remove/Rebind 非 latest 端点，现有有效的 latest 端点与证据保持完好', () => {
  const binding = createBinding({
    binding_id: 'proj-b3-remove-non-latest',
    display_name: 'Remove Non-Latest Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide_endpoints: [
      { endpoint_id: 'ide-alpha', endpoint_revision: 1, conversation_id: 'c-alpha', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-beta', endpoint_revision: 1, conversation_id: 'c-beta', workspace_identity: '/ws/b', repository_identity: 'repo/b' }
    ]
  });
  const core = createProjectStatusCore({ binding });

  // ide-alpha 建立 live latest
  core.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_1' });
  core.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_1', live_witnessed: true });

  assert.equal(core.getSnapshot().ordering_evidence.latest_endpoint, 'ide-alpha');

  // 移除未作为 latest 的 ide-beta 端点
  const afterRemoveSnap = core.removeIdeEndpoint('ide-beta', { allow_discard_unhandled: true });

  // 验证：ide-alpha 的 latest 证明完全完好保留
  assert.equal(afterRemoveSnap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(afterRemoveSnap.ordering_evidence.latest_endpoint, 'ide-alpha');
  assert.equal(afterRemoveSnap.ordering_evidence.checkpoint_cursors.ide['ide-beta'], undefined);
  assert.equal(projectStatusSurface(afterRemoveSnap).latest_result_indicator, 'IDE_LATEST');
});

test('Side-level IDE_LATEST Regression 1: Side-level A+B + add empty C -> 仍为 definite side-level IDE_LATEST 且 candidates 仍 A+B', () => {
  const binding = createBinding({
    binding_id: 'proj-side-add-empty',
    display_name: 'Side-Level Add Empty Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide_endpoints: [
      { endpoint_id: 'ide-a', endpoint_revision: 1, conversation_id: 'c-a', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-b', endpoint_revision: 1, conversation_id: 'c-b', workspace_identity: '/ws/b', repository_identity: 'repo/b' }
    ]
  });
  const core = createProjectStatusCore({ binding });

  // 1. 基准对齐
  core.recordEndpointObservation('browser', { endpoint_revision: 1, conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_0' });
  core.recordEndpointObservation('ide-a', { endpoint_revision: 1, conversation_id: 'c-a', trusted: true, latest_completed_cursor: 'a_0' });
  core.recordEndpointObservation('ide-b', { endpoint_revision: 1, conversation_id: 'c-b', trusted: true, latest_completed_cursor: 'b_0' });
  core.reconcileProjectOrdering();

  // 2. 离线 gap 推进：Browser 未变，ide-a 与 ide-b 同时推进
  core.recordEndpointObservation('ide-a', { endpoint_revision: 1, conversation_id: 'c-a', trusted: true, latest_completed_cursor: 'a_1' });
  core.recordEndpointObservation('ide-b', { endpoint_revision: 1, conversation_id: 'c-b', trusted: true, latest_completed_cursor: 'b_1' });
  core.reconcileProjectOrdering();

  // 验证当前状态：DEFINITE, side-level ide, latest_endpoint: null, candidate_endpoints: ['ide-a', 'ide-b']
  const snapBefore = core.getSnapshot();
  assert.equal(snapBefore.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapBefore.ordering_evidence.latest_side, 'ide');
  assert.equal(snapBefore.ordering_evidence.latest_endpoint, null);
  assert.deepEqual(snapBefore.ordering_evidence.candidate_endpoints, ['ide-a', 'ide-b']);

  // 3. 动态添加新的空 IDE 端点 ide-c
  const snapAfterAdd = core.addIdeEndpoint({
    endpoint_id: 'ide-c',
    identity: { conversation_id: 'c-c', workspace_identity: '/ws/c', repository_identity: 'repo/c' }
  });

  // 验证：仍为 definite side-level IDE_LATEST，candidates 仍保持 ['ide-a', 'ide-b']，checkpoint 包含 ide-c: null
  assert.equal(snapAfterAdd.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapAfterAdd.ordering_evidence.latest_side, 'ide');
  assert.equal(snapAfterAdd.ordering_evidence.latest_endpoint, null);
  assert.deepEqual(snapAfterAdd.ordering_evidence.candidate_endpoints, ['ide-a', 'ide-b']);
  assert.equal(snapAfterAdd.ordering_evidence.checkpoint_cursors.ide['ide-c'], null);
  assert.equal(projectStatusSurface(snapAfterAdd).latest_result_indicator, 'IDE_LATEST');
  assert.equal(projectStatusSurface(snapAfterAdd).ide_endpoints.find(e => e.endpoint_id === 'ide-c').is_latest_result, false);
});

test('Side-level IDE_LATEST Regression 2: Side-level A+B + remove/rebind non-candidate C -> 仍保持 definite side-level IDE_LATEST', () => {
  const binding = createBinding({
    binding_id: 'proj-side-remove-non-cand',
    display_name: 'Side-Level Remove Non-Candidate Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide_endpoints: [
      { endpoint_id: 'ide-a', endpoint_revision: 1, conversation_id: 'c-a', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-b', endpoint_revision: 1, conversation_id: 'c-b', workspace_identity: '/ws/b', repository_identity: 'repo/b' },
      { endpoint_id: 'ide-c', endpoint_revision: 1, conversation_id: 'c-c', workspace_identity: '/ws/c', repository_identity: 'repo/c' }
    ]
  });
  const core = createProjectStatusCore({ binding });

  // 1. 基准对齐
  core.recordEndpointObservation('browser', { endpoint_revision: 1, conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_0' });
  core.recordEndpointObservation('ide-a', { endpoint_revision: 1, conversation_id: 'c-a', trusted: true, latest_completed_cursor: 'a_0' });
  core.recordEndpointObservation('ide-b', { endpoint_revision: 1, conversation_id: 'c-b', trusted: true, latest_completed_cursor: 'b_0' });
  core.recordEndpointObservation('ide-c', { endpoint_revision: 1, conversation_id: 'c-c', trusted: true, latest_completed_cursor: 'c_0' });
  core.reconcileProjectOrdering();

  // 2. 离线 gap 推进：仅 ide-a 和 ide-b 推进，ide-c 与 browser 未变
  core.recordEndpointObservation('ide-a', { endpoint_revision: 1, conversation_id: 'c-a', trusted: true, latest_completed_cursor: 'a_1' });
  core.recordEndpointObservation('ide-b', { endpoint_revision: 1, conversation_id: 'c-b', trusted: true, latest_completed_cursor: 'b_1' });
  core.reconcileProjectOrdering();

  // 验证当前状态：candidates 为 ['ide-a', 'ide-b']，不含 ide-c
  const snapBefore = core.getSnapshot();
  assert.equal(snapBefore.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapBefore.ordering_evidence.latest_side, 'ide');
  assert.deepEqual(snapBefore.ordering_evidence.candidate_endpoints, ['ide-a', 'ide-b']);

  // 3. 移除未在 candidate 集合中的端点 ide-c
  const snapAfterRemove = core.removeIdeEndpoint('ide-c', { allow_discard_unhandled: true });

  // 验证：先前的 side-level IDE_LATEST 完好保持，candidates 仍为 ['ide-a', 'ide-b']，checkpoint 已剔除 ide-c
  assert.equal(snapAfterRemove.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapAfterRemove.ordering_evidence.latest_side, 'ide');
  assert.equal(snapAfterRemove.ordering_evidence.latest_endpoint, null);
  assert.deepEqual(snapAfterRemove.ordering_evidence.candidate_endpoints, ['ide-a', 'ide-b']);
  assert.equal(snapAfterRemove.ordering_evidence.checkpoint_cursors.ide['ide-c'], undefined);
  assert.equal(projectStatusSurface(snapAfterRemove).latest_result_indicator, 'IDE_LATEST');
});

test('Side-level IDE_LATEST Regression 3: Side-level A+B + remove/rebind candidate -> 不残留 stale candidate，并安全裁决', () => {
  const binding = createBinding({
    binding_id: 'proj-side-remove-cand',
    display_name: 'Side-Level Remove Candidate Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide_endpoints: [
      { endpoint_id: 'ide-a', endpoint_revision: 1, conversation_id: 'c-a', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-b', endpoint_revision: 1, conversation_id: 'c-b', workspace_identity: '/ws/b', repository_identity: 'repo/b' },
      { endpoint_id: 'ide-other', endpoint_revision: 1, conversation_id: 'c-other', workspace_identity: '/ws/other', repository_identity: 'repo/other' }
    ]
  });
  const core = createProjectStatusCore({ binding });

  // 1. 基准对齐并离线推进 A+B (ide-other 未变)
  core.recordEndpointObservation('browser', { endpoint_revision: 1, conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_0' });
  core.recordEndpointObservation('ide-a', { endpoint_revision: 1, conversation_id: 'c-a', trusted: true, latest_completed_cursor: 'a_0' });
  core.recordEndpointObservation('ide-b', { endpoint_revision: 1, conversation_id: 'c-b', trusted: true, latest_completed_cursor: 'b_0' });
  core.recordEndpointObservation('ide-other', { endpoint_revision: 1, conversation_id: 'c-other', trusted: true, latest_completed_cursor: 'other_0' });
  core.reconcileProjectOrdering();

  core.recordEndpointObservation('ide-a', { endpoint_revision: 1, conversation_id: 'c-a', trusted: true, latest_completed_cursor: 'a_1' });
  core.recordEndpointObservation('ide-b', { endpoint_revision: 1, conversation_id: 'c-b', trusted: true, latest_completed_cursor: 'b_1' });
  core.reconcileProjectOrdering();

  assert.deepEqual(core.getSnapshot().ordering_evidence.candidate_endpoints, ['ide-a', 'ide-b']);

  // 2. 移除真正的 candidate ide-a
  const snapAfterRemoveA = core.removeIdeEndpoint('ide-a', { allow_discard_unhandled: true });

  // 验证：绝不残留 stale candidate 'ide-a'，缩减为 ['ide-b']，checkpoint 剔除 ide-a
  assert.equal(snapAfterRemoveA.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapAfterRemoveA.ordering_evidence.latest_side, 'ide');
  assert.equal(snapAfterRemoveA.ordering_evidence.latest_endpoint, null);
  assert.deepEqual(snapAfterRemoveA.ordering_evidence.candidate_endpoints, ['ide-b']);
  assert.equal(snapAfterRemoveA.ordering_evidence.checkpoint_cursors.ide['ide-a'], undefined);
  assert.ok(!snapAfterRemoveA.ordering_evidence.candidate_endpoints.includes('ide-a'));

  // 3. 继续移除剩余的最后一个 candidate ide-b (此时还有 ide-other，合法满足至少保留一个端点约束)
  const snapAfterRemoveB = core.removeIdeEndpoint('ide-b', { allow_discard_unhandled: true });

  // 验证：所有 candidate 均已失效，证据安全 Fail-Closed，绝无陈旧 candidate 残留
  assert.ok(snapAfterRemoveB.ordering_evidence.certainty === 'UNCERTAIN' || snapAfterRemoveB.ordering_evidence.certainty === 'NONE');
  assert.deepEqual(snapAfterRemoveB.ordering_evidence.candidate_endpoints, []);
  assert.equal(snapAfterRemoveB.ordering_evidence.latest_endpoint, null);
  assert.equal(snapAfterRemoveB.ordering_evidence.latest_side, null);
});
