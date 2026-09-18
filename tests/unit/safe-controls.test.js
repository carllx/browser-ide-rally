import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import {
  executeSafeRebind,
  executeSafeOpenFocus,
  executeSafeSend,
  correlateAndAdvanceActionCompletion
} from '../../src/controller/safe-controls.js';

function createMockBrowserAdapter({
  matches = 1,
  failAtProbe = false,
  promptDraft = '',
  isGenerating = false,
  submitError = null,
  deliveryProven = false,
  deliveryUnknown = false
} = {}) {
  let focused = false;
  let sentTexts = [];

  return {
    locateExactConversationTab(conversationId) {
      if (matches === 0) {
        throw new Error(`TARGET_LOOKUP_FAIL: No Chrome tab found matching conversation "${conversationId}"`);
      }
      if (matches > 1) {
        throw new Error(`TARGET_LOOKUP_FAIL: Ambiguous match: ${matches} tabs match conversation "${conversationId}"`);
      }
      return { windowIndex: 1, tabIndex: 2, url: `https://chatgpt.com/c/${conversationId}` };
    },
    focusConversationTab(conversationId) {
      focused = true;
      return { focused: true, windowIndex: 1, tabIndex: 2, conversationId };
    },
    checkComposerPreflight(conversationId) {
      if (failAtProbe) {
        throw new Error('PREFLIGHT_FAIL: tab_url_mismatch_at_probe_time');
      }
      if (promptDraft) {
        throw new Error(`PREFLIGHT_FAIL: Unsent draft present in composer: "${promptDraft}"`);
      }
      if (isGenerating) {
        return { ready: false, reason: 'generation_in_progress' };
      }
      return { ready: true };
    },
    sendTextPrompt(conversationId, text) {
      if (submitError) {
        throw new Error(`SUBMIT_FAIL: ${submitError}`);
      }
      sentTexts.push(text);
      if (deliveryUnknown) {
        return { accepted: true, delivery_state: 'UNKNOWN', reason: 'Delivery unconfirmed within timeout' };
      }
      if (deliveryProven) {
        return { accepted: true, delivery_proven: true, delivery_evidence: 'Browser prompt delivery verified by provider' };
      }
      return { accepted: true };
    },
    get focused() { return focused; },
    get sentTexts() { return sentTexts; }
  };
}

function createMockIdeAdapter({
  mismatchType = null, // 'workspace' | 'repo' | 'conversation'
  dispatchError = null,
  deliveryProven = false,
  deliveryUnknown = false
} = {}) {
  let verified = false;
  let focused = false;
  let dispatchedTasks = [];

  return {
    verifyTargetIdentity({ conversationId, expectedWorkspace, expectedRepo }) {
      if (mismatchType === 'workspace') {
        throw new Error(`IDENTITY_MISMATCH: Workspace URI mismatch. Expected "${expectedWorkspace}", got "/different/ws"`);
      }
      if (mismatchType === 'repo') {
        throw new Error(`IDENTITY_MISMATCH: Repository identity mismatch. Expected "${expectedRepo}", got "other/repo"`);
      }
      if (mismatchType === 'conversation') {
        throw new Error(`IDENTITY_MISMATCH: Conversation mismatch. Expected "${conversationId}", got "different-conv"`);
      }
      verified = true;
      return { verified: true, conversationId, expectedWorkspace, expectedRepo };
    },
    focusWindow() {
      focused = true;
      return { focused: true };
    },
    dispatchControlledTask(params) {
      if (dispatchError) {
        throw new Error(`DISPATCH_FAIL: ${dispatchError}`);
      }
      dispatchedTasks.push(params);
      if (deliveryUnknown) {
        return { accepted: true, delivery_state: 'UNKNOWN', reason: 'Delivery unconfirmed within timeout' };
      }
      if (deliveryProven) {
        return { accepted: true, delivery_proven: true, delivery_evidence: 'IDE target accepted task' };
      }
      return { accepted: true };
    },
    get verified() { return verified; },
    get focused() { return focused; },
    get dispatchedTasks() { return dispatchedTasks; }
  };
}

function setupMultiProject() {
  const binding = createBinding({
    binding_id: 'proj-controls-test',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-1',
      branch: 'feat/test-controls'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-a',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-a',
        workspace_identity: '/ws/shared',
        repository_identity: 'org/shared-repo'
      },
      {
        endpoint_id: 'ide-b',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-b',
        workspace_identity: '/ws/shared',
        repository_identity: 'org/shared-repo'
      }
    ]
  });

  const registry = createProjectRegistry();
  registry.registerProject({ binding });
  return { registry, bindingId: 'proj-controls-test' };
}

test('[Safe Controls] 1. 缺失或过期的 expected_binding_revision 必须 Fail-Closed 且无任何目标副作用', () => {
  const { registry, bindingId } = setupMultiProject();
  const mockBrowser = createMockBrowserAdapter({ matches: 1 });

  // 1a. Open/Focus 缺失 expected_binding_revision
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: undefined,
      target_endpoint: 'browser',
      browserAdapter: mockBrowser
    });
  }, /STALE_OR_MISSING_BINDING_REVISION/);
  assert.equal(mockBrowser.focused, false);

  // 1b. Open/Focus 陈旧版本 (expected 0, 当前为 1)
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: 0,
      target_endpoint: 'browser',
      browserAdapter: mockBrowser
    });
  }, /STALE_OR_MISSING_BINDING_REVISION/);
  assert.equal(mockBrowser.focused, false);

  // 1c. 验证 Action 平面记录了 BLOCKED 事实，但只读项目状态完好可见
  const core = registry.getProject(bindingId);
  const snap = core.getSnapshot();
  assert.equal(snap.binding.binding_revision, 1);
  assert.ok(snap.actions.length >= 2);
  assert.equal(snap.actions[0].stage, 'BLOCKED');
  assert.equal(snap.actions[0].evidence, 'stale_or_missing_binding_revision');
  assert.equal(snap.endpoints.browser.result_state, 'UNKNOWN');
});

test('[Safe Controls] 2. Browser 标签页 0 匹配或歧义多匹配时 Fail-Closed / BLOCKED', () => {
  const { registry, bindingId } = setupMultiProject();

  // 0 匹配
  const zeroMock = createMockBrowserAdapter({ matches: 0 });
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      browserAdapter: zeroMock
    });
  }, /TARGET_LOOKUP_FAIL: No Chrome tab found/);

  // 多匹配
  const multiMock = createMockBrowserAdapter({ matches: 2 });
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      browserAdapter: multiMock
    });
  }, /TARGET_LOOKUP_FAIL: Ambiguous match: 2 tabs/);

  // 恰好 1 匹配成功
  const exactMock = createMockBrowserAdapter({ matches: 1 });
  const res = executeSafeOpenFocus({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    browserAdapter: exactMock
  });
  assert.equal(res.success, true);
  assert.equal(exactMock.focused, true);
  assert.equal(res.action.stage, 'TARGET_COMPLETED');
});

test('[Safe Controls] 3. 多 IDE 共享仓库/工作区时，精准按 endpoint_id 寻址，A 动作绝不落到 B', () => {
  const { registry, bindingId } = setupMultiProject();
  const mockIde = createMockIdeAdapter();

  // 针对 ide-a 聚焦/核验
  const resA = executeSafeOpenFocus({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'ide-a',
    ideAdapter: mockIde
  });
  assert.equal(resA.success, true);
  assert.equal(resA.action.target_endpoint, 'ide-a');
  assert.equal(resA.action.stage, 'TARGET_COMPLETED');

  // 针对不存在的泛化 'bound_ide' 或错误 id 必须拦截
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: 1,
      target_endpoint: 'bound_ide', // 禁止泛化
      ideAdapter: mockIde
    });
  }, /IDE_ENDPOINT_NOT_FOUND/);
});

test('[Safe Controls] 4. IDE 目标会话/工作区/仓库失配时严格拦截为 BLOCKED', () => {
  const { registry, bindingId } = setupMultiProject();

  // 工作区失配
  const wsMismatchIde = createMockIdeAdapter({ mismatchType: 'workspace' });
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: 1,
      target_endpoint: 'ide-a',
      ideAdapter: wsMismatchIde
    });
  }, /IDENTITY_MISMATCH: Workspace URI mismatch/);

  // 仓库失配
  const repoMismatchIde = createMockIdeAdapter({ mismatchType: 'repo' });
  assert.throws(() => {
    executeSafeOpenFocus({
      registry,
      bindingId,
      expected_binding_revision: 1,
      target_endpoint: 'ide-a',
      ideAdapter: repoMismatchIde
    });
  }, /IDENTITY_MISMATCH: Repository identity mismatch/);
});

test('[Safe Controls] 5. Safe Rebind 严格继承 #14/#21 NEW / UNKNOWN 确认守卫', () => {
  const { registry, bindingId } = setupMultiProject();
  const core = registry.getProject(bindingId);

  // 将 ide-a 推进至 unhandled NEW
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-new-1'
  });
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-a'].result_state, 'NEW');

  // 无确认重绑 ide-a -> 必须被拒绝且 Action 标记为 BLOCKED
  assert.throws(() => {
    executeSafeRebind({
      registry,
      bindingId,
      expected_binding_revision: 1,
      target_endpoint: 'ide-a',
      identity: {
        conversation_id: 'conv-ide-a-new',
        workspace_identity: '/ws/shared',
        repository_identity: 'org/shared-repo'
      }
    });
  }, /Cannot replace ide-a endpoint with unhandled NEW result without explicit confirmation/);

  // 提供显式确认 -> 重绑成功并演进至 rev 2
  const rebindRes = executeSafeRebind({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'ide-a',
    identity: {
      conversation_id: 'conv-ide-a-new',
      workspace_identity: '/ws/shared',
      repository_identity: 'org/shared-repo'
    },
    options: {
      allow_discard_unhandled: true
    }
  });
  assert.equal(rebindRes.success, true);
  assert.equal(rebindRes.snapshot.binding.binding_revision, 2);
  assert.equal(rebindRes.action.stage, 'TARGET_COMPLETED');

  // 针对泛化 'bound_ide' 重绑必须 Fail-Closed 拦截并记录 BLOCKED
  assert.throws(() => {
    executeSafeRebind({
      registry,
      bindingId,
      expected_binding_revision: 2,
      target_endpoint: 'bound_ide',
      identity: {
        conversation_id: 'conv-generic',
        workspace_identity: '/ws/shared',
        repository_identity: 'org/shared-repo'
      }
    });
  }, /SECURITY_REJECT: Generic "bound_ide" target is prohibited/);

  const blockedAction = core.getSnapshot().actions.find(a => a.reason === 'generic_bound_ide_prohibited' || a.evidence === 'generic_bound_ide_prohibited');
  assert.ok(blockedAction);
  assert.equal(blockedAction.stage, 'BLOCKED');
});

test('[Safe Controls] 6. Action 事实生命周期：REQUESTED -> SUBMITTED_LOCALLY -> ACCEPTED_OR_DELIVERED，不擅自推断后续阶段', () => {
  const { registry, bindingId } = setupMultiProject();
  const mockBrowser = createMockBrowserAdapter({ matches: 1 });

  // 6a. 仅本地提交 (默认适配器仅证明本地点击) -> 严格停留在 SUBMITTED_LOCALLY
  const sendRes = executeSafeSend({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    operation: 'rally.echo',
    payload: { text: 'Hello Browser' },
    browserAdapter: mockBrowser
  });
  assert.equal(sendRes.action.stage, 'SUBMITTED_LOCALLY');
  assert.equal(sendRes.action.evidence, 'DOM composer submit clicked');

  // 6b. 具备独立提供者投递凭据 -> 推进至 ACCEPTED_OR_DELIVERED，但绝不推断 TARGET_COMPLETED
  const provenBrowser = createMockBrowserAdapter({ matches: 1, deliveryProven: true });
  const sendDelivered = executeSafeSend({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    operation: 'rally.echo',
    payload: { text: 'Hello Browser 2' },
    browserAdapter: provenBrowser
  });
  assert.equal(sendDelivered.action.stage, 'ACCEPTED_OR_DELIVERED');
});

test('[Safe Controls] 7. UNKNOWN 投递绝不隐式重试 (No implicit retry after UNKNOWN delivery)', () => {
  const { registry, bindingId } = setupMultiProject();
  const unconfirmedBrowser = createMockBrowserAdapter({ matches: 1, deliveryUnknown: true });

  const sendRes = executeSafeSend({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    operation: 'rally.echo',
    payload: { text: 'Uncertain delivery' },
    browserAdapter: unconfirmedBrowser
  });

  assert.equal(sendRes.action.stage, 'UNKNOWN');
  assert.equal(sendRes.action.evidence, 'Delivery unconfirmed within timeout');
  // 确认仅发送了一次，未进行任何隐式静默重试
  assert.equal(unconfirmedBrowser.sentTexts.length, 1);
});

test('[Safe Controls] 8. 无关的新观察结果绝不推进 Action 为 TARGET_COMPLETED；仅可靠关联完成方可推进', () => {
  const { registry, bindingId } = setupMultiProject();
  const core = registry.getProject(bindingId);
  const provenBrowser = createMockBrowserAdapter({ matches: 1, deliveryProven: true });

  const sendRes = executeSafeSend({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'browser',
    operation: 'rally.echo',
    payload: { text: 'Correlated action test' },
    browserAdapter: provenBrowser
  });
  const actId = sendRes.action.action_id;
  const nonce = sendRes.action.nonce;
  assert.equal(sendRes.action.stage, 'ACCEPTED_OR_DELIVERED');

  // 8a. 收到无关的常规 completion 观察 (不包含匹配的 nonce)
  correlateAndAdvanceActionCompletion({
    core,
    observation: {
      conversation_id: 'conv-browser-1',
      latest_completed_cursor: 'unrelated-cursor-99'
    }
  });
  const actionAfterUnrelated = core.getSnapshot().actions.find(a => a.action_id === actId);
  assert.equal(actionAfterUnrelated.stage, 'ACCEPTED_OR_DELIVERED', '无关联证据时绝不推进为 TARGET_COMPLETED');

  // 8b. 收到携带精确 nonce 的关联完成
  correlateAndAdvanceActionCompletion({
    core,
    observation: {
      conversation_id: 'conv-browser-1',
      nonce: nonce,
      latest_completed_cursor: 'correlated-cursor-100'
    }
  });
  const actionAfterCorrelated = core.getSnapshot().actions.find(a => a.action_id === actId);
  assert.equal(actionAfterCorrelated.stage, 'TARGET_COMPLETED');
});

test('[Safe Controls] 9. 目标操作与 Action 流转绝不篡改 last_handled_cursor 或伪造 handled', () => {
  const { registry, bindingId } = setupMultiProject();
  const core = registry.getProject(bindingId);

  // 让 ide-a 处于 unhandled NEW
  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cursor-preserve-me'
  });
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-a'].last_handled_cursor, null);

  // 向 ide-a 派发动作并流转至 TARGET_COMPLETED
  const mockIde = createMockIdeAdapter({ deliveryProven: true });
  const sendRes = executeSafeSend({
    registry,
    bindingId,
    expected_binding_revision: 1,
    target_endpoint: 'ide-a',
    operation: 'rally.echo',
    payload: { text: 'Echo test' },
    ideAdapter: mockIde
  });

  correlateAndAdvanceActionCompletion({
    core,
    observation: {
      nonce: sendRes.action.nonce,
      endpoint_id: 'ide-a'
    }
  });

  const snap = core.getSnapshot();
  const action = snap.actions.find(a => a.action_id === sendRes.action.action_id);
  assert.equal(action.stage, 'TARGET_COMPLETED');

  // 核心守卫：ide-a 的 NEW 事实与 last_handled_cursor 毫发无损，绝不推进！
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, 'cursor-preserve-me');
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].last_handled_cursor, null);
});
