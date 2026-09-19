import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createObservationRuntimeCoordinator } from '../../src/runtime/observation-runtime-coordinator.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';

const AGENTAPI_BIN = '/Users/yamlam/.gemini/antigravity/bin/agentapi';

describe('Official Antigravity Stop Hook Real Integration Smoke', () => {
  it('triggers official Stop Hook on real Antigravity task completion and advances bound endpoint to NEW', async (t) => {
    if (!fs.existsSync(AGENTAPI_BIN)) {
      t.skip('agentapi binary not present in environment; skipping real agentapi smoke');
      return;
    }

    let server = null;
    let coordinator = null;
    let convId = null;
    const hookOverrideFile = path.resolve(process.cwd(), '.agents', 'hook-url');

    t.after(async () => {
      try {
        if (hookOverrideFile && fs.existsSync(hookOverrideFile)) {
          fs.unlinkSync(hookOverrideFile);
        }
      } catch (_) {}
      if (coordinator && convId) {
        try {
          coordinator.workspaceHookManager.removeWorkspaceHook(process.cwd(), convId);
        } catch (_) {}
      }
      if (server) {
        try {
          await server.close();
        } catch (_) {}
      }
    });

    const registry = createProjectRegistry();
    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-smoke',
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    coordinator = createObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500
    });

    // 使用动态端口 port: 0 启动临时隔离测试服务，防止与常规运行的 3123 端口冲突
    server = await startStatusSurfaceServer({
      registry,
      browserAdapter: mockBrowserAdapter,
      observationCoordinator: coordinator,
      port: 0
    });

    fs.mkdirSync(path.dirname(hookOverrideFile), { recursive: true });
    fs.writeFileSync(hookOverrideFile, `${server.url}/api/hooks/antigravity`, 'utf8');

    // 1. 真实派生 Antigravity 会话
    const out = execFileSync(AGENTAPI_BIN, [
      'new-conversation',
      '--model=flash_lite',
      'Initialize conversation for smoke test'
    ], { encoding: 'utf8' });

    const parsed = JSON.parse(out);
    convId = parsed?.response?.newConversation?.conversationId;
    assert.ok(convId, 'Must receive valid conversationId from agentapi');

    // 2. 将真实会话加入当前工作区 Hook 与订阅白名单
    coordinator.workspaceHookManager.ensureWorkspaceHook(process.cwd(), convId);

    // 3. 注册绑定到该真实会话的项目
    const project = registry.registerProject({
      binding: {
        binding_id: 'proj-real-smoke',
        display_name: 'Real Smoke Project',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'browser-smoke' },
        ide_endpoints: [{
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: convId,
          workspace_identity: process.cwd(),
          repository_identity: 'carllx/browser-ide-rally'
        }],
        capabilities: ['rally.echo'],
        paused: false
      }
    });

    // 4. 真实发送指令触发完成步
    execFileSync(AGENTAPI_BIN, ['send-message', convId, 'Please reply with only the word PONG'], { encoding: 'utf8' });

    // 5. 等待官方 Stop Hook 真实触发并自动推进为 NEW
    const startTime = Date.now();
    let advancedSnap = null;
    while (Date.now() - startTime < 15000) {
      const snap = project.getSnapshot();
      const ideEp = snap.endpoints.ide_endpoints['ide-primary'];
      if (ideEp?.result_state === 'NEW') {
        advancedSnap = ideEp;
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    assert.ok(advancedSnap, 'Endpoint must advance to NEW within timeout via official Stop Hook');
    assert.equal(advancedSnap.result_state, 'NEW');
    assert.ok(advancedSnap.latest_completed_cursor.startsWith('ag-step:'));
    assert.equal(advancedSnap.continuity.trusted, true);
    assert.ok(advancedSnap.latest_completed_result?.result_ref?.startsWith('res_'));
  });
});
