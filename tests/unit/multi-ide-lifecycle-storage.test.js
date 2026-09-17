/**
 * Multi-IDE Lifecycle, Hydration & Storage 验收测试套件 (#21 Review Delta)
 *
 * 核心验证：
 * 1. 重启独立恢复两个 IDE 的 handled 游标，不回放为 NEW；
 * 2. v1 durable single-IDE storage 确定性迁移至 schema v2；
 * 3. 禁止移除至 0 个 IDE 端点；
 * 4. 校验 multi-IDE 强制要求 endpoint_revision 与 exact provider identity；
 * 5. 真实 AntigravityIdeAdapter 实例对多 IDE 端点的独立寻址与互不污染；
 * 6. updateBinding() 严格拦截任何 IDE 拓扑、身份与版本变动，堵死生命周期绕过漏洞；
 * 7. 持久化端点代际失配 (stale endpoint_revision) 必须严格 Fail-Closed 到 UNKNOWN。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry, CURRENT_SCHEMA_VERSION, DETERMINISTIC_MIGRATED_IDE_ID } from '../../src/registry/project-registry.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { AntigravityIdeAdapter } from '../../src/adapters/ide/antigravity-adapter.js';

function createTempStoragePath(prefix = 'rally-multi-ide-storage-test') {
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

function makeMultiIdeBinding(id = 'proj-multi-002') {
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

test('[Multi-IDE Storage] 1. 重启独立恢复两个 IDE 的 handled 游标，不回放为 NEW', () => {
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

test('[Multi-IDE Storage] 2. v1 durable single-IDE storage 确定性迁移至 schema v2', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
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

    assert.ok(snap.endpoints.ide_endpoints[DETERMINISTIC_MIGRATED_IDE_ID]);
    const migratedFact = snap.endpoints.ide_endpoints[DETERMINISTIC_MIGRATED_IDE_ID];
    assert.equal(migratedFact.result_state, 'NO_NEW_RESULT');
    assert.equal(migratedFact.latest_completed_cursor, 'i-cursor-1');
    assert.equal(migratedFact.last_handled_cursor, 'i-cursor-1');

    reg.saveToFile(file);
    const reloadedRaw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(reloadedRaw.schema_version, CURRENT_SCHEMA_VERSION);
  } finally {
    cleanup();
  }
});

test('[Multi-IDE Storage] 3. 禁止移除至 0 个 IDE 端点', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.removeIdeEndpoint('ide-b', { confirm_replace_unknown: true });
  assert.equal(core.getSnapshot().endpoints.ide_endpoints['ide-b'], undefined);

  assert.throws(() => {
    core.removeIdeEndpoint('ide-a', { confirm_replace_unknown: true });
  }, /Cannot remove the last IDE endpoint; Rally project requires at least one IDE endpoint slot/);
});

test('[Multi-IDE Observation] 4. 校验 multi-IDE 强制要求 endpoint_revision 与 exact provider identity', () => {
  const binding = makeMultiIdeBinding();
  const core = createProjectStatusCore({ binding });

  core.recordEndpointObservation('ide-a', {
    conversation_id: 'conv-ide-a',
    binding_revision: 1,
    trusted: true,
    latest_completed_cursor: 'turn-ia-invalid'
  });
  let snap = core.getSnapshot();
  assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'UNKNOWN');
  assert.match(snap.endpoints.ide_endpoints['ide-a'].unknown_reason, /missing_endpoint_revision/);

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

test('[Multi-IDE Adapter] 5. 真实 AntigravityIdeAdapter 实例对多 IDE 端点的独立寻址与互不污染', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-multi-adapter-test-'));
  try {
    const binding = makeMultiIdeBinding('proj-ag-multi-adapters');
    const core = createProjectStatusCore({ binding });

    const logDirA = path.join(tmpDir, 'brain', 'conv-ide-a', '.system_generated', 'logs');
    const logDirB = path.join(tmpDir, 'brain', 'conv-ide-b', '.system_generated', 'logs');
    fs.mkdirSync(logDirA, { recursive: true });
    fs.mkdirSync(logDirB, { recursive: true });

    const transcriptFileA = path.join(logDirA, 'transcript.jsonl');
    const transcriptFileB = path.join(logDirB, 'transcript.jsonl');

    fs.writeFileSync(transcriptFileA, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Task A completed'
    }) + '\n');

    fs.writeFileSync(transcriptFileB, JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Task B completed'
    }) + '\n');

    const adapterA = new AntigravityIdeAdapter({
      binding,
      statusCore: core,
      endpointId: 'ide-a'
    });

    const adapterB = new AntigravityIdeAdapter({
      binding,
      statusCore: core,
      endpointId: 'ide-b'
    });

    const hookResA = adapterA.handleStopHook({
      conversationId: 'conv-ide-a',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFileA
    });

    assert.equal(hookResA.accepted, true);

    let snap = core.getSnapshot();
    assert.equal(snap.endpoints.ide_endpoints['ide-a'].result_state, 'NEW');
    assert.match(snap.endpoints.ide_endpoints['ide-a'].latest_completed_cursor, /^ag-step:1:/);
    assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
    assert.equal(snap.endpoints.ide_endpoints['ide-b'].latest_completed_cursor, null);

    const hookResB = adapterB.handleStopHook({
      conversationId: 'conv-ide-b',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFileB
    });

    assert.equal(hookResB.accepted, true);

    snap = core.getSnapshot();
    assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'NEW');
    assert.match(snap.endpoints.ide_endpoints['ide-b'].latest_completed_cursor, /^ag-step:2:/);

    const crossRes = adapterA.handleStopHook({
      conversationId: 'conv-ide-b',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFileB
    });
    assert.equal(crossRes.accepted, false);
    assert.match(crossRes.reason, /attribution_mismatch/);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test('[Multi-IDE Guard] 6. updateBinding() 严格拦截任何 IDE 拓扑、身份与版本变动，堵死生命周期绕过漏洞', () => {
  const binding = makeMultiIdeBinding('proj-update-guard');
  const core = createProjectStatusCore({ binding });

  assert.throws(() => {
    core.updateBinding({
      ...binding,
      ide_endpoints: [binding.ide_endpoints[0]]
    });
  }, /Topology-changing add\/remove of IDE endpoints is prohibited in updateBinding/);

  assert.throws(() => {
    core.updateBinding({
      ...binding,
      ide_endpoints: [
        ...binding.ide_endpoints,
        {
          endpoint_id: 'ide-c',
          endpoint_revision: 1,
          conversation_id: 'c',
          workspace_identity: 'w',
          repository_identity: 'r'
        }
      ]
    });
  }, /Topology-changing add\/remove of IDE endpoints is prohibited in updateBinding/);

  assert.throws(() => {
    core.updateBinding({
      ...binding,
      ide_endpoints: [
        { ...binding.ide_endpoints[0], conversation_id: 'sneaky-conversation-bypass' },
        binding.ide_endpoints[1]
      ]
    });
  }, /IDE endpoint identity or revision mutation for "ide-a" is prohibited in updateBinding/);

  assert.throws(() => {
    core.updateBinding({
      ...binding,
      ide_endpoints: [
        { ...binding.ide_endpoints[0], endpoint_revision: 99 },
        binding.ide_endpoints[1]
      ]
    });
  }, /IDE endpoint identity or revision mutation for "ide-a" is prohibited in updateBinding/);
});

test('[Multi-IDE Hydration] 7. 持久化端点代际失配 (stale endpoint_revision) 必须严格 Fail-Closed 到 UNKNOWN', () => {
  const { file, cleanup } = createTempStoragePath('ag-stale-generation-test');
  try {
    const staleV2Data = {
      schema_version: 2,
      saved_at: '2026-09-17T10:00:00.000Z',
      projects: {
        'proj-stale-gen': {
          binding: {
            binding_id: 'proj-stale-gen',
            binding_revision: 3,
            browser: { provider: 'chatgpt', conversation_id: 'conv-b-1' },
            ide_endpoints: [
              {
                endpoint_id: 'ide-a',
                endpoint_revision: 2,
                conversation_id: 'conv-a-v2',
                workspace_identity: '/w',
                repository_identity: 'c/r'
              }
            ],
            capabilities: ['rally.echo'],
            paused: false
          },
          endpoints: {
            browser: {
              endpoint: 'browser',
              latest_completed_cursor: 'b-1',
              last_handled_cursor: 'b-1',
              continuity: { trusted: true, unknown_reason: null }
            },
            ide_endpoints: {
              'ide-a': {
                endpoint: 'ide-a',
                endpoint_revision: 1,
                latest_completed_cursor: 'ag-step:1:abc',
                last_handled_cursor: 'ag-step:1:abc',
                continuity: { trusted: true, unknown_reason: null }
              }
            }
          }
        }
      }
    };

    fs.writeFileSync(file, JSON.stringify(staleV2Data, null, 2), 'utf-8');

    const reg = createProjectRegistry({ storagePath: file });
    const core = reg.getProject('proj-stale-gen');
    const snap = core.getSnapshot();

    const factA = snap.endpoints.ide_endpoints['ide-a'];
    assert.equal(factA.result_state, 'UNKNOWN');
    assert.match(factA.unknown_reason, /stale_persisted_endpoint_generation: expected endpoint_revision 2, got 1/);
    assert.equal(factA.latest_completed_cursor, null);
    assert.equal(factA.last_handled_cursor, null);
  } finally {
    cleanup();
  }
});

test('[Multi-IDE Adapter] 8. 多 IDE 项目下构造 AntigravityIdeAdapter 若缺省 endpointId 则严格拒绝', () => {
  const binding = makeMultiIdeBinding('proj-missing-id-guard');
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding });

  assert.throws(() => {
    new AntigravityIdeAdapter({
      binding,
      statusCore: core
      // 故意省略 endpointId
    });
  }, /AntigravityIdeAdapter requires explicit endpointId when project has multiple IDE endpoints/);
});

