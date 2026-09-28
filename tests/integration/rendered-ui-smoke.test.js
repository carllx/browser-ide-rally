/**
 * Issue #26 合成双项目紧凑首屏渲染测试
 * (Synthetic Integration / Render Coverage)
 * 验证合成构造的 Rally + PBR 双项目在首屏桌面视口中的紧凑度、红点及可扫描性
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { projectRegistrySurface } from '../../src/surface/surface-projection.js';
import { renderStatusSurfaceHtml } from '../../src/surface/surface-template.js';

describe('Issue #26 合成双项目紧凑首屏渲染测试 (Synthetic Integration/Render Coverage)', () => {
  it('合成 Rally + PBR 双项目在首屏以紧凑项目行呈现，且红点与观察时间诚实渲染', () => {
    const registry = createProjectRegistry();

    // 1. 注册真实 Rally 项目
    const rallyCore = registry.registerProject({
      binding: {
        binding_id: 'proj-rally',
        display_name: 'Rally Main Service',
        binding_revision: 1,
        browser: {
          provider: 'chatgpt',
          conversation_id: 'conv-browser-rally-prod',
          branch: 'main'
        },
        ide_endpoints: [{
          endpoint_id: 'ide-antigravity',
          endpoint_revision: 1,
          conversation_id: 'ag-conv-rally-ide',
          workspace_identity: '/workspace/browser-ide-rally',
          repository_identity: 'carllx/browser-ide-rally'
        }],
        capabilities: ['rally.echo'],
        paused: false
      }
    });

    // 初始化两端受信基线
    rallyCore.recordEndpointObservation('browser', {
      trusted: true,
      latest_completed_cursor: 'browser-step-1',
      provider: 'chatgpt',
      conversation_id: 'conv-browser-rally-prod',
      endpoint_revision: 1
    });
    rallyCore.recordEndpointObservation('ide-antigravity', {
      trusted: true,
      latest_completed_cursor: 'hook-step-41',
      endpoint_id: 'ide-antigravity',
      endpoint_revision: 1,
      conversation_id: 'ag-conv-rally-ide'
    });

    // 模拟 Antigravity IDE 产生最新可靠完成 (Live witnessed completion -> IDE_LATEST)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    rallyCore.recordEndpointObservation('ide-antigravity', {
      trusted: true,
      latest_completed_cursor: 'hook-step-42',
      endpoint_id: 'ide-antigravity',
      endpoint_revision: 1,
      conversation_id: 'ag-conv-rally-ide',
      completed_at: fiveMinutesAgo,
      live_witnessed: true
    });

    // 2. 注册真实 PBR 隔离项目 (无新结果 NONE)
    const pbrCore = registry.registerProject({
      binding: {
        binding_id: 'proj-pbr',
        display_name: 'PBR Physical Binding',
        binding_revision: 1,
        browser: {
          provider: 'chatgpt',
          conversation_id: 'conv-browser-pbr-prod'
        },
        ide_endpoints: [{
          endpoint_id: 'ide-pbr-agent',
          endpoint_revision: 1,
          conversation_id: 'ag-conv-pbr-worker',
          workspace_identity: '/ws/pbr-physical',
          repository_identity: 'org/pbr-repo'
        }],
        capabilities: ['read'],
        paused: false
      }
    });

    // 3. 生成只读表面快照并渲染 HTML
    const surfaceSnapshots = projectRegistrySurface(registry);
    assert.equal(surfaceSnapshots.length, 2);

    const html = renderStatusSurfaceHtml({ projects: surfaceSnapshots });

    // 4. 验证首屏可见性与紧凑语法 (Grammar)
    // a. 包含两个项目的 Display Name
    assert.match(html, /Rally Main Service/);
    assert.match(html, /PBR Physical Binding/);

    // b. 默认扫描行中不包含 routine NEW / NO_NEW_RESULT / 新结果 / 无新结果
    const scanRows = html.match(/<div class="project-scan-row"[\s\S]*?<!-- \/project-scan-row -->/g);
    assert.ok(scanRows && scanRows.length === 2, '必须恰好渲染两行扫描行');

    for (const row of scanRows) {
      assert.equal(row.includes('>NEW<'), false);
      assert.equal(row.includes('>NO_NEW_RESULT<'), false);
      assert.equal(row.includes('新结果'), false);
      assert.equal(row.includes('无新结果'), false);
      assert.equal(row.includes('badge-new'), false);
    }

    // c. Rally 项目的 IDE 标签旁边有红点 (IDE_LATEST)
    const rallyCardMatch = html.match(/<article[^>]*id="card-proj-rally"[\s\S]*?<\/article>/)?.[0] || '';
    assert.match(rallyCardMatch, /data-endpoint-id="ide-antigravity"[^>]*>[\s\S]*?latest-dot/);
    assert.equal(rallyCardMatch.match(/class="[^"]*endpoint-tag-browser[^"]*"/)?.[0]?.includes('latest-dot'), false);

    // d. PBR 项目没有任何红点 (NONE)
    const pbrCardMatch = html.match(/<article[^>]*id="card-proj-pbr"[\s\S]*?<\/article>/)?.[0] || '';
    const pbrScanRow = pbrCardMatch.match(/<div class="project-scan-row"[\s\S]*?<!-- \/project-scan-row -->/)?.[0] || '';
    assert.equal(pbrScanRow.includes('latest-dot'), false);

    // e. 诚实相对观察时间检查
    assert.match(rallyCardMatch, /观察于\s*5\s*分钟前/);

    // f. 原始游标与会话 ID 隐藏在 Details 内
    assert.equal(rallyScanRowIncludes(html, 'hook-step-42'), false, '游标不应暴露在扫描行');
    assert.equal(rallyScanRowIncludes(html, 'ag-conv-rally-ide'), false, '会话 ID 不应暴露在扫描行');
    assert.ok(html.includes('hook-step-42'), '游标保留在 Details/Diagnostics 中');
    assert.ok(html.includes('ag-conv-rally-ide'), '会话 ID 保留在 Details/Diagnostics 中');
  });

  function rallyScanRowIncludes(fullHtml, substring) {
    const scanRowMatch = fullHtml.match(/<div class="project-scan-row"[\s\S]*?<!-- \/project-scan-row -->/);
    return scanRowMatch ? scanRowMatch[0].includes(substring) : false;
  }
});
