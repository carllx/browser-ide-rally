/**
 * Live Surface Refresh 客户端模块单元测试
 * 验证纯只读投影消费、DOM 增量同步、红点派生与 Fail-Visible Stale 行为
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStatusSurfaceHtml } from '../../src/surface/surface-template.js';
import {
  applyProjectionToDom,
  setSurfaceStaleStatus,
  formatHonestRelativeTimeClient
} from '../../src/surface/live-refresh-client.js';

describe('Live Surface Refresh 客户端单元测试', () => {
  let dom;
  let document;

  const sampleInitialProjects = [
    {
      binding_id: 'proj-alpha',
      binding_revision: 1,
      display_name: 'Alpha Project',
      latest_result_indicator: 'NONE',
      ordering_evidence: {
        certainty: 'NONE',
        latest_side: null,
        latest_endpoint: null
      },
      browser: {
        endpoint_id: 'browser',
        role: 'browser',
        result_state: 'NO_NEW_RESULT',
        latest_completed_cursor: 'cur-b-1',
        is_latest_result: false,
        continuity: { trusted: true }
      },
      ide_endpoints: [
        {
          endpoint_id: 'ide-primary',
          role: 'ide',
          result_state: 'NO_NEW_RESULT',
          latest_completed_cursor: 'cur-ide-1',
          is_latest_result: false,
          continuity: { trusted: true }
        }
      ],
      human_intervention: { active: false },
      actions: []
    }
  ];

  beforeEach(() => {
    const initialHtml = renderStatusSurfaceHtml({ projects: sampleInitialProjects });
    dom = new JSDOM(initialHtml, { runScripts: 'outside-only' });
    document = dom.window.document;
  });

  it('1. 投影更新：当 IDE 端点产生新完成时，红点正确移动至 IDE，且无常规 NEW 文本污染扫描行', () => {
    // 初始状态：无红点
    const card = document.getElementById('card-proj-alpha');
    assert.ok(card);
    const scanRow = card.querySelector('.project-scan-row');
    assert.equal(scanRow.querySelectorAll('.latest-dot').length, 0);

    // 模拟服务端返回新投影：IDE 产生可靠完成，成为 IDE_LATEST
    const updatedProjects = [
      {
        binding_id: 'proj-alpha',
        binding_revision: 1,
        display_name: 'Alpha Project',
        latest_result_indicator: 'IDE_LATEST',
        ordering_evidence: {
          certainty: 'DEFINITE',
          latest_side: 'ide',
          latest_endpoint: 'ide-primary'
        },
        browser: {
          endpoint_id: 'browser',
          role: 'browser',
          result_state: 'NO_NEW_RESULT',
          latest_completed_cursor: 'cur-b-1',
          is_latest_result: false,
          continuity: { trusted: true }
        },
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            role: 'ide',
            result_state: 'NEW',
            latest_completed_cursor: 'cur-ide-2',
            is_latest_result: true,
            continuity: { trusted: true },
            completed_at: new Date().toISOString()
          }
        ],
        human_intervention: { active: false },
        actions: []
      }
    ];

    applyProjectionToDom(document, updatedProjects);

    // 验证扫描行：IDE 标签出现红点，Browser 标签无红点
    const ideTag = card.querySelector('.endpoint-tag-ide[data-endpoint-id="ide-primary"]');
    assert.ok(ideTag.classList.contains('has-latest'), 'IDE 标签应有 has-latest 类');
    assert.ok(ideTag.querySelector('.latest-dot'), 'IDE 标签内应包含红点');

    const browserTag = card.querySelector('.endpoint-tag-browser');
    assert.equal(browserTag.classList.contains('has-latest'), false);
    assert.equal(browserTag.querySelector('.latest-dot'), null);

    // 扫描行中严禁存在常规 NEW 文本
    assert.equal(scanRow.textContent.includes('NO_NEW_RESULT'), false);
    assert.equal(scanRow.querySelector('.badge-new'), null);

    // Details 抽屉中更新了对应的徽章与游标
    const ideCard = card.querySelector('.endpoint-card[data-endpoint-id="ide-primary"]');
    assert.ok(ideCard);
    assert.equal(ideCard.getAttribute('data-result-state'), 'NEW');
    assert.ok(ideCard.querySelector('.badge-new'));
  });

  it('2. 多 IDE 侧级最新更新：若处于侧级 IDE_LATEST，红点仅在 IDE 组标签渲染，子端点不打红点', () => {
    const multiIdeProjects = [
      {
        binding_id: 'proj-multi',
        binding_revision: 1,
        display_name: 'Multi IDE Project',
        latest_result_indicator: 'IDE_LATEST',
        ordering_evidence: {
          certainty: 'DEFINITE',
          latest_side: 'ide',
          latest_endpoint: null // 侧级最新，无法归属到具体端点
        },
        browser: {
          endpoint_id: 'browser',
          role: 'browser',
          result_state: 'NO_NEW_RESULT',
          latest_completed_cursor: 'cur-b-1',
          is_latest_result: false,
          continuity: { trusted: true }
        },
        ide_endpoints: [
          {
            endpoint_id: 'ide-worker-1',
            role: 'ide',
            result_state: 'NEW',
            latest_completed_cursor: 'cur-w1',
            is_latest_result: false,
            continuity: { trusted: true }
          },
          {
            endpoint_id: 'ide-worker-2',
            role: 'ide',
            result_state: 'NEW',
            latest_completed_cursor: 'cur-w2',
            is_latest_result: false,
            continuity: { trusted: true }
          }
        ],
        human_intervention: { active: false },
        actions: []
      }
    ];

    const multiHtml = renderStatusSurfaceHtml({ projects: multiIdeProjects });
    const localDom = new JSDOM(multiHtml);
    const localDoc = localDom.window.document;

    // 验证初始渲染与增量刷新行为一致
    applyProjectionToDom(localDoc, multiIdeProjects);

    const multiCard = localDoc.getElementById('card-proj-multi');
    const ideGroup = multiCard.querySelector('.endpoint-tag-ide-group');
    assert.ok(ideGroup.classList.contains('has-latest'), 'IDE 组应标记 has-latest');
    assert.ok(ideGroup.querySelector('.latest-dot'), 'IDE 组应有红点');

    const subSlots = multiCard.querySelectorAll('.ide-sub-slots .endpoint-tag-ide');
    assert.equal(subSlots.length, 2);
    for (const slot of subSlots) {
      assert.equal(slot.classList.contains('has-latest'), false, '侧级最新时子端点不得打红点');
      assert.equal(slot.querySelector('.latest-dot'), null);
    }
  });

  it('3. UNCERTAIN 状态更新：醒目呈现 ? 排序未定，且 Browser 与 IDE 两侧均无红点', () => {
    const uncertainProjects = [
      {
        binding_id: 'proj-alpha',
        binding_revision: 1,
        display_name: 'Alpha Project',
        latest_result_indicator: 'UNCERTAIN',
        ordering_evidence: {
          certainty: 'UNCERTAIN',
          latest_side: null,
          latest_endpoint: null
        },
        browser: {
          endpoint_id: 'browser',
          role: 'browser',
          result_state: 'NEW',
          latest_completed_cursor: 'cur-b-2',
          is_latest_result: false,
          continuity: { trusted: true }
        },
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            role: 'ide',
            result_state: 'NEW',
            latest_completed_cursor: 'cur-ide-2',
            is_latest_result: false,
            continuity: { trusted: true }
          }
        ],
        human_intervention: { active: false },
        actions: []
      }
    ];

    applyProjectionToDom(document, uncertainProjects);

    const card = document.getElementById('card-proj-alpha');
    const scanRow = card.querySelector('.project-scan-row');
    const uncertainTag = scanRow.querySelector('.indicator-uncertain');
    assert.ok(uncertainTag, '扫描行应包含 .indicator-uncertain 元素');
    assert.match(uncertainTag.textContent, /排序未定|UNCERTAIN/i);

    // 两侧均无红点
    assert.equal(scanRow.querySelectorAll('.latest-dot').length, 0);
  });

  it('4. 用户交互保护：刷新时保持用户已展开的 details 状态，不强行折叠', () => {
    const card = document.getElementById('card-proj-alpha');
    const details = card.querySelector('.project-details');
    assert.ok(details);

    // 用户手动展开了详情
    details.open = true;

    // 执行后台投影刷新
    applyProjectionToDom(document, sampleInitialProjects);

    // 验证 details 依然保持 open 状态
    assert.equal(details.open, true, '刷新不得自动关闭用户打开的 details 抽屉');
  });

  it('5. Fail-Visible / Stale: 遇到错误时标为陈旧，绝不捏造新状态或修改已有数据', () => {
    const card = document.getElementById('card-proj-alpha');
    const ideCard = card.querySelector('.endpoint-card[data-endpoint-id="ide-primary"]');
    const initialCursorText = ideCard.textContent;

    // 触发陈旧状态
    setSurfaceStaleStatus(document, {
      isStale: true,
      reason: 'Network request failed (500)',
      lastSyncTime: new Date(Date.now() - 10000).toISOString()
    });

    // 检查 DOM 标记
    assert.equal(document.body.getAttribute('data-surface-stale'), 'true');
    const indicator = document.getElementById('surface-sync-indicator');
    assert.ok(indicator);
    assert.ok(indicator.classList.contains('sync-stale'), '指示器应具有 sync-stale 类');
    assert.match(indicator.textContent, /陈旧|断开|失败/);

    // 验证既有端点卡片的内容未被篡改
    assert.equal(ideCard.textContent, initialCursorText, '陈旧状态下原有端点内容必须冻结且保持不变');

    // 恢复同步
    setSurfaceStaleStatus(document, {
      isStale: false,
      lastSyncTime: new Date().toISOString()
    });
    assert.equal(document.body.getAttribute('data-surface-stale'), 'false');
    assert.ok(indicator.classList.contains('sync-live'));
  });

  it('6. 诚实相对时间格式化客户端测试', () => {
    const now = new Date();
    assert.match(formatHonestRelativeTimeClient(now.toISOString()), /刚刚/);
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    assert.match(formatHonestRelativeTimeClient(tenMinAgo.toISOString()), /10\s*分钟前/);
    assert.equal(formatHonestRelativeTimeClient(null), '暂无观察时间');
  });
});
