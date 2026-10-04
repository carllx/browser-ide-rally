/**
 * 客户端项目移出交互脚本 (Project Removal Client)
 * 遵循 Issue #36 契约：
 * 1. 位于 progressive disclosure / project details 内部；
 * 2. 人类语言操作：“移出项目”；
 * 3. 非破坏性证据留存，不增加习惯性破坏弹窗；
 * 4. 成功后触发拓扑刷新/收敛。
 */

export const PROJECT_REMOVAL_CLIENT_JS = `
  (function() {
    function getSessionHeaders() {
      const tokenMeta = document.querySelector('meta[name="rally-session-token"]');
      const token = tokenMeta ? tokenMeta.getAttribute('content') : '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['X-Rally-Session-Token'] = token;
      }
      return headers;
    }

    async function triggerRefreshOrReload() {
      if (typeof window.__triggerSurfaceRefresh === 'function') {
        try {
          await window.__triggerSurfaceRefresh();
        } catch (_) {
          window.location.reload();
        }
      } else {
        window.location.reload();
      }
    }

    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action="remove-project"]');
      if (!btn || btn.disabled) return;

      const bindingId = btn.getAttribute('data-binding-id');
      const bindingRev = parseInt(btn.getAttribute('data-binding-revision'), 10);
      if (!bindingId || isNaN(bindingRev)) return;

      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '正在移出...';

      try {
        const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/remove', {
          method: 'POST',
          headers: getSessionHeaders(),
          body: JSON.stringify({
            expected_binding_revision: bindingRev
          })
        });

        const data = await resp.json().catch(function() { return {}; });

        if (resp.ok && data.success) {
          if (typeof window.__showToast === 'function') {
            window.__showToast(data.message || '项目已移出活跃工作区');
          }
          await triggerRefreshOrReload();
        } else {
          const reason = data.reason || '移出操作未能完成，请刷新后重试';
          if (typeof window.__showToast === 'function') {
            window.__showToast(reason, true);
          }
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        if (typeof window.__showToast === 'function') {
          window.__showToast('网络请求异常，请稍后重试', true);
        }
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  })();
`;
