/**
 * 安全控制持久化回归与生产装配测试 (Safe Controls Durable Regression Tests)
 * 
 * 核心设计契约 (#18):
 * 1. 自动持久化：具备 storagePath 的 Registry 在执行安全控制时无需调用方手动 saveToFile，
 *    所有 Action 事实（包含最终的 TARGET_COMPLETED / BLOCKED 等）自动耐久落盘；
 * 2. 状态完整性：Rebind 过程绝不只落盘 SUBMITTED_LOCALLY 而丢失最终的 TARGET_COMPLETED；
 * 3. 真实副作用凭据：未实际执行聚焦或未实际派发任务绝不能冒进到后续阶段；
 * 4. 生产运行时装配缝隙：验证 buildProductionSurfaceRuntime 能够正确解析 exact endpoint 并执行受控操作。
 */

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
  executeSafeSend
} from '../../src/controller/safe-controls.js';
import { buildProductionSurfaceRuntime } from '../../scripts/start-surface.mjs';

test('[Durable Regression] 1. Registry 自动持久化 Action 事实：无手动 saveToFile 即可完整从磁盘恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-durable-auto-'));
  const storagePath = path.join(tmpDir, 'registry.json');

  try {
    const reg1 = createProjectRegistry({ storagePath });
    const b = createBinding({
      binding_id: 'proj-auto-persist',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'conv-browser-durable' },
      ide_endpoints: [
        {
          endpoint_id: 'ide-1',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-1',
          workspace_identity: '/ws/durable',
          repository_identity: 'org/durable-repo'
        }
      ]
    });
    reg1.registerProject({ binding: b });
    reg1.saveToFile(storagePath); // 初始注册保存

    const mockBrowser = {
      locateExactConversationTab: () => ({ windowIndex: 1, tabIndex: 1 }),
      focusConversationTab: () => ({ focused: true, windowIndex: 1, tabIndex: 1 }),
      checkComposerPreflight: () => ({ ready: true }),
      sendTextPrompt: () => ({ accepted: true, delivery_proven: true, delivery_evidence: 'verified' })
    };

    // 1a. 执行真实 safe open focus (无任何手动 saveToFile)
    const focusRes = executeSafeOpenFocus({
      registry: reg1,
      bindingId: 'proj-auto-persist',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      browserAdapter: mockBrowser
    });
    assert.equal(focusRes.action.stage, 'TARGET_COMPLETED');

    // 1b. 执行真实 safe send (无任何手动 saveToFile)
    const sendRes = executeSafeSend({
      registry: reg1,
      bindingId: 'proj-auto-persist',
      expected_binding_revision: 1,
      target_endpoint: 'browser',
      operation: 'rally.echo',
      payload: { text: 'Persist test' },
      browserAdapter: mockBrowser
    });
    assert.equal(sendRes.action.stage, 'ACCEPTED_OR_DELIVERED');

    // 重新从磁盘创建 registry2，不调用任何显式保存
    const reg2 = createProjectRegistry({ storagePath });
    const core2 = reg2.getProject('proj-auto-persist');
    const actions = core2.getSnapshot().actions;

    assert.equal(actions.length, 2);
    const loadedFocusAct = actions.find(a => a.action_id === focusRes.action.action_id);
    assert.ok(loadedFocusAct);
    assert.equal(loadedFocusAct.stage, 'TARGET_COMPLETED');
    assert.equal(loadedFocusAct.action_type, 'open_focus');
    assert.equal(loadedFocusAct.created_at, focusRes.action.created_at);

    const loadedSendAct = actions.find(a => a.action_id === sendRes.action.action_id);
    assert.ok(loadedSendAct);
    assert.equal(loadedSendAct.stage, 'ACCEPTED_OR_DELIVERED');
    assert.equal(loadedSendAct.nonce, sendRes.action.nonce);
    assert.equal(loadedSendAct.created_at, sendRes.action.created_at);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('[Durable Regression] 2. Rebind 序列必须落盘最终 TARGET_COMPLETED 而不是停留在 SUBMITTED_LOCALLY', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-rebind-durable-'));
  const storagePath = path.join(tmpDir, 'registry.json');

  try {
    const reg1 = createProjectRegistry({ storagePath });
    const b = createBinding({
      binding_id: 'proj-rebind-test',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'c1' },
      ide_endpoints: [{ endpoint_id: 'ide-1', endpoint_revision: 1, conversation_id: 'i1', workspace_identity: '/w', repository_identity: 'r' }]
    });
    reg1.registerProject({ binding: b });
    reg1.saveToFile(storagePath);

    // 执行 Safe Rebind (内部经历 REQUESTED -> SUBMITTED_LOCALLY -> TARGET_COMPLETED)
    const rebindRes = executeSafeRebind({
      registry: reg1,
      bindingId: 'proj-rebind-test',
      expected_binding_revision: 1,
      target_endpoint: 'ide-1',
      identity: {
        conversation_id: 'i1-new',
        workspace_identity: '/w',
        repository_identity: 'r'
      },
      options: {
        allow_discard_unhandled: true
      }
    });
    assert.equal(rebindRes.action.stage, 'TARGET_COMPLETED');

    // 重新装载并断言落盘状态绝非中间状态 SUBMITTED_LOCALLY
    const reg2 = createProjectRegistry({ storagePath });
    const loadedAct = reg2.getProject('proj-rebind-test').getSnapshot().actions.find(a => a.action_id === rebindRes.action.action_id);
    assert.ok(loadedAct);
    assert.equal(loadedAct.stage, 'TARGET_COMPLETED', 'Rebind 最终阶段必须为 TARGET_COMPLETED');
    assert.equal(reg2.getProject('proj-rebind-test').getSnapshot().binding.binding_revision, 2);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('[Production Seam] 3. 验证生产表面运行时的装配缝隙 buildProductionSurfaceRuntime', () => {
  const registry = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-prod-seam',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'c-prod' },
    ide_endpoints: [
      {
        endpoint_id: 'ide-prod-1',
        endpoint_revision: 1,
        conversation_id: 'c-ide-prod',
        workspace_identity: '/test/ws',
        repository_identity: 'github.com/org/repo'
      }
    ]
  });
  registry.registerProject({ binding });

  let executedScripts = [];
  const scriptExecutor = (script) => {
    executedScripts.push(script);
    return 'ok';
  };

  const runtime = buildProductionSurfaceRuntime({ registry, scriptExecutor });
  assert.ok(runtime.browserAdapter);
  assert.ok(runtime.ideAdapters);

  // 验证 IDE 端点解析与执行
  const ideAdapter = runtime.ideAdapters.get('ide-prod-1');
  assert.ok(ideAdapter);
  assert.equal(ideAdapter.endpointId, 'ide-prod-1');

  // focusWindow
  const focusRes = ideAdapter.focusWindow();
  assert.equal(focusRes.focused, true);
  assert.equal(focusRes.endpointId, 'ide-prod-1');

  // dispatchControlledTask
  const dispatchRes = ideAdapter.dispatchControlledTask({
    conversationId: 'c-ide-prod',
    envelope: { op: 'rally.echo', payload: { text: 'prod task' } },
    targetEndpoint: 'ide-prod-1'
  });
  assert.equal(dispatchRes.accepted, true);
  assert.equal(dispatchRes.delivery_proven, false);
});
