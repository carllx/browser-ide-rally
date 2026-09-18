/**
 * Attention Tray 与 Human Intervention 客户端交互脚本
 *
 * 领域不变式与规范准则 (#20):
 * 1. 展开/折叠仅为浏览器 DOM 本地表现层状态，绝不持久化亦不修改规范事实；
 * 2. 人工介入声明与清除必须携带当前界面的 expected_binding_revision；
 * 3. 失败时展示服务端返回的原因或版本失配提示，不静默覆盖；
 * 4. 保持轻量高内聚，独立于核心 surface-client.js。
 */

export const ATTENTION_CLIENT_JS = `
  (function() {
    // 1. Attention Tray 展开 / 折叠客户端控制 (表现层状态，绝不修改规范事实)
    document.addEventListener('click', function(e) {
      const toggleBtn = e.target.closest('button[data-action="toggle-tray-expand"]');
      if (!toggleBtn) return;
      const container = toggleBtn.closest('.attention-tray-container');
      if (!container) return;
      container.classList.toggle('is-collapsed');
      const isCollapsed = container.classList.contains('is-collapsed');
      toggleBtn.setAttribute('aria-expanded', !isCollapsed);
    });

    // 2. Human Intervention Assert 点击事件 (弹出模态框填写 reason 并提交)
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-action="assert-human-intervention"]');
      if (!btn) return;
      const bindingId = btn.getAttribute('data-binding-id');
      const bindingRev = parseInt(btn.getAttribute('data-binding-revision'), 10);

      const title = '声明人工介入 [' + bindingId + '] (rev ' + bindingRev + ')';
      const bodyHtml = '<div class="form-group"><label>介入原因 (Reason):</label><input type="text" id="m-human-reason" class="form-control" placeholder="例如：需用户确认架构方案或提供敏感秘钥" /></div>';

      const actionFn = async function() {
        const modalSubmit = document.getElementById('modal-submit');
        const reasonInput = document.getElementById('m-human-reason');
        const reason = reasonInput ? reasonInput.value.trim() : '';
        if (!reason) {
          if (window.__showToast) window.__showToast('请输入人工介入原因', true);
          return;
        }

        if (modalSubmit) {
          modalSubmit.disabled = true;
          modalSubmit.textContent = '提交中...';
        }

        try {
          const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/human-intervention/assert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expected_binding_revision: bindingRev,
              reason: reason
            })
          });
          const result = await resp.json();
          if (resp.ok && result.success) {
            if (window.__closeControlModal) window.__closeControlModal();
            if (window.__showToast) window.__showToast('已成功声明人工介入: ' + bindingId);
            window.location.reload();
          } else {
            if (window.__showToast) window.__showToast('声明失败: ' + (result.reason || '版本失配'), true);
            if (modalSubmit) {
              modalSubmit.disabled = false;
              modalSubmit.textContent = '确认执行';
            }
          }
        } catch (err) {
          if (window.__showToast) window.__showToast('请求异常: ' + err.message, true);
          if (modalSubmit) {
            modalSubmit.disabled = false;
            modalSubmit.textContent = '确认执行';
          }
        }
      };

      if (window.__openControlModal) {
        window.__openControlModal(title, bodyHtml, actionFn);
      }
    });

    // 3. Human Intervention Clear 点击事件
    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action="clear-human-intervention"]');
      if (!btn || btn.disabled) return;

      const bindingId = btn.getAttribute('data-binding-id');
      const bindingRev = parseInt(btn.getAttribute('data-binding-revision'), 10);

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '清除中...';

      try {
        const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/human-intervention/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expected_binding_revision: bindingRev
          })
        });
        const result = await resp.json();
        if (resp.ok && result.success) {
          if (window.__showToast) window.__showToast('已成功清除人工介入: ' + bindingId);
          window.location.reload();
        } else {
          if (window.__showToast) window.__showToast('清除失败: ' + (result.reason || '版本失配'), true);
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        if (window.__showToast) window.__showToast('请求异常: ' + err.message, true);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  })();
`;
