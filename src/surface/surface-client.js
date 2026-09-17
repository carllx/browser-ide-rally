/**
 * 状态表面客户端交互脚本模块 (Surface Client Script)
 * 纯原生浏览器端交互逻辑，实现规范状态重载刷新与筛选状态持久化
 */

export const SURFACE_CLIENT_JS = `
  (function() {
    function showToast(msg, isError) {
      const toast = document.getElementById('toast-msg');
      if (!toast) return;
      toast.textContent = msg;
      toast.style.background = isError ? '#da3633' : '#238636';
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3500);
    }

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

    // 2. Open / Focus 点击事件
    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action="open-focus"]');
      if (!btn || btn.disabled) return;

      const bindingId = btn.getAttribute('data-binding-id');
      const bindingRev = parseInt(btn.getAttribute('data-binding-revision'), 10);
      const endpointId = btn.getAttribute('data-endpoint-id');

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '聚焦中...';

      try {
        const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/controls/open-focus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expected_binding_revision: bindingRev,
            target_endpoint: endpointId
          })
        });
        const result = await resp.json();
        if (resp.ok && result.success) {
          showToast('已成功聚焦端点: ' + endpointId);
          window.location.reload();
        } else {
          showToast('聚焦失败 [' + (result.stage || 'BLOCKED') + ']: ' + (result.reason || '版本失配或目标异常'), true);
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        showToast('请求异常: ' + err.message, true);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });

    // 3. 模态框与 Rebind / Send 操作
    const modal = document.getElementById('control-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalSubmit = document.getElementById('modal-submit');

    let currentModalAction = null;

    function closeModal() {
      if (modal) modal.style.display = 'none';
      currentModalAction = null;
      if (modalSubmit) {
        modalSubmit.disabled = false;
        modalSubmit.textContent = '确认执行';
      }
    }
    if (modalClose) modalClose.addEventListener('click', closeModal);
    if (modalCancel) modalCancel.addEventListener('click', closeModal);

    // Rebind 点击
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-action="rebind"]');
      if (!btn) return;
      const bindingId = btn.getAttribute('data-binding-id');
      const bindingRev = parseInt(btn.getAttribute('data-binding-revision'), 10);
      const endpointId = btn.getAttribute('data-endpoint-id');
      const role = btn.getAttribute('data-role');
      const curConv = btn.getAttribute('data-conversation-id');
      const curBranch = btn.getAttribute('data-branch');
      const curWs = btn.getAttribute('data-workspace');
      const curRepo = btn.getAttribute('data-repo');

      modalTitle.textContent = '安全重绑端点 [' + endpointId + '] (rev ' + bindingRev + ')';
      let extraFields = '';
      if (role === 'browser') {
        extraFields = '<div class="form-group"><label>分支 (Branch，留空清除):</label><input type="text" id="m-branch" class="form-control" value="' + (curBranch || '') + '" /></div>';
      } else {
        extraFields = '<div class="form-group"><label>工作区路径 (Workspace):</label><input type="text" id="m-ws" class="form-control" value="' + (curWs || '') + '" /></div>' +
                      '<div class="form-group"><label>代码仓库 (Repository):</label><input type="text" id="m-repo" class="form-control" value="' + (curRepo || '') + '" /></div>';
      }

      modalBody.innerHTML = 
        '<div class="form-group"><label>目标端点:</label><input type="text" class="form-control" value="' + endpointId + '" disabled /></div>' +
        '<div class="form-group"><label>新会话 ID (Conversation ID):</label><input type="text" id="m-conv-id" class="form-control" value="' + (curConv || '') + '" placeholder="必填会话 ID" /></div>' +
        extraFields +
        '<div class="form-group"><label><input type="checkbox" id="m-allow-unhandled" /> 强制替换未处理 NEW 事实</label></div>' +
        '<div class="form-group"><label><input type="checkbox" id="m-allow-unknown" /> 确认替换处于 UNKNOWN 的端点</label></div>';

      currentModalAction = async function() {
        const convId = (document.getElementById('m-conv-id')?.value || '').trim();
        if (!convId) {
          showToast('必须提供有效的会话 ID', true);
          return;
        }
        const newIdentity = { conversation_id: convId };
        if (role === 'browser') {
          const branchInput = document.getElementById('m-branch');
          newIdentity.branch = branchInput && branchInput.value.trim() ? branchInput.value.trim() : null;
        } else {
          newIdentity.workspace = document.getElementById('m-ws')?.value.trim() || '';
          newIdentity.repository = document.getElementById('m-repo')?.value.trim() || '';
        }

        const allowUnhandled = !!document.getElementById('m-allow-unhandled')?.checked;
        const allowUnknown = !!document.getElementById('m-allow-unknown')?.checked;

        modalSubmit.disabled = true;
        modalSubmit.textContent = '提交中...';

        try {
          const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/controls/rebind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expected_binding_revision: bindingRev,
              target_endpoint: endpointId,
              new_identity: newIdentity,
              allow_replace_unhandled: allowUnhandled,
              allow_replace_unknown: allowUnknown
            })
          });
          const result = await resp.json();
          if (resp.ok && result.success) {
            showToast('端点重绑成功');
            closeModal();
            window.location.reload();
          } else {
            showToast('重绑受阻 [' + (result.stage || 'BLOCKED') + ']: ' + (result.reason || '未知原因'), true);
            modalSubmit.disabled = false;
            modalSubmit.textContent = '确认执行';
          }
        } catch (err) {
          showToast('请求异常: ' + err.message, true);
          modalSubmit.disabled = false;
          modalSubmit.textContent = '确认执行';
        }
      };

      modal.style.display = 'flex';
    });

    // Safe Send 点击
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-action="safe-send"]');
      if (!btn) return;
      const bindingId = btn.getAttribute('data-binding-id');
      const bindingRev = parseInt(btn.getAttribute('data-binding-revision'), 10);
      const endpointId = btn.getAttribute('data-endpoint-id');

      modalTitle.textContent = '安全发送受控 Envelope [' + endpointId + '] (rev ' + bindingRev + ')';
      modalBody.innerHTML = 
        '<div class="form-group"><label>目标端点:</label><input type="text" class="form-control" value="' + endpointId + '" disabled /></div>' +
        '<div class="form-group"><label>操作 (Allowlisted Op):</label><select id="m-send-op" class="form-control"><option value="rally.prompt">rally.prompt (标准提示指令)</option><option value="rally.inspect">rally.inspect (状态探针检查)</option><option value="rally.echo">rally.echo (回显自测)</option></select></div>' +
        '<div class="form-group"><label>Envelope Body / 内容:</label><textarea id="m-send-body" class="form-control" rows="4" placeholder="输入要发送给目标端点的指令或文本内容..."></textarea></div>';

      currentModalAction = async function() {
        const op = document.getElementById('m-send-op')?.value || 'rally.prompt';
        const bodyText = (document.getElementById('m-send-body')?.value || '').trim();
        if (!bodyText) {
          showToast('发送内容不能为空', true);
          return;
        }

        modalSubmit.disabled = true;
        modalSubmit.textContent = '发送中...';

        try {
          const resp = await fetch('/api/projects/' + encodeURIComponent(bindingId) + '/controls/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expected_binding_revision: bindingRev,
              target_endpoint: endpointId,
              envelope: {
                op: op,
                payload: { text: bodyText }
              }
            })
          });
          const result = await resp.json();
          if (resp.ok && result.success) {
            showToast('动作已提交: ' + result.stage);
            closeModal();
            window.location.reload();
          } else {
            showToast('发送失败 [' + (result.stage || 'BLOCKED') + ']: ' + (result.reason || '未知错误'), true);
            modalSubmit.disabled = false;
            modalSubmit.textContent = '确认执行';
          }
        } catch (err) {
          showToast('请求异常: ' + err.message, true);
          modalSubmit.disabled = false;
          modalSubmit.textContent = '确认执行';
        }
      };

      modal.style.display = 'flex';
    });

    if (modalSubmit) {
      modalSubmit.addEventListener('click', function() {
        if (typeof currentModalAction === 'function') {
          currentModalAction();
        }
      });
    }

    // 4. 纯客户端表现层控制：展开与折叠（绝不向后端发送请求）
    document.addEventListener('click', function(e) {
      const toggleBtn = e.target.closest('button[data-action="toggle-expand"]');
      if (!toggleBtn) return;
      const card = toggleBtn.closest('.project-card');
      if (!card) return;
      card.classList.toggle('is-collapsed');
      const isCollapsed = card.classList.contains('is-collapsed');
      toggleBtn.setAttribute('aria-expanded', !isCollapsed);
    });

    // 5. 纯客户端表现层控制：筛选器（绝不修改规范状态）
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
  })();
`;
