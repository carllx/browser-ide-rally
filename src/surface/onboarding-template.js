/**
 * 生产引导 HTML 模板组件 (Onboarding Template)
 * 渲染 + 添加项目 触发按钮与两阶段引导模态框
 */

export function renderAddProjectButtonHtml() {
  return `
    <button
      type="button"
      class="btn btn-primary btn-add-project"
      id="btn-open-add-project"
      aria-haspopup="dialog"
      aria-expanded="false"
      title="添加项目">
      + 添加项目
    </button>
  `;
}

export function renderAddProjectModalHtml() {
  return `
  <div id="onboarding-modal" class="modal-overlay" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="onboarding-modal-title">
    <div class="modal-card onboarding-card" style="max-width: 620px;">
      <div class="modal-header">
        <h3 id="onboarding-modal-title">添加项目</h3>
        <button type="button" class="btn-close" id="onboarding-modal-close" aria-label="关闭">&times;</button>
      </div>

      <div class="modal-body" id="onboarding-modal-body">
        <div id="onboarding-error-alert" class="alert-box alert-error" style="display: none;">
          <div class="alert-title">检查未通过</div>
          <div id="onboarding-error-msg" class="alert-message"></div>
          <details id="onboarding-error-debug" style="display: none; margin-top: 8px; font-size: 12px;">
            <summary style="cursor: pointer; color: #8b949e; user-select: none;">查看技术详情</summary>
            <pre id="onboarding-error-debug-content" style="margin-top: 6px; padding: 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; color: #f85149; font-family: ui-monospace, monospace;"></pre>
          </details>
        </div>

        <!-- 步骤 1：输入表单 -->
        <form id="onboarding-form" onsubmit="return false;">
          <div class="form-group" style="margin-bottom: 14px;">
            <label class="form-label" for="input-display-name">
              <strong>1. 项目名称</strong> <span style="color: #da3633;">*</span>
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">项目在看板中的显示名称</div>
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
              <strong>2. ChatGPT 对话网址</strong> <span style="color: #da3633;">*</span>
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">浏览器中打开的 ChatGPT 会话完整网址</div>
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
              <strong>3. Antigravity 会话标识</strong> <span style="color: #da3633;">*</span>
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">本地 Antigravity 对话标识符</div>
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
            <strong style="color: #3fb950;">✓ 对话信息已确认</strong> — 请核对项目名称，确认后将正式创建项目。
          </div>

          <div class="preview-grid" style="display: grid; gap: 12px; font-size: 13px;">
            <div class="preview-card" style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px;">
              <div style="font-weight: 600; color: #58a6ff; margin-bottom: 6px;">项目名称</div>
              <div id="preview-display-name" style="font-size: 14px; font-weight: bold; color: #f0f6fc;"></div>
            </div>

            <div class="preview-card" style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px;">
              <div style="font-weight: 600; color: #3fb950; margin-bottom: 4px;">✓ ChatGPT 对话已确认</div>
              <div class="text-muted" style="font-size: 12px;">已成功定位浏览器标签页与目标对话</div>
            </div>

            <div class="preview-card" style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px;">
              <div style="font-weight: 600; color: #3fb950; margin-bottom: 4px;">✓ IDE 对话已确认</div>
              <div class="text-muted" style="font-size: 12px;">已成功关联本地工作区与仓库环境</div>
            </div>
          </div>

          <details class="preview-diagnostics" style="margin-top: 12px; font-size: 12px;">
            <summary style="cursor: pointer; color: #8b949e; user-select: none;">查看技术详情</summary>
            <div class="preview-diagnostics-body" style="margin-top: 8px; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; display: grid; gap: 6px;">
              <div><span class="meta-label">ChatGPT 会话 ID:</span> <code id="preview-browser-conv"></code></div>
              <div><span class="meta-label">ChatGPT 网址:</span> <code id="preview-browser-url" style="word-break: break-all;"></code></div>
              <div><span class="meta-label">IDE 会话 ID:</span> <code id="preview-ide-conv"></code></div>
              <div><span class="meta-label">派生工作区:</span> <code id="preview-ide-workspace" class="path-code"></code></div>
              <div><span class="meta-label">派生代码仓:</span> <code id="preview-ide-repo" class="path-code"></code></div>
            </div>
          </details>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="btn-onboarding-cancel">取消</button>
        <button type="button" class="btn btn-secondary" id="btn-onboarding-back" style="display: none;">返回修改</button>
        <button type="button" class="btn btn-primary" id="btn-onboarding-verify">检查</button>
        <button type="button" class="btn btn-primary" id="btn-onboarding-create" style="display: none;">创建项目</button>
      </div>
    </div>
  </div>
  `;
}
