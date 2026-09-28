/**
 * Operator 紧凑首屏与红点指示器样式模块 (Operator Surface Styles)
 *
 * 规范约束 (#26):
 * 1. 紧凑项目行 (Compact Scan Row)，首屏最大化呈现项目列表；
 * 2. 红点指示器 (.latest-dot) 鲜明清晰，不依赖额外文字；
 * 3. UNCERTAIN 状态使用非红琥珀色问号与轻量胶囊；
 * 4. 渐进式披露折叠面板 (.project-details) 与原生的微型标签。
 */

export const OPERATOR_CSS = `
  /* 紧凑项目卡片与扫描行 */
  .project-card {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 12px;
    transition: border-color 0.2s;
  }
  .project-card:hover {
    border-color: #444c56;
  }

  .project-scan-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    gap: 16px;
    flex-wrap: wrap;
    background: #161b22;
  }

  .scan-cell-identity {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 220px;
    flex: 1 1 auto;
  }
  .scan-display-name {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-heading);
  }
  .project-canonical-id {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-family: monospace;
  }

  /* 端点与红点指示器 */
  .scan-cell-endpoints {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 auto;
  }

  .endpoint-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    background: #21262d;
    border: 1px solid var(--panel-border);
    color: var(--text);
  }
  .endpoint-tag.has-latest {
    border-color: #f85149;
    background: rgba(248, 81, 73, 0.1);
  }

  /* 红点设计: 紧凑、鲜艳、非文字 */
  .latest-dot {
    display: inline-block;
    color: #f85149;
    font-size: 0.85rem;
    line-height: 1;
    animation: pulse-dot 2s infinite ease-in-out;
  }
  @keyframes pulse-dot {
    0% { transform: scale(1); opacity: 0.9; }
    50% { transform: scale(1.2); opacity: 1; text-shadow: 0 0 6px rgba(248, 81, 73, 0.8); }
    100% { transform: scale(1); opacity: 0.9; }
  }

  /* IDE 分组与子端点 */
  .ide-sub-slots {
    font-size: 0.82rem;
    color: var(--text-muted);
    display: inline-flex;
    gap: 6px;
  }
  .ide-group-indicator {
    display: inline-flex;
    align-items: center;
  }

  /* UNCERTAIN 指示器 */
  .indicator-uncertain {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(210, 153, 34, 0.2);
    color: #e3b341;
    font-size: 0.8rem;
    font-weight: 500;
    border: 1px solid rgba(210, 153, 34, 0.4);
  }

  /* 相对时间 */
  .scan-cell-time {
    font-size: 0.82rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .relative-time {
    cursor: help;
  }

  /* 项目本地关注提示 */
  .scan-cell-attention {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scan-attention-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
  }
  .scan-attention-tag.attention-human {
    background: rgba(163, 113, 247, 0.2);
    border: 1px solid rgba(163, 113, 247, 0.4);
    color: #d2a8ff;
  }
  .scan-attention-tag.attention-unknown {
    background: rgba(210, 153, 34, 0.15);
    border: 1px solid rgba(210, 153, 34, 0.4);
    color: #e3b341;
  }

  .btn-xs {
    padding: 2px 6px;
    font-size: 0.75rem;
    line-height: 1.2;
    border-radius: 4px;
  }

  /* 扫描行控件 */
  .scan-cell-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn-details-toggle {
    font-size: 0.82rem;
    padding: 4px 10px;
  }

  /* 渐进式披露 Details 区域 */
  details.project-details {
    border-top: 1px solid var(--panel-border);
    background: #0d1117;
  }
  details.project-details summary {
    padding: 8px 18px;
    font-size: 0.82rem;
    color: var(--text-muted);
    cursor: pointer;
    background: #13171f;
    border-bottom: 1px solid transparent;
  }
  details.project-details[open] summary {
    border-bottom: 1px solid var(--panel-border);
    color: var(--text);
  }

  .project-details-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .endpoint-diagnostic-card {
    background: #161b22;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .endpoint-diagnostic-state {
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .details-section {
    background: #161b22;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 12px;
  }
  .section-title {
    font-size: 0.88rem;
    color: var(--text-heading);
    margin-bottom: 6px;
  }

  /* 全局诊断 Attention Tray 折叠抽屉 */
  details.diagnostics-global-tray {
    margin-top: 30px;
    border: 1px dashed var(--panel-border);
    border-radius: 8px;
    background: rgba(22, 27, 34, 0.4);
  }
  details.diagnostics-global-tray summary {
    padding: 10px 16px;
    font-size: 0.84rem;
    color: var(--text-muted);
    cursor: pointer;
  }
  .diagnostics-tray-body {
    padding: 12px 16px;
  }

  /* 实时同步与陈旧状态指示器 (#34) */
  .sync-indicator {
    font-size: 0.82rem;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: all 0.2s ease;
  }
  .sync-indicator.sync-live {
    background: rgba(46, 160, 67, 0.15);
    color: #3fb950;
    border: 1px solid rgba(46, 160, 67, 0.3);
  }
  .sync-indicator.sync-stale {
    background: rgba(218, 54, 51, 0.15);
    color: #f85149;
    border: 1px solid rgba(218, 54, 51, 0.3);
  }
  body[data-surface-stale="true"] .app-header {
    border-bottom: 2px solid #da3633;
  }
`;
