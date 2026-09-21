/**
 * Bounded Real Rally + PBR Ordering Isolation & Restart Smoke Test
 * 
 * 严格覆盖 Issue #27 Browser Lead Review 要求:
 * 1. Rally + PBR 隔离：至少两个真实项目/工作区，端点与 Hook 白名单完全隔离，互不干扰；
 * 2. 真实 Live Completion：通过真实 HTTP Hook 载荷与实际 transcript 推进 Rally 端点，建立 DEFINITE IDE_LATEST 证明；
 * 3. Durable Restart & Reconciliation：验证关闭后从磁盘存储重新加载，经由原子裁决正确保持确定性证据，绝无 replay 与状态漂移；
 * 4. PBR 端点保持纯净隔离，无跨项目污染。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createObservationRuntimeCoordinator } from '../../src/runtime/observation-runtime-coordinator.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { projectRegistrySurface } from '../../src/surface/surface-projection.js';

describe('Rally + PBR Ordering Isolation & Restart Smoke', () => {
  it('preserves isolation between Rally & PBR, establishes DEFINITE IDE_LATEST on completion, and recovers cleanly on restart', async (t) => {
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-pbr-smoke-'));
    const storagePath = path.join(tempBase, 'registry-store.json');
    const rallyWorkspaceDir = path.join(tempBase, 'rally-workspace');
    const pbrWorkspaceDir = path.join(tempBase, 'pbr-workspace');
    fs.mkdirSync(rallyWorkspaceDir, { recursive: true });
    fs.mkdirSync(pbrWorkspaceDir, { recursive: true });

    // 初始化 Git 仓库以满足端点适配器的真实 Provenance / Repository 校验契约
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-b', 'main'], { cwd: rallyWorkspaceDir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/carllx/browser-ide-rally.git'], { cwd: rallyWorkspaceDir });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pbrWorkspaceDir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/pbr-repo.git'], { cwd: pbrWorkspaceDir });

    let server1 = null;
    let coordinator1 = null;
    let server2 = null;
    let coordinator2 = null;

    t.after(async () => {
      if (coordinator1) {
        try { coordinator1.stop(); } catch (_) {}
      }
      if (coordinator2) {
        try { coordinator2.stop(); } catch (_) {}
      }
      if (server1) {
        try { await server1.close(); } catch (_) {}
      }
      if (server2) {
        try { await server2.close(); } catch (_) {}
      }
      try {
        fs.rmSync(tempBase, { recursive: true, force: true });
      } catch (_) {}
    });

    const rallyConvId = 'ag-conv-rally-smoke';
    const pbrConvId = 'ag-conv-pbr-smoke';

    // 1. 初始化 Session 1: 注册 Rally 与 PBR 双项目
    const registry1 = createProjectRegistry({ storagePath });
    const mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'mock-browser',
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    coordinator1 = createObservationRuntimeCoordinator({
      registry: registry1,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500
    });

    // 注册 Rally 项目
    const rallyCore1 = registry1.registerProject({
      binding: {
        binding_id: 'proj-rally',
        display_name: 'Rally Smoke Project',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'browser-rally' },
        ide_endpoints: [{
          endpoint_id: 'ide-rally',
          endpoint_revision: 1,
          conversation_id: rallyConvId,
          workspace_identity: rallyWorkspaceDir,
          repository_identity: 'carllx/browser-ide-rally'
        }],
        capabilities: ['rally.echo'],
        paused: false
      }
    });

    // 注册 PBR 隔离项目
    const pbrCore1 = registry1.registerProject({
      binding: {
        binding_id: 'proj-pbr',
        display_name: 'PBR Smoke Project',
        binding_revision: 1,
        browser: { provider: 'chatgpt', conversation_id: 'browser-pbr' },
        ide_endpoints: [{
          endpoint_id: 'ide-pbr',
          endpoint_revision: 1,
          conversation_id: pbrConvId,
          workspace_identity: pbrWorkspaceDir,
          repository_identity: 'example/pbr-repo'
        }],
        capabilities: ['rally.echo'],
        paused: false
      }
    });

    // 启动 Surface HTTP 服务 (动态端口)
    server1 = await startStatusSurfaceServer({
      registry: registry1,
      browserAdapter: mockBrowserAdapter,
      observationCoordinator: coordinator1,
      port: 0
    });

    // 启动协调器 (协调工作区 hook)
    await coordinator1.start();

    // 验证工作区 Hook 隔离 (白名单完全隔离)
    const rallyAllowlistPath = path.join(rallyWorkspaceDir, '.agents', 'rally-conversations.json');
    const pbrAllowlistPath = path.join(pbrWorkspaceDir, '.agents', 'rally-conversations.json');
    assert.ok(fs.existsSync(rallyAllowlistPath), 'Rally allowlist must exist');
    assert.ok(fs.existsSync(pbrAllowlistPath), 'PBR allowlist must exist');

    const rallyAllowlistContent = fs.readFileSync(rallyAllowlistPath, 'utf8');
    const pbrAllowlistContent = fs.readFileSync(pbrAllowlistPath, 'utf8');
    assert.ok(rallyAllowlistContent.includes(rallyConvId), 'Rally allowlist must contain rallyConvId');
    assert.ok(!rallyAllowlistContent.includes(pbrConvId), 'Rally allowlist must NOT contain pbrConvId');
    assert.ok(pbrAllowlistContent.includes(pbrConvId), 'PBR allowlist must contain pbrConvId');
    assert.ok(!pbrAllowlistContent.includes(rallyConvId), 'PBR allowlist must NOT contain rallyConvId');

    // 2. 构造符合官方 Antigravity 规范的 transcript 文件
    const logDir = path.join(tempBase, rallyConvId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const transcriptFile = path.join(logDir, 'transcript.jsonl');
    const transcriptEntry = JSON.stringify({
      step_index: 10,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Rally implementation complete'
    }) + '\n';
    fs.writeFileSync(transcriptFile, transcriptEntry, 'utf8');

    // 3. 通过真实 HTTP POST 请求分发 Stop Hook 事件至 Rally
    const hookResponse = await fetch(`${server1.url}/api/hooks/antigravity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: rallyConvId,
        workspacePaths: [rallyWorkspaceDir],
        transcriptPath: transcriptFile,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL'
      })
    });

    assert.equal(hookResponse.status, 200, 'Hook endpoint must return 200');
    const hookResult = await hookResponse.json();
    assert.equal(hookResult.success, true, `Hook must succeed: ${JSON.stringify(hookResult)}`);
    assert.equal(hookResult.result?.accepted, true, 'Hook must be accepted by Ingress');
    assert.equal(hookResult.result?.binding_id, 'proj-rally');
    assert.equal(hookResult.result?.endpoint_id, 'ide-rally');

    // 验证 (a) Rally 成功推进为 NEW，且建立确凿的 ordering evidence 与 surface 指示器
    const rallySnap1 = rallyCore1.getSnapshot();
    assert.equal(rallySnap1.endpoints.ide_endpoints['ide-rally'].result_state, 'NEW');
    assert.equal(rallySnap1.ordering_evidence.certainty, 'DEFINITE');
    assert.equal(rallySnap1.ordering_evidence.latest_side, 'ide');
    assert.equal(rallySnap1.ordering_evidence.latest_endpoint, 'ide-rally');

    const surfaceList1 = projectRegistrySurface(registry1);
    const rallySurface1 = surfaceList1.find(p => p.binding_id === 'proj-rally');
    const pbrSurface1 = surfaceList1.find(p => p.binding_id === 'proj-pbr');

    assert.equal(rallySurface1.latest_result_indicator, 'IDE_LATEST');
    const rallyIdeSlot1 = rallySurface1.ide_endpoints.find(e => e.endpoint_id === 'ide-rally');
    assert.equal(rallyIdeSlot1.is_latest_result, true);

    // 验证 (b) PBR 严格隔离：PBR 端点未受任何污染
    const pbrSnap1 = pbrCore1.getSnapshot();
    assert.notEqual(pbrSnap1.endpoints.ide_endpoints['ide-pbr']?.result_state, 'NEW');
    assert.equal(pbrSnap1.ordering_evidence.certainty, 'NONE');
    assert.equal(pbrSurface1.latest_result_indicator, 'NONE');
    const pbrIdeSlot1 = pbrSurface1.ide_endpoints.find(e => e.endpoint_id === 'ide-pbr');
    assert.equal(pbrIdeSlot1.is_latest_result, false);

    // 4. 持久化并安全关闭 Session 1
    assert.ok(fs.existsSync(storagePath), 'Registry storage file must exist on disk');
    coordinator1.stop();
    await server1.close();
    server1 = null;
    coordinator1 = null;

    // 5. 模拟应用重启 (Session 2: Durable Restart & Startup Reconciliation)
    const registry2 = createProjectRegistry({ storagePath });
    const rallyCore2 = registry2.getProject('proj-rally');
    const pbrCore2 = registry2.getProject('proj-pbr');

    // 验证持久化还原：ordering_evidence 完整恢复
    const restoredRallySnap = rallyCore2.getSnapshot();
    assert.equal(restoredRallySnap.ordering_evidence.certainty, 'DEFINITE');
    assert.equal(restoredRallySnap.ordering_evidence.latest_side, 'ide');
    assert.equal(restoredRallySnap.ordering_evidence.latest_endpoint, 'ide-rally');

    // 启动 Session 2 Coordinator 与 Server
    coordinator2 = createObservationRuntimeCoordinator({
      registry: registry2,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 500
    });

    server2 = await startStatusSurfaceServer({
      registry: registry2,
      browserAdapter: mockBrowserAdapter,
      observationCoordinator: coordinator2,
      port: 0
    });

    // 启动协调器并触发全量原子裁决
    await coordinator2.start();

    // 验证 (c) 重启后原子裁决：游标未变化，DEFINITE IDE_LATEST 保持稳定，无 replay，无降级为 UNCERTAIN
    const surfaceList2 = projectRegistrySurface(registry2);
    const rallySurface2 = surfaceList2.find(p => p.binding_id === 'proj-rally');
    const pbrSurface2 = surfaceList2.find(p => p.binding_id === 'proj-pbr');

    assert.equal(rallySurface2.latest_result_indicator, 'IDE_LATEST');
    const rallyIdeSlot2 = rallySurface2.ide_endpoints.find(e => e.endpoint_id === 'ide-rally');
    assert.equal(rallyIdeSlot2.is_latest_result, true);
    assert.equal(rallyCore2.getSnapshot().ordering_evidence.certainty, 'DEFINITE');
    assert.equal(rallyCore2.getSnapshot().ordering_evidence.latest_endpoint, 'ide-rally');

    // PBR 仍然保持干净的隔离
    assert.equal(pbrSurface2.latest_result_indicator, 'NONE');
    const pbrIdeSlot2 = pbrSurface2.ide_endpoints.find(e => e.endpoint_id === 'ide-pbr');
    assert.equal(pbrIdeSlot2.is_latest_result, false);
    assert.equal(pbrCore2.getSnapshot().ordering_evidence.certainty, 'NONE');
  });
});
