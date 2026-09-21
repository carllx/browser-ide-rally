/**
 * 多项目独立隔离时序证据集成测试
 * 
 * 严格覆盖 Issue #27 验收标准 10:
 * 至少两个独立项目，端点时序证据 (Ordering Evidence / Latest Result Indicator) 完全隔离，互不干扰。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { projectRegistrySurface, projectStatusSurface } from '../../src/surface/surface-projection.js';

function createTempStoragePath(prefix = 'rally-test-multi-ordering-') {
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

test('[Multi-Project Ordering Integration] 两个独立项目端点时序证据完全隔离互不串线', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const registry = createProjectRegistry({ storagePath: file });

    const bindingA = createBinding({
      binding_id: 'proj-alpha',
      display_name: 'Project Alpha',
      browser: { provider: 'chatgpt', conversation_id: 'b-alpha' },
      ide: { conversation_id: 'i-alpha', workspace_identity: '/ws/alpha', repository_identity: 'repo/alpha' }
    });

    const bindingB = createBinding({
      binding_id: 'proj-beta',
      display_name: 'Project Beta',
      browser: { provider: 'chatgpt', conversation_id: 'b-beta' },
      ide: { conversation_id: 'i-beta', workspace_identity: '/ws/beta', repository_identity: 'repo/beta' }
    });

    const projA = registry.registerProject({ binding: bindingA });
    const projB = registry.registerProject({ binding: bindingB });

    // 1. 初始化端点基准游标
    projA.recordEndpointObservation('browser', { conversation_id: 'b-alpha', trusted: true, latest_completed_cursor: 'a_b1' });
    projA.recordEndpointObservation('ide', { conversation_id: 'i-alpha', trusted: true, latest_completed_cursor: 'a_i1' });

    projB.recordEndpointObservation('browser', { conversation_id: 'b-beta', trusted: true, latest_completed_cursor: 'b_b1' });
    projB.recordEndpointObservation('ide', { conversation_id: 'i-beta', trusted: true, latest_completed_cursor: 'b_i1' });

    // 2. Project A 发生 Browser live 完成 -> Project A 应为 BROWSER_LATEST
    projA.recordEndpointObservation('browser', {
      conversation_id: 'b-alpha',
      trusted: true,
      latest_completed_cursor: 'a_b2',
      live_witnessed: true
    });

    // 3. Project B 发生 IDE live 完成 -> Project B 应为 IDE_LATEST
    projB.recordEndpointObservation('ide', {
      conversation_id: 'i-beta',
      trusted: true,
      latest_completed_cursor: 'b_i2',
      live_witnessed: true
    });

    // 4. 验证两个项目的快照与表面投影完全隔离
    const surfaceA1 = projectStatusSurface(projA.getSnapshot());
    const surfaceB1 = projectStatusSurface(projB.getSnapshot());

    assert.equal(surfaceA1.latest_result_indicator, 'BROWSER_LATEST');
    assert.equal(surfaceA1.browser.is_latest_result, true);
    assert.equal(surfaceA1.ide.is_latest_result, false);

    assert.equal(surfaceB1.latest_result_indicator, 'IDE_LATEST');
    assert.equal(surfaceB1.ide.is_latest_result, true);
    assert.equal(surfaceB1.browser.is_latest_result, false);

    // 5. Project A 标记 Handled：Project A 结果状态变为 NO_NEW_RESULT 但 indicator 保持 BROWSER_LATEST，Project B 完全无变动
    projA.markEndpointHandled('browser', { expected_cursor: 'a_b2' });

    const surfaceA2 = projectStatusSurface(projA.getSnapshot());
    const surfaceB2 = projectStatusSurface(projB.getSnapshot());

    assert.equal(surfaceA2.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(surfaceA2.latest_result_indicator, 'BROWSER_LATEST');
    assert.equal(surfaceB2.latest_result_indicator, 'IDE_LATEST');

    // 6. Registry 多项目全局投影校验
    const multiSurface = projectRegistrySurface(registry);
    assert.equal(multiSurface.length, 2);
    const alphaProj = multiSurface.find(p => p.binding_id === 'proj-alpha');
    const betaProj = multiSurface.find(p => p.binding_id === 'proj-beta');

    assert.equal(alphaProj.latest_result_indicator, 'BROWSER_LATEST');
    assert.equal(betaProj.latest_result_indicator, 'IDE_LATEST');

    // 7. 持久化并从磁盘重载，验证跨进程/重启时多项目 ordering 证据依然完全保真独立
    registry.saveToFile();

    const registryReloaded = createProjectRegistry({ storagePath: file });
    const pA = registryReloaded.getProject('proj-alpha');
    const pB = registryReloaded.getProject('proj-beta');

    assert.equal(pA.getSnapshot().ordering_evidence.latest_endpoint, 'browser');
    assert.equal(pA.getSnapshot().ordering_evidence.checkpoint_cursors.browser, 'a_b2');

    assert.equal(pB.getSnapshot().ordering_evidence.latest_endpoint, 'ide');
    assert.equal(pB.getSnapshot().ordering_evidence.checkpoint_cursors.ide['ide'], 'b_i2');
  } finally {
    cleanup();
  }
});
