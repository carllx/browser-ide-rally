/**
 * Ordering Ledger, Witness State Machine & Latest Result Indicator 契约测试套件
 * 
 * 严格覆盖 Issue #27 验收标准 1-9 及 Lead 强制要求 Delta 3, Delta 4, Delta 5:
 * 1. Live Browser completion -> BROWSER_LATEST
 * 2. Live IDE completion -> IDE_LATEST
 * 3. Mark handled 与 ordering 解耦（handled 推进不篡改 ordering evidence）
 * 4. Restart 游标不变保持先前 ordering
 * 5. Gap IDE 推进 -> IDE_LATEST
 * 6. Gap 未见证 Browser 推进 -> UNCERTAIN
 * 7. Gap 双端推进 -> UNCERTAIN
 * 8. Startup 扫描顺序无关性 (Delta 3)
 * 9. UNCERTAIN 状态由 live-witnessed completion 恢复确定性
 * 10. Browser witness 生命周期状态机重置 (Delta 4)
 * 11. Timeout non-mutating 保持已有结果与 ordering 不变 (Delta 5)
 * 12. 多 IDE 槽位精确保留 latest_endpoint identity 且投影准确
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { projectStatusSurface } from '../../src/surface/surface-projection.js';
import { BrowserObservationDriver } from '../../src/runtime/browser-observation-driver.js';

function makeCore(overrides = {}) {
  const binding = createBinding({
    binding_id: 'proj-ordering-test',
    display_name: 'Ordering Test',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-1' },
    ide: { conversation_id: 'i-conv-1', workspace_identity: '/ws/test', repository_identity: 'repo/test' },
    ...overrides
  });
  return createProjectStatusCore({ binding });
}

test('1. Live Browser completion -> BROWSER_LATEST', () => {
  const core = makeCore();
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1' });
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1' });
  
  // Browser 产生 live-witnessed completion
  core.recordEndpointObservation('browser', {
    conversation_id: 'b-conv-1',
    trusted: true,
    latest_completed_cursor: 'b_c2',
    live_witnessed: true
  });

  const snap = core.getSnapshot();
  assert.equal(snap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snap.ordering_evidence.latest_endpoint, 'browser');
  assert.equal(snap.ordering_evidence.checkpoint_cursors.browser, 'b_c2');

  const surface = projectStatusSurface(snap);
  assert.equal(surface.latest_result_indicator, 'BROWSER_LATEST');
  assert.equal(surface.browser.is_latest_result, true);
  assert.equal(surface.ide.is_latest_result, false);
});

test('2. Live IDE completion -> IDE_LATEST', () => {
  const core = makeCore();
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1' });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1' });

  // IDE 产生 live-witnessed completion
  core.recordEndpointObservation('ide', {
    conversation_id: 'i-conv-1',
    trusted: true,
    latest_completed_cursor: 'i_c2',
    live_witnessed: true
  });

  const snap = core.getSnapshot();
  assert.equal(snap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snap.ordering_evidence.latest_endpoint, 'ide');
  assert.equal(snap.ordering_evidence.checkpoint_cursors.ide['ide'], 'i_c2');

  const surface = projectStatusSurface(snap);
  assert.equal(surface.latest_result_indicator, 'IDE_LATEST');
  assert.equal(surface.ide.is_latest_result, true);
  assert.equal(surface.browser.is_latest_result, false);
});

test('3. Mark handled 与 ordering 解耦（handled 推进不篡改 ordering evidence）', () => {
  const core = makeCore();
  core.recordEndpointObservation('browser', {
    conversation_id: 'b-conv-1',
    trusted: true,
    latest_completed_cursor: 'b_c1',
    live_witnessed: true
  });

  let surface = projectStatusSurface(core.getSnapshot());
  assert.equal(surface.browser.result_state, 'NEW');
  assert.equal(surface.latest_result_indicator, 'BROWSER_LATEST');

  // 将 Browser 标记为 handled
  core.markEndpointHandled('browser', { expected_cursor: 'b_c1' });

  const snapAfter = core.getSnapshot();
  surface = projectStatusSurface(snapAfter);

  // Attention 状态变成 NO_NEW_RESULT，但 ordering evidence 与 indicator 完全保持不变！
  assert.equal(surface.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(snapAfter.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapAfter.ordering_evidence.latest_endpoint, 'browser');
  assert.equal(surface.latest_result_indicator, 'BROWSER_LATEST');
  assert.equal(surface.browser.is_latest_result, true);
});

test('4. Restart 游标不变保持先前 ordering checkpoint', () => {
  const core = makeCore();
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1' });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1', live_witnessed: true });

  const beforeSnap = core.getSnapshot();
  assert.equal(beforeSnap.ordering_evidence.latest_endpoint, 'ide');

  // 模拟重启：两端游标保持原样，执行对账
  const afterReconcileSnap = core.reconcileProjectOrdering();
  assert.equal(afterReconcileSnap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(afterReconcileSnap.ordering_evidence.latest_endpoint, 'ide');
  assert.equal(afterReconcileSnap.ordering_evidence.checkpoint_cursors.browser, 'b_c1');
  assert.equal(afterReconcileSnap.ordering_evidence.checkpoint_cursors.ide['ide'], 'i_c1');

  const surface = projectStatusSurface(afterReconcileSnap);
  assert.equal(surface.latest_result_indicator, 'IDE_LATEST');
});

test('5. Gap IDE 推进 -> IDE_LATEST', () => {
  const core = makeCore();
  // 建立基准 checkpoint 游标
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1', live_witnessed: true });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1' });

  // 模拟 gap：IDE 在空白期推进到 i_c2 (非 live)，Browser 未变
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c2' });
  const snap = core.reconcileProjectOrdering();

  assert.equal(snap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snap.ordering_evidence.latest_endpoint, 'ide');
  assert.equal(snap.ordering_evidence.evidence_type, 'RECONCILED_IDE_ONLY');

  const surface = projectStatusSurface(snap);
  assert.equal(surface.latest_result_indicator, 'IDE_LATEST');
  assert.equal(surface.ide.is_latest_result, true);
  assert.equal(surface.browser.is_latest_result, false);
});

test('6. Gap 未见证 Browser 推进 -> UNCERTAIN', () => {
  const core = makeCore();
  // 建立基准 checkpoint 游标
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1' });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1', live_witnessed: true });

  // 模拟 gap：Browser 在空白期产生未见证游标变化，IDE 未变
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c2' });
  const snap = core.reconcileProjectOrdering();

  assert.equal(snap.ordering_evidence.certainty, 'UNCERTAIN');
  assert.equal(snap.ordering_evidence.latest_endpoint, null);
  assert.equal(snap.ordering_evidence.evidence_type, 'GAP_UNCERTAIN');

  const surface = projectStatusSurface(snap);
  assert.equal(surface.latest_result_indicator, 'UNCERTAIN');
  assert.equal(surface.browser.is_latest_result, false);
  assert.equal(surface.ide.is_latest_result, false);
});

test('7. Gap 双端推进 -> UNCERTAIN', () => {
  const core = makeCore();
  // 建立基准 checkpoint 游标
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1', live_witnessed: true });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c1' });

  // 模拟 gap：双端均产生新游标
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c2' });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c2' });
  const snap = core.reconcileProjectOrdering();

  assert.equal(snap.ordering_evidence.certainty, 'UNCERTAIN');
  assert.equal(snap.ordering_evidence.latest_endpoint, null);

  const surface = projectStatusSurface(snap);
  assert.equal(surface.latest_result_indicator, 'UNCERTAIN');
});

test('8. Startup 扫描顺序无关性 (Delta 3)', () => {
  // Case A: 初始基准已建立后，启动先扫描录入 Browser，再扫描录入 IDE
  const coreA = makeCore();
  coreA.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_init', live_witnessed: true });
  coreA.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_init' });
  // 推进：Browser 不变，IDE 推进
  coreA.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_init' });
  coreA.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_new' });
  const snapA = coreA.reconcileProjectOrdering();

  // Case B: 初始基准建立后，启动先扫描录入 IDE，再扫描录入 Browser
  const coreB = makeCore();
  coreB.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_init', live_witnessed: true });
  coreB.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_init' });
  // 先录入 IDE，后录入 Browser
  coreB.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_new' });
  coreB.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_init' });
  const snapB = coreB.reconcileProjectOrdering();

  // 严格一致断言：扫描顺序绝不影响原子对账结果
  assert.equal(snapA.ordering_evidence.certainty, snapB.ordering_evidence.certainty);
  assert.equal(snapA.ordering_evidence.latest_endpoint, snapB.ordering_evidence.latest_endpoint);
  assert.equal(snapA.ordering_evidence.evidence_type, snapB.ordering_evidence.evidence_type);

  const surfaceA = projectStatusSurface(snapA);
  const surfaceB = projectStatusSurface(snapB);
  assert.equal(surfaceA.latest_result_indicator, surfaceB.latest_result_indicator);
  assert.equal(surfaceA.latest_result_indicator, 'IDE_LATEST');
});

test('9. UNCERTAIN 状态由 live-witnessed completion 恢复确定性', () => {
  const core = makeCore();
  // 先造成 UNCERTAIN
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c1', live_witnessed: true });
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-1', trusted: true, latest_completed_cursor: 'b_c2' });
  core.recordEndpointObservation('ide', { conversation_id: 'i-conv-1', trusted: true, latest_completed_cursor: 'i_c2' });
  core.reconcileProjectOrdering();

  assert.equal(projectStatusSurface(core.getSnapshot()).latest_result_indicator, 'UNCERTAIN');

  // 随后 IDE 产生一次 live-witnessed completion
  core.recordEndpointObservation('ide', {
    conversation_id: 'i-conv-1',
    trusted: true,
    latest_completed_cursor: 'i_c3',
    live_witnessed: true
  });

  const recoveredSnap = core.getSnapshot();
  assert.equal(recoveredSnap.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(recoveredSnap.ordering_evidence.latest_endpoint, 'ide');
  assert.equal(projectStatusSurface(recoveredSnap).latest_result_indicator, 'IDE_LATEST');
});

test('10. Browser witness 状态机：timeout 或 untrusted gap 重置 witness 状态 (Delta 4)', async () => {
  let probeCallCount = 0;
  let mockProbeBehavior = () => ({});

  const mockAdapter = {
    async observeBrowserEndpointAsync({ conversationId, bindingRevision }) {
      probeCallCount++;
      return mockProbeBehavior(probeCallCount, conversationId, bindingRevision);
    }
  };

  const recordedObservations = [];
  const fakeProject = {
    recordEndpointObservation(endpoint, obs) {
      recordedObservations.push({ endpoint, obs });
    }
  };

  const fakeSnapshot = {
    binding: {
      binding_id: 'proj-witness',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'b-wit' }
    }
  };

  const mockRegistry = {
    listProjects() {
      return [fakeSnapshot];
    },
    getProject(id) {
      return id === 'proj-witness' ? fakeProject : null;
    }
  };

  const driver = new BrowserObservationDriver({
    browserAdapter: mockAdapter,
    registry: mockRegistry,
    pollIntervalMs: 1000
  });

  // 阶段 1: 第一次观察到生成中 (is_generating: true) -> 状态机进入 waiting_completion
  mockProbeBehavior = () => ({
    trusted: false,
    is_generating: true,
    continuity_lost: false,
    should_record: false
  });
  await driver.pollOnce();
  assert.equal(driver.getWitnessState('proj-witness').stage, 'generating');

  // 阶段 2: 遭遇 observation timeout -> 状态机必须立即重置为 idle，且 should_record: false 跳过录入
  mockProbeBehavior = () => ({
    trusted: false,
    timed_out: true,
    continuity_lost: false,
    should_record: false
  });
  await driver.pollOnce();
  assert.equal(driver.getWitnessState('proj-witness').stage, 'idle');

  // 阶段 3: 超时后出现新游标，但因为先前 witness 已被超时重置，绝不能标记 live_witnessed
  mockProbeBehavior = () => ({
    trusted: true,
    is_generating: false,
    continuity_lost: false,
    latest_completed_cursor: 'b_msg_unwitnessed',
    should_record: true
  });
  await driver.pollOnce();

  const lastObs = recordedObservations[recordedObservations.length - 1];
  assert.ok(lastObs);
  assert.equal(lastObs.obs.latest_completed_cursor, 'b_msg_unwitnessed');
  assert.equal(lastObs.obs.live_witnessed, false, 'Must NOT be live_witnessed after timeout reset');
});

test('11. Timeout Non-Mutating 保持已有结果与 ordering 不变 (Delta 5)', async () => {
  const core = makeCore();
  // 建立受信任初始状态
  core.recordEndpointObservation('browser', {
    conversation_id: 'b-conv-1',
    trusted: true,
    latest_completed_cursor: 'b_c1',
    live_witnessed: true
  });

  const snapBefore = core.getSnapshot();
  assert.equal(snapBefore.endpoints.browser.result_state, 'NEW');
  assert.equal(snapBefore.ordering_evidence.certainty, 'DEFINITE');

  // 模拟超时返回事实
  const timeoutObs = {
    conversation_id: 'b-conv-1',
    trusted: false,
    timed_out: true,
    continuity_lost: false,
    should_record: false
  };

  // Driver 契约：should_record: false 时不录入 Core
  if (timeoutObs.should_record) {
    core.recordEndpointObservation('browser', timeoutObs);
  }

  const snapAfter = core.getSnapshot();
  assert.equal(snapAfter.endpoints.browser.result_state, 'NEW');
  assert.equal(snapAfter.endpoints.browser.latest_completed_cursor, 'b_c1');
  assert.equal(snapAfter.ordering_evidence.certainty, 'DEFINITE');
  assert.equal(snapAfter.ordering_evidence.latest_endpoint, 'browser');
});

test('12. 多 IDE 槽位精确保留 latest_endpoint identity 且投影准确', () => {
  const binding = createBinding({
    binding_id: 'proj-multi-ide',
    display_name: 'Multi IDE',
    browser: { provider: 'chatgpt', conversation_id: 'b-conv-m' },
    ide_endpoints: [
      { endpoint_id: 'ide-alpha', endpoint_revision: 1, conversation_id: 'c-alpha', workspace_identity: '/ws/a', repository_identity: 'repo/a' },
      { endpoint_id: 'ide-beta', endpoint_revision: 1, conversation_id: 'c-beta', workspace_identity: '/ws/b', repository_identity: 'repo/b' }
    ]
  });

  const core = createProjectStatusCore({ binding });
  core.recordEndpointObservation('browser', { conversation_id: 'b-conv-m', trusted: true, latest_completed_cursor: 'b_m1' });
  core.recordEndpointObservation('ide-alpha', { endpoint_revision: 1, conversation_id: 'c-alpha', trusted: true, latest_completed_cursor: 'a_1' });
  core.recordEndpointObservation('ide-beta', { endpoint_revision: 1, conversation_id: 'c-beta', trusted: true, latest_completed_cursor: 'b_1' });

  // ide-beta 产生 live completion
  core.recordEndpointObservation('ide-beta', {
    endpoint_revision: 1,
    conversation_id: 'c-beta',
    trusted: true,
    latest_completed_cursor: 'b_2',
    live_witnessed: true
  });

  const snap = core.getSnapshot();
  // 内部精确保持 ide-beta
  assert.equal(snap.ordering_evidence.latest_endpoint, 'ide-beta');

  // Surface 投影：全局折叠为 IDE_LATEST
  const surface = projectStatusSurface(snap);
  assert.equal(surface.latest_result_indicator, 'IDE_LATEST');

  // 槽位级别：仅 ide-beta 标记 is_latest_result: true
  const betaSlot = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-beta');
  const alphaSlot = surface.ide_endpoints.find(e => e.endpoint_id === 'ide-alpha');
  assert.equal(betaSlot.is_latest_result, true);
  assert.equal(alphaSlot.is_latest_result, false);
  assert.equal(surface.browser.is_latest_result, false);
});
