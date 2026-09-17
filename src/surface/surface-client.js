/**
 * 状态表面客户端交互脚本模块 (Surface Client Script)
 * 纯原生浏览器端交互逻辑，实现无重置就地更新与防类型丢失传参
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

          // 就地更新对应端点 DOM，保持当前筛选和折叠状态不被重置
          const card = btn.closest('.endpoint-card');
          if (card) {
            const badgeContainer = card.querySelector('.endpoint-header > div:last-child');
            if (badgeContainer) {
              badgeContainer.innerHTML = '<span class="badge badge-caught-up" role="status" aria-label="无新结果">NO_NEW_RESULT</span>';
            }
            const handledSpan = card.querySelector('.meta-handled-cursor');
            if (handledSpan) {
              handledSpan.textContent = String(result.handled_cursor ?? '(无)');
            }
            btn.disabled = true;
            btn.textContent = 'Mark handled';
            btn.title = '仅在端点处于 NEW 时可处理';
          }
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
