import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

    const coordinator = createObservationRuntimeCoordinator({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500
    });

    // 在官方默认端口 3123 上启动临时核验服务
    const server = await startStatusSurfaceServer({
      registry,
      browserAdapter: mockBrowserAdapter,
      observationCoordinator: coordinator,
      port: 3123
    });

    try {
      // 1. 真实派生 Antigravity 会话
      const out = execFileSync(AGENTAPI_BIN, [
        'new-conversation',
        '--model=flash_lite',
        'Please reply with only the word PONG'
      ], { encoding: 'utf8' });

      const parsed = JSON.parse(out);
      const convId = parsed?.response?.newConversation?.conversationId;
      assert.ok(convId, 'Must receive valid conversationId from agentapi');

      // 2. 注册绑定到该真实会话的项目
      const project = registry.registerProject({
        binding: {
          binding_id: 'proj-real-smoke',
          binding_revision: 1,
          browser: { provider: 'chatgpt', conversation_id: 'browser-smoke' },
          ide_endpoints: [{
            endpoint_id: 'ide-primary',
            endpoint_revision: 1,
            conversation_id: convId,
            workspace_identity: process.cwd(),
            repository_identity: 'carllx/browser-ide-rally'
          }],
          capabilities: ['read', 'write'],
          paused: false
        }
      });

      // 3. 等待官方 Stop Hook 真实触发并自动推进为 NEW
      const startTime = Date.now();
      let advancedSnap = null;
      while (Date.now() - startTime < 30000) {
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
      assert.ok(advancedSnap.latest_completed_result?.text?.includes('PONG'));
    } finally {
      await server.close();
    }
  });
});
