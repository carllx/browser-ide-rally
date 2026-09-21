/**
 * ChatGPT Chrome Browser Adapter
 * 
 * 职责：
 * 1. 精确解析与唯一定位绑定的 ChatGPT 会话标签页（0 匹配或多匹配严格 fail-closed）；
 * 2. 在 DOM 探测执行瞬间原子化重新核验标签页会话归属（防御 TOCTOU / 标签页导航与切换漂移）；
 * 3. 观察目标标签页的 DOM 生命周期状态（stop-button 生成状态、非占位 Assistant 完成轮次）；
 * 4. 提取最终非占位完成 Assistant 消息 ID，严格过滤空值、placeholder-* 以及实机验证的 request-placeholder-*；
 * 5. 将合法完成 ID 转换为 Core 所需的不透明游标 (opaque cursor)；
 * 6. 正常 generation-in-progress 作为运行时暂态处理，绝非连续性中断（continuity_lost），不得将已有 NEW/NO_NEW_RESULT 冲刷为 UNKNOWN；
 * 7. 任何归属模糊、DOM 漂移、无法解析等真正异常，均 fail-closed 产出非受信或 UNKNOWN；
 * 8. 支持有界执行超时与非突变性 (Blocker B & Delta 5: observeBrowserEndpointAsync)。
 * 
 * 严格边界：
 * - 不包含任何 Relay send 路径、不修改 DOM、不夺取系统焦点；
 * - DOM 选择器、message-id 与标签页细节全部内聚在此适配器中，Core 仅接收 opaque cursor 与 normalized facts。
 */

import {
  defaultAppleScriptExecutor,
  defaultAsyncAppleScriptExecutor,
  isTimeoutError,
  getConversationUrlPattern,
  isExactConversationUrl,
  isPlaceholderMessageId,
  buildTabLocationScript,
  parseTabLocationOutput,
  buildRunTabJSScript,
  buildProbeScript,
  normalizeProbeResult
} from './chatgpt-browser-scripts.js';

export {
  defaultAppleScriptExecutor,
  defaultAsyncAppleScriptExecutor,
  isTimeoutError,
  getConversationUrlPattern,
  isExactConversationUrl,
  isPlaceholderMessageId
};

export class ChatGPTBrowserAdapter {
  /**
   * @param {object} [options]
   * @param {function} [options.executor] - 同步 AppleScript 执行器
   * @param {function} [options.asyncExecutor] - 异步 AppleScript 执行器
   */
  constructor({
    executor = defaultAppleScriptExecutor,
    asyncExecutor = defaultAsyncAppleScriptExecutor
  } = {}) {
    this._executor = executor;
    this._asyncExecutor = asyncExecutor;
  }

  /**
   * 定位唯一的匹配标签页（0 匹配或多匹配时 fail-closed）
   * @param {string} conversationId 
   * @returns {{ windowIndex: number, tabIndex: number, url: string }}
   */
  locateExactConversationTab(conversationId) {
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      throw new Error('TARGET_LOOKUP_FAIL: conversationId must be a non-empty string');
    }
    const out = this._executor(buildTabLocationScript(conversationId));
    return parseTabLocationOutput(out, conversationId);
  }

  /**
   * 异步定位唯一的匹配标签页（带超时）
   * @param {string} conversationId 
   * @param {object} [options]
   * @param {number} [options.timeoutMs=3000]
   * @returns {Promise<{ windowIndex: number, tabIndex: number, url: string }>}
   */
  async locateExactConversationTabAsync(conversationId, { timeoutMs = 3000 } = {}) {
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      throw new Error('TARGET_LOOKUP_FAIL: conversationId must be a non-empty string');
    }
    const out = await this._asyncExecutor(buildTabLocationScript(conversationId), { timeoutMs });
    return parseTabLocationOutput(out, conversationId);
  }

  /**
   * 在指定标签页中静默执行 JavaScript（同步）
   * @param {number} windowIndex 
   * @param {number} tabIndex 
   * @param {string} jsCode 
   * @returns {string}
   */
  runTabJS(windowIndex, tabIndex, jsCode) {
    return this._executor(buildRunTabJSScript(windowIndex, tabIndex, jsCode));
  }

  /**
   * 在指定标签页中静默执行 JavaScript（异步带超时）
   * @param {number} windowIndex 
   * @param {number} tabIndex 
   * @param {string} jsCode 
   * @param {object} [options]
   * @param {number} [options.timeoutMs=3000]
   * @returns {Promise<string>}
   */
  async runTabJSAsync(windowIndex, tabIndex, jsCode, { timeoutMs = 3000 } = {}) {
    return await this._asyncExecutor(buildRunTabJSScript(windowIndex, tabIndex, jsCode), { timeoutMs });
  }

  /**
   * 构建注入到目标标签页的 DOM 探针脚本
   * @param {string} conversationId
   * @returns {string}
   */
  buildProbeScript(conversationId) {
    return buildProbeScript(conversationId);
  }

  /**
   * 同步观察底层目标标签页的 DOM 状态并返回规范化端点观察事实
   * @param {object} params
   * @param {string} params.conversationId
   * @param {number} [params.bindingRevision]
   * @returns {object}
   */
  observeBrowserEndpoint({ conversationId, bindingRevision } = {}) {
    if (!conversationId || typeof conversationId !== 'string') {
      return { conversation_id: conversationId, binding_revision: bindingRevision, continuity_lost: true, reason: 'missing_conversation_identity', should_record: true, trusted: false };
    }
    let target;
    try {
      target = this.locateExactConversationTab(conversationId);
    } catch (err) {
      return { conversation_id: conversationId, binding_revision: bindingRevision, continuity_lost: true, reason: err.message, should_record: true, trusted: false };
    }
    let probeResult;
    try {
      const probeCode = this.buildProbeScript(conversationId);
      const rawRes = this.runTabJS(target.windowIndex, target.tabIndex, probeCode);
      probeResult = JSON.parse(rawRes);
    } catch (err) {
      return { conversation_id: conversationId, binding_revision: bindingRevision, continuity_lost: true, reason: `DOM probe execution failed: ${err.message}`, should_record: true, trusted: false };
    }
    return normalizeProbeResult(probeResult, conversationId, bindingRevision);
  }

  /**
   * 异步有界观察底层目标标签页的 DOM 状态 (Blocker B & Delta 5)
   * 
   * 强制契约：
   * 1. 严格受到 timeoutMs 限制（默认 3000ms），超时中断子进程执行，绝不阻塞 Node 事件循环；
   * 2. 超时时返回 non-mutating 观察事实 (should_record: false, timed_out: true)，绝不将已有的 trusted 端点结果改写为 UNKNOWN，绝不修改 ordering checkpoint；
   * 3. 正常完成或真实连续性丢失正常返回。
   * 
   * @param {object} params
   * @param {string} params.conversationId
   * @param {number} [params.bindingRevision]
   * @param {number} [params.timeoutMs=3000]
   * @returns {Promise<object>}
   */
  async observeBrowserEndpointAsync({ conversationId, bindingRevision, timeoutMs = 3000 } = {}) {
    if (!conversationId || typeof conversationId !== 'string') {
      return { conversation_id: conversationId, binding_revision: bindingRevision, continuity_lost: true, reason: 'missing_conversation_identity', should_record: true, trusted: false };
    }
    let target;
    try {
      target = await this.locateExactConversationTabAsync(conversationId, { timeoutMs });
    } catch (err) {
      if (isTimeoutError(err)) {
        return {
          conversation_id: conversationId,
          binding_revision: bindingRevision,
          latest_completed_cursor: undefined,
          completed_at: undefined,
          trusted: false,
          continuity_lost: false,
          is_generating: false,
          should_record: false,
          timed_out: true,
          reason: `observation_timeout: Browser observation exceeded bounded timeout of ${timeoutMs}ms`
        };
      }
      return { conversation_id: conversationId, binding_revision: bindingRevision, continuity_lost: true, reason: err.message, should_record: true, trusted: false };
    }

    let probeResult;
    try {
      const probeCode = this.buildProbeScript(conversationId);
      const rawRes = await this.runTabJSAsync(target.windowIndex, target.tabIndex, probeCode, { timeoutMs });
      probeResult = JSON.parse(rawRes);
    } catch (err) {
      if (isTimeoutError(err)) {
        return {
          conversation_id: conversationId,
          binding_revision: bindingRevision,
          latest_completed_cursor: undefined,
          completed_at: undefined,
          trusted: false,
          continuity_lost: false,
          is_generating: false,
          should_record: false,
          timed_out: true,
          reason: `observation_timeout: Browser observation exceeded bounded timeout of ${timeoutMs}ms`
        };
      }
      return { conversation_id: conversationId, binding_revision: bindingRevision, continuity_lost: true, reason: `DOM probe execution failed: ${err.message}`, should_record: true, trusted: false };
    }

    return normalizeProbeResult(probeResult, conversationId, bindingRevision);
  }

  /**
   * 聚焦匹配该会话的唯一 Chrome 标签页并置顶窗口
   * @param {string} conversationId
   * @returns {{ focused: true, windowIndex: number, tabIndex: number, url: string }}
   */
  focusConversationTab(conversationId) {
    const target = this.locateExactConversationTab(conversationId);
    const script = `
    tell application "Google Chrome"
      set active tab index of window ${target.windowIndex} to ${target.tabIndex}
      set index of window ${target.windowIndex} to 1
      activate
    end tell
    `;
    this._executor(script);
    return {
      focused: true,
      windowIndex: target.windowIndex,
      tabIndex: target.tabIndex,
      url: target.url
    };
  }

  /**
   * 检查输入框准备情况（Preflight 检查）
   * @param {string} conversationId
   * @returns {{ ready: boolean, reason?: string }}
   */
  checkComposerPreflight(conversationId) {
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('CONVERSATION_ID_REQUIRED: conversationId must be a non-empty string');
    }
    const target = this.locateExactConversationTab(conversationId);
    const safePattern = JSON.stringify(getConversationUrlPattern(conversationId.trim()));
    const checkCode = `(() => {
      try {
        const url = window.location.href;
        if (!new RegExp(${safePattern}).test(url)) {
          return JSON.stringify({ ready: false, reason: 'conversation_url_drift_at_probe_time' });
        }
        const textarea = document.querySelector('#prompt-textarea');
        const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]');
        const isGenerating = !!stopBtn;
        const hasComposer = !!textarea;
        const disabled = textarea ? (textarea.disabled || textarea.getAttribute('aria-disabled') === 'true') : true;

        if (isGenerating) {
          return JSON.stringify({ ready: false, reason: 'generation_in_progress' });
        }
        if (!hasComposer) {
          return JSON.stringify({ ready: false, reason: 'composer_not_found' });
        }
        if (disabled) {
          return JSON.stringify({ ready: false, reason: 'composer_disabled' });
        }
        return JSON.stringify({ ready: true, hasComposer: true, isGenerating: false, disabled: false });
      } catch (e) {
        return JSON.stringify({ ready: false, error: e.message });
      }
    })()`;
    const raw = this.runTabJS(target.windowIndex, target.tabIndex, checkCode);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ready: false, reason: `preflight_parse_error: ${e.message}` };
    }
    if (parsed.error) {
      return { ready: false, reason: `preflight_error: ${parsed.error}` };
    }
    if (!parsed.ready) {
      return { ready: false, reason: parsed.reason || 'composer_not_ready' };
    }
    return { ready: true };
  }

  /**
   * 安全地向目标会话输入文本并触发发送
   * @param {string} conversationId
   * @param {string} text
   * @returns {{ accepted: true, textLength: number, method: string }}
   */
  sendTextPrompt(conversationId, text) {
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      throw new Error('CONVERSATION_ID_REQUIRED: conversationId must be a non-empty string');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('PROMPT_EMPTY: text must be non-empty string');
    }
    const target = this.locateExactConversationTab(conversationId);
    const safeText = JSON.stringify(text);
    const sendPattern = JSON.stringify(getConversationUrlPattern(conversationId.trim()));
    const sendCode = `(() => {
      try {
        const url = window.location.href;
        if (!new RegExp(${sendPattern}).test(url)) {
          return JSON.stringify({ success: false, reason: 'conversation_url_drift_before_mutation' });
        }
        const textarea = document.querySelector('#prompt-textarea');
        if (!textarea) return JSON.stringify({ success: false, reason: 'textarea_not_found' });
        
        textarea.focus();
        if (textarea.tagName === 'DIV' || textarea.contentEditable === 'true') {
          textarea.innerText = ${safeText};
        } else {
          textarea.value = ${safeText};
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        
        const sendBtn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return JSON.stringify({ success: true, method: 'button_click' });
        }
        
        const enterEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
        textarea.dispatchEvent(enterEvent);
        return JSON.stringify({ success: true, method: 'enter_key' });
      } catch (e) {
        return JSON.stringify({ success: false, reason: e.message });
      }
    })()`;
    const raw = this.runTabJS(target.windowIndex, target.tabIndex, sendCode);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`SEND_PARSE_ERROR: ${e.message}`);
    }
    if (!parsed.success) {
      throw new Error(`SEND_FAILED: ${parsed.reason || 'unknown send error'}`);
    }
    return { accepted: true, textLength: text.length, method: parsed.method || 'dom_mutation' };
  }
}

export function createChatGPTBrowserAdapter(options = {}) {
  return new ChatGPTBrowserAdapter(options);
}
