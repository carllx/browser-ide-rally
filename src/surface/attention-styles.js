/**
 * Attention Tray 专属样式模块 (Attention Tray Styles)
 *
 * 遵循模块行数上限与自然拆分准则，保持 surface-styles.js 紧凑。
 */

export const ATTENTION_TRAY_CSS = `
  .attention-tray-container {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 20px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }

  .tray-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    border-bottom: 1px solid #21262d;
    padding-bottom: 12px;
    margin-bottom: 14px;
  }

  .tray-title-group {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .tray-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: #f0f6fc;
  }

  .badge-attention-count {
    background: rgba(210, 153, 34, 0.2);
    color: #f0883e;
    border: 1px solid rgba(240, 136, 62, 0.4);
    font-weight: 600;
  }

  .tray-empty {
    padding: 18px 0;
    text-align: center;
    font-size: 0.9rem;
  }

  .tray-item-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .tray-item {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 16px;
    transition: border-color 0.15s;
  }

  .tray-item:hover {
    border-color: #58a6ff;
  }

  .tray-item.source-human_intervention {
    border-left: 4px solid #a371f7;
    background: rgba(163, 113, 247, 0.04);
  }

  .tray-item.source-endpoint {
    border-left: 4px solid #238636;
    background: rgba(46, 160, 67, 0.04);
  }

  .tray-item.source-action {
    border-left: 4px solid #da3633;
    background: rgba(218, 54, 51, 0.04);
  }

  .tray-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .tray-item-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .tray-project-title {
    font-weight: 600;
    color: #58a6ff;
  }

  .tray-item-body {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }

  .tray-item-detail {
    font-size: 0.86rem;
    color: #c9d1d9;
  }

  .tray-item-actions {
    display: flex;
    gap: 8px;
  }

  .btn-jump {
    text-decoration: none;
    color: #58a6ff;
    border-color: #388bfd;
  }

  .btn-jump:hover {
    background: rgba(56, 139, 253, 0.15);
  }

  .btn-clear-human {
    border-color: #a371f7;
    color: #d2a8ff;
  }

  .btn-clear-human:hover {
    background: rgba(163, 113, 247, 0.15);
  }

  .btn-assert-human {
    border-color: #a371f7;
    color: #d2a8ff;
  }

  .btn-assert-human:hover {
    background: rgba(163, 113, 247, 0.15);
  }

  .attention-tray-container.is-collapsed .tray-content {
    display: none;
  }
`;
