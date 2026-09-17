/**
 * 状态表面样式模块 (Surface Styles)
 * 提供紧凑现代的暗色主题样式定义
 */

export const SURFACE_CSS = `
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-border: #30363d;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --text-heading: #f0f6fc;
    --accent: #58a6ff;
    --new-green: #238636;
    --new-green-bg: rgba(46, 160, 67, 0.15);
    --unknown-amber: #d29922;
    --unknown-amber-bg: rgba(210, 153, 34, 0.15);
    --human-purple: #a371f7;
    --human-purple-bg: rgba(163, 113, 247, 0.15);
    --caught-up-blue: #388bfd;
    --caught-up-blue-bg: rgba(56, 139, 253, 0.15);
    --btn-bg: #21262d;
    --btn-border: #363b42;
    --btn-hover: #30363d;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background-color: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding-bottom: 60px;
  }

  header.app-header {
    background: var(--panel);
    border-bottom: 1px solid var(--panel-border);
    padding: 16px 28px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }

  .app-title-group h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-heading);
  }
  .app-subtitle {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .status-summary-bar {
    display: flex;
    gap: 16px;
    font-size: 0.88rem;
  }

  .filter-bar {
    max-width: 1280px;
    margin: 18px auto 0 auto;
    padding: 0 20px;
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .filter-btn {
    background: var(--btn-bg);
    border: 1px solid var(--btn-border);
    color: var(--text);
    padding: 5px 12px;
    font-size: 0.85rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .filter-btn.active {
    background: var(--accent);
    color: #0d1117;
    border-color: var(--accent);
    font-weight: 600;
  }

  main.surface-container {
    max-width: 1280px;
    margin: 16px auto;
    padding: 0 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .project-card {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .project-card.is-collapsed .project-content {
    display: none;
  }

  .project-header {
    padding: 14px 20px;
    background: #1c2128;
    border-bottom: 1px solid var(--panel-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .project-identity {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .project-title {
    font-size: 1.1rem;
    color: var(--text-heading);
    font-family: monospace;
  }

  .project-content {
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .endpoints-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
  }

  .endpoint-card {
    background: #0d1117;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .endpoint-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 8px;
    border-bottom: 1px solid #21262d;
  }
  .endpoint-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.95rem;
    color: var(--text-heading);
  }

  .identity-line {
    font-size: 0.85rem;
    margin-bottom: 4px;
    word-break: break-all;
  }
  .meta-label {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .path-code {
    font-size: 0.82rem;
    color: #7ee787;
  }

  .endpoint-meta-grid {
    margin-top: 6px;
    font-size: 0.82rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    background: #161b22;
    padding: 8px;
    border-radius: 4px;
  }

  .endpoint-action-bar {
    margin-top: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .control-btn-group {
    display: inline-flex;
    gap: 6px;
  }

  .btn-control {
    padding: 3px 8px;
    font-size: 0.78rem;
    border-radius: 4px;
  }
  .btn-focus {
    border-color: #388bfd;
    color: #58a6ff;
  }
  .btn-focus:hover:not(:disabled) {
    background: rgba(56, 139, 253, 0.15);
  }
  .btn-rebind {
    border-color: #d29922;
    color: #e3b341;
  }
  .btn-rebind:hover:not(:disabled) {
    background: rgba(210, 153, 34, 0.15);
  }
  .btn-send {
    border-color: #a371f7;
    color: #d2a8ff;
  }
  .btn-send:hover:not(:disabled) {
    background: rgba(163, 113, 247, 0.15);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.84rem;
    font-weight: 500;
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    transition: background-color 0.15s;
  }
  .btn:hover:not(:disabled) {
    background: var(--btn-hover);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-handled {
    background: #238636;
    border-color: #2ea043;
    color: #fff;
  }
  .btn-handled:hover:not(:disabled) {
    background: #2ea043;
  }
  .btn-handled:disabled {
    background: #21262d;
    border-color: #363b42;
    color: #6e7681;
  }

  .badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 12px;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }
  .badge-new {
    background: var(--new-green-bg);
    color: #3fb950;
    border: 1px solid #238636;
  }
  .badge-caught-up {
    background: var(--caught-up-blue-bg);
    color: #58a6ff;
    border: 1px solid #1f6feb;
  }
  .badge-unknown {
    background: var(--unknown-amber-bg);
    color: #d29922;
    border: 1px solid #9e6a03;
  }
  .badge-human {
    background: var(--human-purple-bg);
    color: #d2a8ff;
    border: 1px solid #8957e5;
  }
  .badge-rev, .badge-paused {
    background: #21262d;
    color: var(--text-muted);
    border: 1px solid var(--panel-border);
  }
  .badge-paused {
    color: #f85149;
    border-color: #da3633;
  }
  .ep-rev-badge {
    font-size: 0.72rem;
    color: var(--text-muted);
    background: #21262d;
    padding: 1px 6px;
    border-radius: 4px;
  }

  .tag-anti-confusion {
    background: #2a1f0a;
    color: #e3b341;
    border: 1px solid #d29922;
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
  }

  .plane-section {
    background: #0d1117;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 0.88rem;
  }
  .human-intervention-active {
    border-left: 4px solid var(--human-purple);
    background: rgba(163, 113, 247, 0.08);
  }
  .plane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .meta-time {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .actions-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
    margin-top: 6px;
  }
  .actions-table th, .actions-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
    text-align: left;
  }
  .actions-table th {
    color: var(--text-muted);
    font-weight: 500;
  }
  .badge-stage {
    font-size: 0.72rem;
  }
  .stage-REQUESTED { background: rgba(56, 139, 253, 0.15); color: #58a6ff; }
  .stage-SUBMITTED_LOCALLY { background: rgba(210, 153, 34, 0.15); color: #d29922; }
  .stage-ACCEPTED_OR_DELIVERED { background: rgba(46, 160, 67, 0.15); color: #3fb950; }
  .stage-TARGET_COMPLETED { background: rgba(163, 113, 247, 0.15); color: #d2a8ff; }
  .stage-BLOCKED { background: rgba(248, 81, 73, 0.15); color: #f85149; border: 1px solid #da3633; }
  .stage-FAILED { background: rgba(248, 81, 73, 0.25); color: #ff7b72; border: 1px solid #f85149; }
  .stage-UNKNOWN { background: rgba(210, 153, 34, 0.15); color: #d29922; border: 1px solid #9e6a03; }

  .action-reason {
    font-size: 0.78rem;
    color: #f85149;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
  }
  .modal-card {
    background: #161b22;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    width: 480px;
    max-width: 90vw;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .modal-header {
    padding: 14px 18px;
    border-bottom: 1px solid var(--panel-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modal-header h3 {
    font-size: 1rem;
    color: var(--text-heading);
  }
  .btn-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 1.4rem;
    cursor: pointer;
    line-height: 1;
  }
  .modal-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .modal-footer {
    padding: 12px 18px;
    border-top: 1px solid var(--panel-border);
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .form-group label {
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .form-control {
    background: #0d1117;
    border: 1px solid var(--panel-border);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.86rem;
    font-family: inherit;
  }
  .form-control:focus {
    outline: none;
    border-color: var(--accent);
  }
  .form-hint {
    font-size: 0.76rem;
    color: var(--text-muted);
  }

  #toast-msg {
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 10px 16px;
    border-radius: 6px;
    background: #1f6feb;
    color: #fff;
    font-size: 0.85rem;
    display: none;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    z-index: 1000;
  }
`;
