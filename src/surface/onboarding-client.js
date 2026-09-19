/**
 * 生产引导客户端脚本模块 (Onboarding Client Script)
 * 处理 + Add Project 弹窗、两阶段核验提交、身份预览展示与实时创建
 */

export const ONBOARDING_CLIENT_JS = `
  (function() {
    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;

    const btnOpen = document.getElementById('btn-open-add-project');
    const btnClose = document.getElementById('onboarding-modal-close');
    const btnCancel = document.getElementById('btn-onboarding-cancel');
    const btnBack = document.getElementById('btn-onboarding-back');
    const btnVerify = document.getElementById('btn-onboarding-verify');
    const btnCreate = document.getElementById('btn-onboarding-create');

    const formEl = document.getElementById('onboarding-form');
    const previewEl = document.getElementById('onboarding-preview');
    const errorAlert = document.getElementById('onboarding-error-alert');
    const errorMsg = document.getElementById('onboarding-error-msg');

    const inputDisplayName = document.getElementById('input-display-name');
    const inputBrowserUrl = document.getElementById('input-browser-url');
    const inputIdeConvId = document.getElementById('input-ide-conv-id');

    const previewDisplayName = document.getElementById('preview-display-name');
    const previewBrowserConv = document.getElementById('preview-browser-conv');
    const previewBrowserUrl = document.getElementById('preview-browser-url');
    const previewIdeConv = document.getElementById('preview-ide-conv');
    const previewIdeWorkspace = document.getElementById('preview-ide-workspace');
    const previewIdeRepo = document.getElementById('preview-ide-repo');

    function showError(msg) {
      if (!errorAlert || !errorMsg) return;
      errorMsg.textContent = msg;
      errorAlert.style.display = 'block';
    }

    function clearError() {
      if (!errorAlert || !errorMsg) return;
      errorMsg.textContent = '';
      errorAlert.style.display = 'none';
    }

    function resetModal() {
      clearError();
      if (formEl) formEl.style.display = 'block';
      if (previewEl) previewEl.style.display = 'none';
      if (btnVerify) {
        btnVerify.style.display = 'inline-block';
        btnVerify.disabled = false;
        btnVerify.textContent = 'Verify (核验身份)';
      }
      if (btnCreate) {
        btnCreate.style.display = 'none';
        btnCreate.disabled = false;
        btnCreate.textContent = 'Create Project (确认创建)';
      }
      if (btnBack) btnBack.style.display = 'none';
      if (btnCancel) btnCancel.style.display = 'inline-block';
    }

    function openModal() {
      resetModal();
      modal.style.display = 'flex';
      if (inputDisplayName) inputDisplayName.focus();
    }

    function closeModal() {
      modal.style.display = 'none';
      resetModal();
    }

    if (btnOpen) {
      btnOpen.addEventListener('click', openModal);
    }
    if (btnClose) {
      btnClose.addEventListener('click', closeModal);
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', closeModal);
    }

    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        closeModal();
      }
    });

    if (btnBack) {
      btnBack.addEventListener('click', function() {
        clearError();
        if (formEl) formEl.style.display = 'block';
        if (previewEl) previewEl.style.display = 'none';
        btnVerify.style.display = 'inline-block';
        btnCreate.style.display = 'none';
        btnBack.style.display = 'none';
        btnCancel.style.display = 'inline-block';
      });
    }

    // 第一步：点击 Verify
    if (btnVerify) {
      btnVerify.addEventListener('click', async function() {
        clearError();
        const displayName = inputDisplayName ? inputDisplayName.value.trim() : '';
        const browserUrl = inputBrowserUrl ? inputBrowserUrl.value.trim() : '';
        const ideConvId = inputIdeConvId ? inputIdeConvId.value.trim() : '';

        if (!displayName) {
          showError('请填写 Project Display Name。');
          if (inputDisplayName) inputDisplayName.focus();
          return;
        }
        if (!browserUrl) {
          showError('请填写完整 ChatGPT 会话 URL。');
          if (inputBrowserUrl) inputBrowserUrl.focus();
          return;
        }
        if (!ideConvId) {
          showError('请填写精确 Antigravity 会话 ID。');
          if (inputIdeConvId) inputIdeConvId.focus();
          return;
        }

        btnVerify.disabled = true;
        const origText = btnVerify.textContent;
        btnVerify.textContent = '正在核验身份...';

        try {
          const resp = await fetch('/api/onboarding/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              display_name: displayName,
              browser_url: browserUrl,
              ide_conversation_id: ideConvId
            })
          });

          const result = await resp.json();
          if (resp.ok && result.success && result.preview) {
            const p = result.preview;
            if (previewDisplayName) previewDisplayName.textContent = p.display_name;
            if (previewBrowserConv) previewBrowserConv.textContent = p.browser.conversation_id;
            if (previewBrowserUrl) previewBrowserUrl.textContent = p.browser.tab_url;
            if (previewIdeConv) previewIdeConv.textContent = p.ide.conversation_id;
            if (previewIdeWorkspace) previewIdeWorkspace.textContent = p.ide.workspace_identity;
            if (previewIdeRepo) previewIdeRepo.textContent = p.ide.repository_identity;

            if (formEl) formEl.style.display = 'none';
            if (previewEl) previewEl.style.display = 'block';

            btnVerify.style.display = 'none';
            btnCreate.style.display = 'inline-block';
            btnBack.style.display = 'inline-block';
            btnCancel.style.display = 'none';
          } else {
            showError(result.reason || result.error || '核验未通过，请检查输入并重试。');
          }
        } catch (err) {
          showError('请求异常: ' + err.message);
        } finally {
          btnVerify.disabled = false;
          btnVerify.textContent = origText;
        }
      });
    }

    // 第二步：点击 Create Project
    if (btnCreate) {
      btnCreate.addEventListener('click', async function() {
        clearError();
        const displayName = inputDisplayName ? inputDisplayName.value.trim() : '';
        const browserUrl = inputBrowserUrl ? inputBrowserUrl.value.trim() : '';
        const ideConvId = inputIdeConvId ? inputIdeConvId.value.trim() : '';

        btnCreate.disabled = true;
        const origText = btnCreate.textContent;
        btnCreate.textContent = '正在创建并落盘...';

        try {
          const resp = await fetch('/api/onboarding/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              display_name: displayName,
              browser_url: browserUrl,
              ide_conversation_id: ideConvId
            })
          });

          const result = await resp.json();
          if (resp.ok && result.success) {
            closeModal();
            const toast = document.getElementById('toast-msg');
            if (toast) {
              toast.textContent = '✓ 成功创建项目绑定: ' + displayName;
              toast.style.background = '#238636';
              toast.style.display = 'block';
            }
            setTimeout(() => {
              window.location.reload();
            }, 500);
          } else {
            showError(result.reason || result.error || '创建项目失败，请重试。');
            btnCreate.disabled = false;
            btnCreate.textContent = origText;
          }
        } catch (err) {
          showError('请求异常: ' + err.message);
          btnCreate.disabled = false;
          btnCreate.textContent = origText;
        }
      });
    }
  })();
`;
