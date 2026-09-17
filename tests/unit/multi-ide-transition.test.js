/**
 * Legacy Single-IDE -> Multi-IDE Transition 回归测试套件 (#21 Review Delta)
 *
 * 核心验证：
 * legacy createBinding({ide}) -> Adapter A -> add B -> old Adapter A valid completion
 * -> A accepted and only A advances -> rebind A -> same old Adapter A rejected as stale.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { AntigravityIdeAdapter } from '../../src/adapters/ide/antigravity-adapter.js';

test('[Multi-IDE Transition] legacy single-IDE 转多 IDE 后，旧 Adapter A 观察受信任推进，重绑后旧观察作为 NO-OP 拒绝', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-trans-test-'));

  try {
    const convDirA = path.join(tmpDir, 'conv-ide-a', '.system_generated', 'logs');
    fs.mkdirSync(convDirA, { recursive: true });
    const transcriptFileA = path.join(convDirA, 'transcript.jsonl');

    fs.writeFileSync(transcriptFileA, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Antigravity turn 1 completed',
      created_at: new Date().toISOString()
    }) + '\n');

    // 1. legacy createBinding({ ide }) 初始化
    const initialBinding = createBinding({
      binding_id: 'proj-trans-001',
      browser: {
        provider: 'chatgpt',
        conversation_id: 'conv-browser'
      },
      ide: {
        provider: 'antigravity',
        conversation_id: 'conv-ide-a',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'carllx/browser-ide-rally'
      }
    });

    assert.equal(initialBinding.is_legacy_single_ide, true);
    assert.equal(initialBinding.ide_endpoints.length, 1);
    assert.equal(initialBinding.ide_endpoints[0].endpoint_id, 'ide');
    assert.equal(initialBinding.ide_endpoints[0].endpoint_revision, 1);

    // 2. 状态核心初始化
    const core = createProjectStatusCore({ binding: initialBinding });
    assert.equal(core.isLegacySingleIdeAuthority(), true);

    // 3. 构造 Adapter A（使用旧 binding 快照，未显式传 endpointId，自动解析出 'ide'）
    const adapterA = new AntigravityIdeAdapter({
      binding: initialBinding,
      statusCore: core
    });

    // 4. 动态添加 Sibling 端点 IDE-B -> 项目切换为多 IDE 权威，项目版本升至 2
    core.addIdeEndpoint({
      endpoint_id: 'ide-b',
      identity: {
        provider: 'antigravity',
        conversation_id: 'conv-ide-b',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'carllx/browser-ide-rally'
      }
    });

    assert.equal(core.isLegacySingleIdeAuthority(), false);
    let snap = core.getSnapshot();
    assert.equal(snap.binding.binding_revision, 2);
    assert.equal(Object.keys(snap.endpoints.ide_endpoints).length, 2);

    // 5. 旧 Adapter A（持有旧 binding_revision: 1，但 endpoint_revision: 1 仍合法）发出完成观察
    const hookRes = adapterA.handleStopHook({
      conversationId: 'conv-ide-a',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFileA
    });

    // 验证：A 必须被成功接受
    assert.equal(hookRes.accepted, true);

    snap = core.getSnapshot();
    const factA = snap.endpoints.ide_endpoints['ide'];
    // 验证：仅 A 推进为 NEW，连续性受信任
    assert.equal(factA.result_state, 'NEW');
    assert.equal(factA.continuity.trusted, true);
    assert.equal(factA.continuity.unknown_reason, null);
    assert.ok(factA.latest_completed_cursor.startsWith('ag-step:1:'));

    // 验证：Sibling B 与 Browser 完全不受污染，保持 UNKNOWN
    assert.equal(snap.endpoints.ide_endpoints['ide-b'].result_state, 'UNKNOWN');
    assert.equal(snap.endpoints.ide_endpoints['ide-b'].latest_completed_cursor, null);
    assert.equal(snap.endpoints.browser.result_state, 'UNKNOWN');

    // 6. 重绑端点 A (rebind A) -> A 的 endpoint_revision 递增为 2
    core.rebindEndpoint({
      endpoint_id: 'ide',
      identity: {
        provider: 'antigravity',
        conversation_id: 'conv-ide-a-v2',
        workspace_identity: '/Users/yamlam/Documents/GitHub/browser-ide-rally',
        repository_identity: 'carllx/browser-ide-rally'
      },
      confirm_replace_unknown: true,
      allow_discard_unhandled: true
    });

    snap = core.getSnapshot();
    const boundEpAAfterRebind = snap.binding.ide_endpoints.find(e => e.endpoint_id === 'ide');
    assert.equal(boundEpAAfterRebind?.endpoint_revision, 2);
    // 重绑后端点 A 回到 clean UNKNOWN 状态
    assert.equal(snap.endpoints.ide_endpoints['ide'].result_state, 'UNKNOWN');
    assert.equal(snap.endpoints.ide_endpoints['ide'].latest_completed_cursor, null);

    // 7. 同一个旧 Adapter A（依然持有旧的 endpoint_revision 1）再次发出观察
    adapterA.handleStopHook({
      conversationId: 'conv-ide-a',
      workspacePaths: ['/Users/yamlam/Documents/GitHub/browser-ide-rally'],
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: transcriptFileA
    });

    snap = core.getSnapshot();
    // 验证：确凿过时的旧观察被作为 NO-OP 丢弃，端点 A 保持重绑后的 clean UNKNOWN，游标不被篡改
    assert.equal(snap.endpoints.ide_endpoints['ide'].result_state, 'UNKNOWN');
    assert.equal(snap.endpoints.ide_endpoints['ide'].latest_completed_cursor, null);

    // 8. 即使伪造匹配新 conversation_id 但携带旧 endpoint_revision 1 的观察，依然被拒绝为 NO-OP
    core.recordEndpointObservation('ide', {
      conversation_id: 'conv-ide-a-v2',
      endpoint_revision: 1, // 过时代际
      trusted: true,
      latest_completed_cursor: 'ag-step:99:forged'
    });

    snap = core.getSnapshot();
    assert.equal(snap.endpoints.ide_endpoints['ide'].result_state, 'UNKNOWN');
    assert.equal(snap.endpoints.ide_endpoints['ide'].latest_completed_cursor, null);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
