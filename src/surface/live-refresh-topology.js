/**
 * 状态表面结构拓扑一致性校验模块 (Live Refresh Topology Module)
 *
 * 领域不变式与规范准则 (#37):
 * 1. 严格比对规范投影中的项目集合与当前 DOM 扫描行/卡片集合 (binding_id 必须完全一致)；
 * 2. 严格比对每个项目内部的端点集合与当前 DOM 端点卡片集合 (endpoint_id 必须完全一致)；
 * 3. 严格比对单 IDE ↔ 多 IDE 扫描行与卡片结构；
 * 4. 任意项不匹配时返回 false，由调用方触发受控全页重载，严禁声称增量同步成功并显示“实时已同步”。
 */

/**
 * 校验当前 DOM 拓扑结构是否足以忠实容纳规范投影中的项目与端点
 * @param {Document} doc
 * @param {Array<object>} projects
 * @returns {boolean}
 */
export function checkStructuralTopologyMatches(doc, projects = []) {
  if (!doc) return false;

  // 1. 项目卡片集合精确匹配
  const domCards = doc.querySelectorAll('.project-card');
  const domBindingIds = new Set();
  domCards.forEach(card => {
    const bId = card.getAttribute('data-binding-id') || (card.id ? card.id.replace(/^card-/, '') : null);
    if (bId) domBindingIds.add(bId);
  });

  const projBindingIds = new Set((projects || []).map(p => p.binding_id).filter(Boolean));
  if (domBindingIds.size !== projBindingIds.size) {
    return false;
  }
  for (const bId of projBindingIds) {
    if (!domBindingIds.has(bId)) {
      return false;
    }
  }

  // 2. 项目内部端点拓扑与结构精确匹配
  for (const proj of projects) {
    const card = doc.getElementById(`card-${proj.binding_id}`);
    if (!card) return false;

    // A. 诊断区端点卡片数量与 ID 集合比对
    const domEpCards = card.querySelectorAll('.endpoint-card');
    const domEpIds = new Set();
    domEpCards.forEach(c => {
      const epId = c.getAttribute('data-endpoint-id');
      if (epId) domEpIds.add(epId);
    });

    const expectedEpIds = new Set();
    if (proj.browser) {
      expectedEpIds.add(proj.browser.endpoint_id || proj.browser.endpoint || 'browser');
    }
    const ideEndpoints = Array.isArray(proj.ide_endpoints) ? proj.ide_endpoints : [];
    for (const ide of ideEndpoints) {
      expectedEpIds.add(ide.endpoint_id || ide.endpoint);
    }

    if (domEpIds.size !== expectedEpIds.size) {
      return false;
    }
    for (const epId of expectedEpIds) {
      if (!domEpIds.has(epId)) {
        return false;
      }
    }

    // B. 单 IDE ↔ 多 IDE 扫描行与卡片拓扑结构比对
    const hasIdeGroupTag = Boolean(card.querySelector('.endpoint-tag-ide-group'));
    const isMultiIde = ideEndpoints.length > 1;
    if (hasIdeGroupTag !== isMultiIde) {
      return false;
    }
  }

  return true;
}
