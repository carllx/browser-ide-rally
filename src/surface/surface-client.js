/**
 * 状态表面客户端交互脚本模块 (Surface Client Script)
 * 纯原生浏览器端交互逻辑，实现规范状态重载刷新与筛选状态持久化
 */

export const SURFACE_CLIENT_JS = `
  (function() {
    // 1. Mark handled 点击事件监听与 API 调用
    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action="mark-handled"]');
      if (!btn || btn.disabled) return;

      const bindingId = btn.getAttribute('data-binding-id');
      const endpointId = btn.getAttribute('data-endpoint-id');
      const rawCursorJson = btn.getAttribute('data-expected-cursor-json');

      let expectedCursor = null;
      try {
        if (rawCursorJson) {
          expectedCursor = JSON.parse(decodeURIComponent(rawCursorJson));
        }
      } catch {
        expectedCursor = btn.getAttribute('data-expected-cursor');
      }

      btn.disabled = true;
      const originalText = btn.textContent;
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
          // 标记处理后重新加载全量规范表面，避免局部 DOM 补丁导致顶部汇总指标与视图筛选脱节
          window.location.reload();
        } else {
          showToast('标记失败: ' + (result.reason || '未知错误'), true);
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        showToast('请求异常: ' + err.message, true);
        btn.disabled = false;
        btn.textContent = originalText;
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
    function applyFilter(filter) {
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-filter') === filter);
      });
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
      try {
        sessionStorage.setItem('rally_status_filter', filter);
      } catch {}
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const filter = this.getAttribute('data-filter');
        applyFilter(filter);
      });
    });

    // 页面载入时恢复先前的筛选偏好
    try {
      const savedFilter = sessionStorage.getItem('rally_status_filter');
      if (savedFilter && savedFilter !== 'all') {
        applyFilter(savedFilter);
      }
    } catch {}

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
