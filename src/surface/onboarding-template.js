/**
 * 生产引导 HTML 模板组件 (Onboarding Template)
 * 渲染 + Add Project 触发按钮与两阶段验证引导模态框
 */

export function renderAddProjectButtonHtml() {
  return `
    <button
      type="button"
      class="btn btn-primary btn-add-project"
      id="btn-open-add-project"
      aria-haspopup="dialog"
      aria-expanded="false"
      title="创建新的 Browser ↔ IDE 项目绑定">
      + Add Project
    </button>
  `;
}

export function renderAddProjectModalHtml() {
  return `
  <div id="onboarding-modal" class="modal-overlay" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="onboarding-modal-title">
    <div class="modal-card onboarding-card" style="max-width: 620px;">
      <div class="modal-header">
        <h3 id="onboarding-modal-title">添加新项目绑定 (Add Project)</h3>
        <button type="button" class="btn-close" id="onboarding-modal-close" aria-label="关闭">&times;</button>
      </div>

      <div class="modal-body" id="onboarding-modal-body">
        <div id="onboarding-error-alert" class="alert-box alert-error" style="display: none;">
          <div class="alert-title">验证未通过</div>
          <div id="onboarding-error-msg" class="alert-message"></div>
          <details id="onboarding-error-debug" style="display: none; margin-top: 8px; font-size: 12px;">
            <summary style="cursor: pointer; color: #8b949e; user-select: none;">查看技术详情 (Debug details)</summary>
            <pre id="onboarding-error-debug-content" style="margin-top: 6px; padding: 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; color: #f85149; font-family: ui-monospace, monospace;"></pre>
          </details>
        </div>

        <!-- 步骤 1：输入表单 -->
        <form id="onboarding-form" onsubmit="return false;">
          <div class="form-group" style="margin-bottom: 14px;">
            <label class="form-label" for="input-display-name">
              <strong>1. Project Display Name</strong> <span style="color: #da3633;">*</span>
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">面向人类操作者的项目显示名称（本地注册表内唯一）</div>
            </label>
            <input
              type="text"
              id="input-display-name"
              class="form-input"
              placeholder="例如：Rally Core Service"
              autocomplete="off"
              required />
          </div>

          <div class="form-group" style="margin-bottom: 14px;">
            <label class="form-label" for="input-browser-url">
              <strong>2. 完整 ChatGPT 会话 URL</strong> <span style="color: #da3633;">*</span>
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">当前已在 Google Chrome 打开的会话完整地址</div>
            </label>
            <input
              type="url"
              id="input-browser-url"
              class="form-input"
              placeholder="例如：https://chatgpt.com/c/6774a3f1-0000-..."
              autocomplete="off"
              required />
          </div>

          <div class="form-group" style="margin-bottom: 14px;">
            <label class="form-label" for="input-ide-conv-id">
              <strong>3. 精确 Antigravity 会话 ID</strong> <span style="color: #da3633;">*</span>
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">本地 IDE 对话的唯一标识（自动通过 Provider 提取工作区与仓库）</div>
            </label>
            <input
              type="text"
              id="input-ide-conv-id"
              class="form-input"
              placeholder="例如：b1b193e3-1b2d-4f5c-abee-38efb8179254"
              autocomplete="off"
              required />
          </div>
        </form>

        <!-- 步骤 2：验证预览区（初始隐藏） -->
        <div id="onboarding-preview" style="display: none;">
          <div class="preview-header-banner" style="background: rgba(46, 160, 67, 0.15); border: 1px solid #2ea043; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px;">
            <strong style="color: #3fb950;">✓ 身份核验通过</strong> — 请确认以下解析出的真实端点信息，确认后将正式创建项目绑定。
          </div>

          <div class="preview-grid" style="display: grid; gap: 12px; font-size: 13px;">
            <div class="preview-card" style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px;">
              <div style="font-weight: 600; color: #58a6ff; margin-bottom: 6px;">项目显示名称</div>
              <div id="preview-display-name" style="font-size: 14px; font-weight: bold; color: #f0f6fc;"></div>
            </div>

            <div class="preview-card" style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px;">
              <div style="font-weight: 600; color: #58a6ff; margin-bottom: 6px;">Browser 端点（已定位 Chrome 标签页）</div>
              <div><span class="meta-label">会话 ID:</span> <code id="preview-browser-conv"></code></div>
              <div style="margin-top: 4px;"><span class="meta-label">标签 URL:</span> <code id="preview-browser-url" style="word-break: break-all;"></code></div>
            </div>

            <div class="preview-card" style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px;">
              <div style="font-weight: 600; color: #58a6ff; margin-bottom: 6px;">IDE 端点（Antigravity Provider 自动派生）</div>
              <div><span class="meta-label">会话 ID:</span> <code id="preview-ide-conv"></code></div>
              <div style="margin-top: 4px;"><span class="meta-label">派生工作区:</span> <code id="preview-ide-workspace" class="path-code"></code></div>
              <div style="margin-top: 4px;"><span class="meta-label">派生代码仓:</span> <code id="preview-ide-repo" class="path-code"></code></div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="btn-onboarding-cancel">取消</button>
        <button type="button" class="btn btn-secondary" id="btn-onboarding-back" style="display: none;">上一步 (修改)</button>
        <button type="button" class="btn btn-primary" id="btn-onboarding-verify">Verify (核验身份)</button>
        <button type="button" class="btn btn-primary" id="btn-onboarding-create" style="display: none;">Create Project (确认创建)</button>
      </div>
    </div>
  </div>
  `;
}
