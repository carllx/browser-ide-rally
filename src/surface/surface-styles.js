/**
 * 状态表面样式与客户端脚本资源模块 (Surface Styles & Client Script)
 * 提供紧凑现代的暗色主题样式及无状态纯客户端交互脚本
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
    justify-content: flex-end;
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

export const SURFACE_CLIENT_JS = `
  (function() {
    // 1. Mark handled 点击事件监听与 API 调用
    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action="mark-handled"]');
      if (!btn || btn.disabled) return;

      const bindingId = btn.getAttribute('data-binding-id');
      const endpointId = btn.getAttribute('data-endpoint-id');
      const expectedCursor = btn.getAttribute('data-expected-cursor');

      btn.disabled = true;
      btn.textContent = '处理中...';

      try {
        const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/endpoints/' + encodeURIComponent(endpointId) + '/handled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expected_cursor: expectedCursor })
        });
        const result = await resp.json();
        if (resp.ok && result.success) {
          showToast('已成功标记处理: ' + bindingId + ' / ' + endpointId);
          setTimeout(() => window.location.reload(), 300);
        } else {
          showToast('标记失败: ' + (result.reason || '未知错误'), true);
          btn.disabled = false;
          btn.textContent = 'Mark handled';
        }
      } catch (err) {
        showToast('请求异常: ' + err.message, true);
        btn.disabled = false;
        btn.textContent = 'Mark handled';
      }
    });

    // 2. 纯客户端表现层控制：展开与折叠（绝不向后端发送请求）
    document.addEventListener('click', function(e) {
      const toggleBtn = e.target.closest('button[data-action="toggle-expand"]');
      if (!toggleBtn) return;
      const card = toggleBtn.closest('.project-card');
      if (!card) return;
      card.classList.toggle('is-collapsed');
      const isCollapsed = card.classList.contains('is-collapsed');
      toggleBtn.setAttribute('aria-expanded', !isCollapsed);
    });

    // 3. 纯客户端表现层控制：筛选器（绝不修改规范状态）
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const filter = this.getAttribute('data-filter');
        const cards = document.querySelectorAll('.project-card');

        cards.forEach(card => {
          if (filter === 'all') {
            card.style.display = '';
          } else if (filter === 'new') {
            const hasNew = card.querySelector('.badge-new') !== null;
            card.style.display = hasNew ? '' : 'none';
          } else if (filter === 'unknown') {
            const hasUnknown = card.querySelector('.badge-unknown') !== null;
            card.style.display = hasUnknown ? '' : 'none';
          }
        });
      });
    });

    function showToast(msg, isError) {
      const toast = document.getElementById('toast-msg');
      if (!toast) return;
      toast.textContent = msg;
      toast.style.background = isError ? '#da3633' : '#238636';
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }
  })();
`;
