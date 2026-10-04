import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStatusSurfaceHtml } from '../../src/surface/surface-template.js';
import { renderProjectDetails } from '../../src/surface/operator-template.js';
import { checkStructuralTopologyMatches } from '../../src/surface/live-refresh-topology.js';
import { applyProjectionToDom } from '../../src/surface/live-refresh-client.js';

function makeMockProject(bindingId, { rev = 1, displayName = null } = {}) {
  return {
    binding_id: bindingId,
    binding_revision: rev,
    display_name: displayName || bindingId,
    capabilities: ['read', 'write'],
    paused: false,
    latest_result_indicator: 'NONE',
    browser: {
      endpoint_id: 'browser',
      role: 'browser',
      result_state: 'NO_NEW_RESULT',
      continuity: { trusted: true }
    },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      role: 'ide',
      result_state: 'NO_NEW_RESULT',
      continuity: { trusted: true }
    }],
    actions: []
  };
}

test('Seam 4.1: renderProjectDetails 渐进式披露中渲染“移出项目”按钮与属性', () => {
  const proj = makeMockProject('proj-demo', { rev: 3, displayName: '演示项目' });
  const html = renderProjectDetails(proj);

  // 必须位于 details 渐进式披露内
  assert.ok(html.includes('<details class="project-details"'));
  // 按钮文本为人性化语言“移出项目”
  assert.ok(html.includes('移出项目'));
  assert.ok(html.includes('data-action="remove-project"'));
  assert.ok(html.includes('data-binding-id="proj-demo"'));
  assert.ok(html.includes('data-binding-revision="3"'));
  // 必须明确说明保留历史与外部会话/代码仓
  assert.ok(html.includes('保留历史事实与外部会话'));
});

test('Seam 4.2: 项目移出后，checkStructuralTopologyMatches 准确识别拓扑变更', () => {
  const projA = makeMockProject('proj-a');
  const projB = makeMockProject('proj-b');

  // 初始页面包含两个项目
  const html = renderStatusSurfaceHtml({
    projects: [projA, projB]
  });
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // 此时拓扑匹配
  assert.equal(checkStructuralTopologyMatches(doc, [projA, projB]), true);

  // 移出 proj-a 后服务端仅剩 proj-b
  const nextProjects = [projB];
  // checkStructuralTopologyMatches 必须返回 false，拒绝增量静默更新
  assert.equal(checkStructuralTopologyMatches(doc, nextProjects), false);
});

test('Seam 4.3: 拓扑失配时 applyProjectionToDom 触发 onStructuralMismatch 而非假同步', () => {
  const projA = makeMockProject('proj-a');
  const projB = makeMockProject('proj-b');

  const html = renderStatusSurfaceHtml({
    projects: [projA, projB]
  });
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  let mismatchTriggered = false;
  const result = applyProjectionToDom(doc, [projB], null, {
    onStructuralMismatch: () => {
      mismatchTriggered = true;
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.reloaded, true);
  assert.equal(result.reason, 'topology_mismatch');
  assert.equal(mismatchTriggered, true);
});

test('Seam 4.4: 拓扑收敛后卡片消失、计数准确且兄弟项目卡片完好', () => {
  const projB = makeMockProject('proj-b', { displayName: '保留的兄弟项目' });

  // 重新渲染或收敛后的 HTML (仅包含 proj-b)
  const html = renderStatusSurfaceHtml({
    projects: [projB]
  });
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // proj-a 卡片已不复存在
  assert.equal(doc.getElementById('card-proj-a'), null);

  // proj-b 卡片完好存在
  const cardB = doc.getElementById('card-proj-b');
  assert.ok(cardB);
  assert.ok(cardB.textContent.includes('保留的兄弟项目'));

  // 顶部汇总项目总数为 1
  const summaryBar = doc.querySelector('.status-summary-bar');
  assert.ok(summaryBar);
  assert.ok(summaryBar.textContent.includes('项目总数: 1'));

  // 筛选全部按钮更新为 全部 (1)
  const allFilterBtn = doc.querySelector('.filter-btn[data-filter="all"]');
  assert.ok(allFilterBtn);
  assert.equal(allFilterBtn.textContent.trim(), '全部 (1)');
});
