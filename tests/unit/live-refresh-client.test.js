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

  it('7. [Issue #37] 控制元数据一致性：当 binding_revision 推进至 N+1 时，所有控制按钮及摘要版本同步更新', () => {
    const card = document.getElementById('card-proj-alpha');
    const details = card.querySelector('.project-details');
    assert.ok(details);

    // 初始状态为 rev 1
    const initialBadge = details.querySelector('.details-summary-header .badge-rev');
    assert.equal(initialBadge.textContent.trim(), 'rev 1');
    const initialRebindBtn = details.querySelector('button[data-action="rebind"][data-endpoint-id="ide-primary"]');
    assert.equal(initialRebindBtn.getAttribute('data-binding-revision'), '1');

    // 模拟服务端推进规范版本至 rev 2
    const rev2Projects = [
      {
        ...sampleInitialProjects[0],
        binding_revision: 2
      }
    ];

    applyProjectionToDom(document, rev2Projects);

    // 验证摘要版本更新为 rev 2
    assert.equal(initialBadge.textContent.trim(), 'rev 2');

    // 验证所有控制按钮的 data-binding-revision 均同步更新为 2
    const controlButtons = details.querySelectorAll('button[data-binding-revision]');
    assert.ok(controlButtons.length > 0, 'Details 区应包含带有 data-binding-revision 的按钮');
    controlButtons.forEach(btn => {
      assert.equal(btn.getAttribute('data-binding-revision'), '2', `按钮 ${btn.getAttribute('data-action')} 的版本未更新为 2`);
    });
  });

  it('8. [Issue #37] 端点身份一致性：重绑或身份变更后，端点卡片展示文本与 Rebind 按钮属性同步反映新值', () => {
    const card = document.getElementById('card-proj-alpha');
    const details = card.querySelector('.project-details');
    const ideCard = details.querySelector('.endpoint-card[data-endpoint-id="ide-primary"]');
    assert.ok(ideCard);

    // 模拟服务端返回重绑后的新端点身份
    const reboundProjects = [
      {
        ...sampleInitialProjects[0],
        binding_revision: 2,
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            endpoint_revision: 2,
            role: 'ide',
            conversation_id: 'new-conv-uuid-1234',
            workspace_identity: '/new/workspace/path',
            repository_identity: 'github.com/new-org/new-repo',
            result_state: 'NEW',
            latest_completed_cursor: 'cur-ide-new-1',
            is_latest_result: true,
            continuity: { trusted: true }
          }
        ]
      }
    ];

    applyProjectionToDom(document, reboundProjects);

    // 1. 验证端点版本 badge
    const epRevBadge = ideCard.querySelector('.ep-rev-badge');
    assert.equal(epRevBadge.textContent.trim(), 'rev 2');

    // 2. 验证 Rebind 按钮携带的新身份属性
    const rebindBtn = ideCard.querySelector('button[data-action="rebind"]');
    assert.equal(rebindBtn.getAttribute('data-binding-revision'), '2');
    assert.equal(rebindBtn.getAttribute('data-conversation-id'), 'new-conv-uuid-1234');
    assert.equal(rebindBtn.getAttribute('data-workspace'), '/new/workspace/path');
    assert.equal(rebindBtn.getAttribute('data-repo'), 'github.com/new-org/new-repo');

    // 3. 验证端点卡片正文中展示的身份文本
    assert.match(ideCard.textContent, /new-conv-uuid-1234/, '端点卡片正文应包含新会话 ID');
    assert.match(ideCard.textContent, /\/new\/workspace\/path/, '端点卡片正文应包含新工作区');
    assert.match(ideCard.textContent, /github\.com\/new-org\/new-repo/, '端点卡片正文应包含新代码仓库');
  });

  it('9. [Issue #37] 诊断错误可见性：BLOCKED/FAILED Action 证据实时渲染至诊断历史表格，Toast 消失后仍清晰可见', () => {
    const card = document.getElementById('card-proj-alpha');
    const details = card.querySelector('.project-details');
    const actionsPlane = details.querySelector('.actions-history-plane');
    assert.ok(actionsPlane);

    // 初始状态：无 Action
    assert.match(actionsPlane.textContent, /无活跃或历史动作事实/);

    // 模拟服务端产生了一条 BLOCKED 动作事实（例如 Rebind 未确认替换）
    const blockedAction = {
      action_id: 'act-rebind-blocked-001',
      action_type: 'rebind',
      target_endpoint: 'ide-primary',
      stage: 'BLOCKED',
      reason: 'Cannot replace ide-primary endpoint with unhandled UNKNOWN result without explicit confirmation',
      created_at: new Date().toISOString()
    };

    const projectsWithBlockedAction = [
      {
        ...sampleInitialProjects[0],
        actions: [blockedAction]
      }
    ];

    applyProjectionToDom(document, projectsWithBlockedAction);

    // 验证表格标题更新了计数
    const title = actionsPlane.querySelector('.section-title strong');
    assert.match(title.textContent, /\(1\)/);

    // 验证表格行正确渲染出 BLOCKED stage 与具体阻断原因
    const actionRow = actionsPlane.querySelector('.action-row.stage-row-BLOCKED');
    assert.ok(actionRow, '应存在 stage-row-BLOCKED 表格行');
    assert.match(actionRow.textContent, /act-rebind-blocked-001/);
    assert.match(actionRow.textContent, /rebind/);
    assert.match(actionRow.textContent, /BLOCKED/);
    assert.match(actionRow.textContent, /Cannot replace ide-primary endpoint with unhandled UNKNOWN result without explicit confirmation/);
  });
});

