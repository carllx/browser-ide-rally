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
 * 7. 任何归属模糊、DOM 漂移、无法解析等真正异常，均 fail-closed 产出非受信或 UNKNOWN。
 * 
 * 严格边界：
 * - 不包含任何 Relay send 路径、不修改 DOM、不夺取系统焦点；
 * - DOM 选择器、message-id 与标签页细节全部内聚在此适配器中，Core 仅接收 opaque cursor 与 normalized facts。
 */

import { execFileSync } from 'node:child_process';

/**
 * 默认 AppleScript 执行器
 * @param {string} script
 * @returns {string}
 */
export function defaultAppleScriptExecutor(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

/**
 * 构造用于匹配 ChatGPT 会话 URL 的正则表达式模式
 * 支持标准 /c/<convId> 以及 GPT 路径 /g/<gptId>/c/<convId>，严格防止子字符串与查询参数误判
 * @param {string} conversationId
 * @returns {string}
 */
export function getConversationUrlPattern(conversationId) {
  const escaped = conversationId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(?:https?:\\/\\/(?:chatgpt\\.com|chat\\.openai\\.com))?\\/(?:g\\/[^\\/]+\\/)?c\\/${escaped}(?:[?#\\/]|$)`;
}

/**
 * 判断 URL 是否精确归属于指定的 ChatGPT 会话 ID
 * 支持标准 /c/<convId> 以及 GPT 路径 /g/<gptId>/c/<convId>，防止子字符串误判
 * @param {string} url
 * @param {string} conversationId
 * @returns {boolean}
 */
export function isExactConversationUrl(url, conversationId) {
  if (!url || typeof url !== 'string' || !conversationId || typeof conversationId !== 'string') {
    return false;
  }
  const trimmedId = conversationId.trim();
  if (!trimmedId) return false;

  const pattern = getConversationUrlPattern(trimmedId);
  return new RegExp(pattern).test(url);
}

/**
 * 判断消息 ID 是否为占位或未就绪 ID
 * 严格过滤：空值、placeholder 前缀、以及实机验证的 request-placeholder-* 族
 * @param {string|null|undefined} rawId
 * @returns {boolean}
 */
export function isPlaceholderMessageId(rawId) {
  if (!rawId || typeof rawId !== 'string') {
    return true;
  }
  const trimmed = rawId.trim();
  if (trimmed === '') {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('placeholder') || lower.startsWith('request-placeholder')) {
    return true;
  }
  return false;
}

export class ChatGPTBrowserAdapter {
  /**
   * @param {object} [options]
   * @param {function} [options.executor] - AppleScript 执行函数（支持依赖注入/mock）
   */
  constructor({ executor = defaultAppleScriptExecutor } = {}) {
    this._executor = executor;
  }

  /**
   * 定位唯一的匹配标签页（0 匹配或多匹配时 fail-closed）
   * 采用精确 URL 路径比对，严禁任意子字符串模糊匹配
   * @param {string} conversationId 
   * @returns {{ windowIndex: number, tabIndex: number, url: string }}
   */
  locateExactConversationTab(conversationId) {
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      throw new Error('TARGET_LOOKUP_FAIL: conversationId must be a non-empty string');
    }

    const trimmedId = conversationId.trim();
    const safeConvId = JSON.stringify(trimmedId);
    const safeUrlPattern = JSON.stringify(getConversationUrlPattern(trimmedId));

    const script = `
    tell application "Google Chrome"
      set matchCount to 0
      set targetWin to 0
      set targetTab to 0
      set targetURL to ""
      set convId to ${safeConvId}
      set urlPat to ${safeUrlPattern}
      
      set winList to every window
      repeat with i from 1 to count of winList
        set w to item i of winList
        set tabList to every tab of w
        repeat with j from 1 to count of tabList
          set t to item j of tabList
          set u to URL of t
          -- 粗筛：URL 中必须至少包含对话 ID 字符
          if u contains convId then
            -- 精筛：由内置 JS 正则做精确路径边界校验，排除子串和参数伪造
            set isValid to (execute t javascript "(function() { return new RegExp(" & urlPat & ").test(location.href); })()")
            if isValid = true or isValid = "true" then
              set matchCount to matchCount + 1
              set targetWin to i
              set targetTab to j
              set targetURL to u
            end if
          end if
        end repeat
      end repeat
      
      if matchCount = 0 then
        return "ERROR:ZERO_MATCHES"
      else if matchCount > 1 then
        return "ERROR:AMBIGUOUS_MATCHES:" & matchCount
      else
        return "SUCCESS:" & targetWin & ":" & targetTab & ":" & targetURL
      end if
    end tell
    `;

    const out = this._executor(script);
    if (out.startsWith('ERROR:ZERO_MATCHES')) {
      throw new Error(`TARGET_LOOKUP_FAIL: No Chrome tab found matching conversation "${trimmedId}"`);
    }
    if (out.startsWith('ERROR:AMBIGUOUS_MATCHES')) {
      const count = out.split(':')[2] || 'multiple';
      throw new Error(`TARGET_LOOKUP_FAIL: Ambiguous match: ${count} tabs match conversation "${trimmedId}"`);
    }
    if (!out.startsWith('SUCCESS:')) {
      throw new Error(`TARGET_LOOKUP_FAIL: Unexpected AppleScript output: ${out}`);
    }

    const parts = out.split(':');
    const windowIndex = parseInt(parts[1], 10);
    const tabIndex = parseInt(parts[2], 10);
    const url = parts.slice(3).join(':');

    return { windowIndex, tabIndex, url };
  }

  /**
   * 在指定标签页中静默执行 JavaScript（不夺取焦点）
   * @param {number} windowIndex 
   * @param {number} tabIndex 
   * @param {string} jsCode 
   * @returns {string}
   */
  runTabJS(windowIndex, tabIndex, jsCode) {
    const escapedCode = JSON.stringify(jsCode);
    const script = `
    tell application "Google Chrome"
      tell tab ${tabIndex} of window ${windowIndex}
        execute javascript ${escapedCode}
      end tell
    end tell
    `;
    return this._executor(script);
  }

  /**
   * 构建注入到目标标签页的 DOM 探针脚本
   * 包含当前 URL 的精确路径正则重验（彻底消除 lookup 到 probe 的 TOCTOU 漂移）
   * @param {string} conversationId
   * @returns {string}
   */
  buildProbeScript(conversationId) {
    const trimmedId = conversationId.trim();
    const safeConvId = JSON.stringify(trimmedId);
    const urlPattern = getConversationUrlPattern(trimmedId);
    const safeUrlPattern = JSON.stringify(urlPattern);

    return `
      (() => {
        try {
          const expectedConvId = ${safeConvId};
          const currentUrl = window.location.href;
          const exactRegex = new RegExp(${safeUrlPattern});
          
          if (!exactRegex.test(currentUrl)) {
            return JSON.stringify({
              error: "tab_url_mismatch_at_probe_time",
              currentUrl: currentUrl,
              expectedConvId: expectedConvId
            });
          }

          const stopBtn = document.querySelector('button[data-testid="stop-button"]');
          const isGenerating = !!stopBtn;
          
          const assistantEls = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
          const count = assistantEls.length;
          
          if (count === 0) {
            return JSON.stringify({
              isGenerating,
              assistantCount: 0,
              lastMessageId: null,
              hasValidLastMessage: false,
              isPlaceholder: false
            });
          }
          
          const lastEl = assistantEls[count - 1];
          const rawId = lastEl.getAttribute('data-message-id');
          const hasAttr = lastEl.hasAttribute('data-message-id');
          
          let isPlaceholder = !hasAttr || !rawId;
          if (!isPlaceholder) {
            const trimmed = rawId.trim();
            const lower = trimmed.toLowerCase();
            if (trimmed === '' || lower.startsWith('placeholder') || lower.startsWith('request-placeholder')) {
              isPlaceholder = true;
            }
          }
          
          return JSON.stringify({
            isGenerating,
            assistantCount: count,
            lastMessageId: isPlaceholder ? null : rawId.trim(),
            hasValidLastMessage: !isPlaceholder,
            isPlaceholder
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;
  }

  /**
   * 观察底层目标标签页的 DOM 状态并返回规范化端点观察事实 (Normalized Observation)
   * 
   * 观察流程与不变式：
   * 1. 严格定位标签页并执行 DOM 探针；若定位失败（0 匹配或多匹配），fail-closed 返回 continuity_lost=true；
   * 2. 在探针闭包内重新验证当前 location.href，防御 TOCTOU / 漂移；若失配 fail-closed 返回 continuity_lost=true；
   * 3. 探针提取生命周期：
   *    - isGenerating: 是否存在 button[data-testid="stop-button"]；
   *    - final non-placeholder Assistant message-id；
   *    - assistantTurnCount: assistant 消息元素总数；
   * 4. 正常 generation-in-progress（isGenerating === true）：
   *    - 属于运行时瞬态 (runtime-only activity)，绝非连续性丢失；
   *    - 返回 is_generating: true, should_record: false, continuity_lost: false, trusted: false；
   *    - 绝不因为正在生成而将 UNKNOWN 升级成 trusted，亦不推进或冲刷已有完成事实；
   * 5. 若无 assistant 消息：连续性受信任，游标为 null；
   * 6. 若最后一条 assistant 消息缺少合法的非空 ID，或属于 placeholder-* / request-placeholder-*：
   *    - fail-closed 返回 continuity_lost: true，拒绝将占位状态提交为完成游标；
   * 7. 生成已结束且存在稳定非占位 message-id：
   *    - 返回 trusted: true，将 ID 封装为 opaque cursor (`chatgpt_msg_${id}`)。
   * 
   * @param {object} params
   * @param {string} params.conversationId - 期望绑定的会话 ID
   * @param {number} [params.bindingRevision] - 绑定的版本号
   * @returns {object} 规范化观察结果
   */
  observeBrowserEndpoint({ conversationId, bindingRevision } = {}) {
    const baseObservation = {
      conversation_id: conversationId,
      binding_revision: bindingRevision,
      latest_completed_cursor: undefined,
      completed_at: undefined,
      trusted: false,
      continuity_lost: false,
      is_generating: false,
      should_record: true,
      reason: null
    };

    if (!conversationId || typeof conversationId !== 'string') {
      baseObservation.continuity_lost = true;
      baseObservation.reason = 'missing_conversation_identity';
      return baseObservation;
    }

    // 1. 定位目标标签页（精确 URL 路径比对，0 匹配或多匹配 fail-closed）
    let target;
    try {
      target = this.locateExactConversationTab(conversationId);
    } catch (err) {
      baseObservation.continuity_lost = true;
      baseObservation.reason = err.message;
      return baseObservation;
    }

    // 2. 注入 DOM 探针（并在探针闭包内重新验证当前 URL，防御 TOCTOU / 漂移）
    let probeResult;
    try {
      const probeCode = this.buildProbeScript(conversationId);
      const rawRes = this.runTabJS(target.windowIndex, target.tabIndex, probeCode);
      probeResult = JSON.parse(rawRes);
    } catch (err) {
      baseObservation.continuity_lost = true;
      baseObservation.reason = `DOM probe execution failed: ${err.message}`;
      return baseObservation;
    }

    // 3. 探针时刻 URL 漂移或执行期错误处理（fail-closed）
    if (probeResult.error) {
      baseObservation.continuity_lost = true;
      baseObservation.reason = `dom_probe_execution_error: ${probeResult.error}`;
      return baseObservation;
    }

    // 4. 正常生成中检查 (Gate 3: generation-in-progress is non-mutating runtime activity)
    if (probeResult.isGenerating) {
      baseObservation.is_generating = true;
      baseObservation.should_record = false; // 核心：runtime-only 瞬态，不可录入 Core 改写规范端点结果
      baseObservation.trusted = false; // 绝不因为正在生成而把 UNKNOWN 升级成 trusted
      baseObservation.continuity_lost = false; // 正常生成绝非连续性断裂
      baseObservation.reason = 'generation_in_progress: ChatGPT is currently generating response';
      return baseObservation;
    }

    // 4. 空会话（无 Assistant 回复）：连续性受信任，游标为 null
    if (probeResult.assistantCount === 0) {
      baseObservation.trusted = true;
      baseObservation.latest_completed_cursor = null;
      baseObservation.completed_at = null;
      return baseObservation;
    }

    // 5. 占位检查 (Gate 1: request-placeholder-* & placeholder-* 严格过滤)
    if (probeResult.isPlaceholder || !probeResult.hasValidLastMessage || !probeResult.lastMessageId || isPlaceholderMessageId(probeResult.lastMessageId)) {
      baseObservation.continuity_lost = true;
      baseObservation.reason = 'placeholder_or_unidentified_turn: final assistant turn lacks valid non-placeholder message id';
      return baseObservation;
    }

    // 6. 成功捕获完成轮次：生成稳定且不透明的 cursor
    const opaqueCursor = `chatgpt_msg_${probeResult.lastMessageId}`;

    baseObservation.trusted = true;
    baseObservation.latest_completed_cursor = opaqueCursor;
    baseObservation.completed_at = new Date().toISOString();
    return baseObservation;
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
    const target = this.locateExactConversationTab(conversationId);
    const checkCode = `(() => {
      try {
        const textarea = document.querySelector('#prompt-textarea');
        const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]');
        return JSON.stringify({
          hasComposer: !!textarea,
          isGenerating: !!stopBtn,
          disabled: textarea ? (textarea.disabled || textarea.getAttribute('aria-disabled') === 'true') : true
        });
      } catch (e) {
        return JSON.stringify({ error: e.message });
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
    if (parsed.isGenerating) {
      return { ready: false, reason: 'generation_in_progress' };
    }
    if (!parsed.hasComposer) {
      return { ready: false, reason: 'composer_not_found' };
    }
    if (parsed.disabled) {
      return { ready: false, reason: 'composer_disabled' };
    }
    return { ready: true };
  }

  /**
   * 安全地向目标会话输入文本并触发发送
   * @param {string} conversationId
   * @param {string} text
   * @returns {{ accepted: true, textLength: number }}
   */
  sendTextPrompt(conversationId, text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('PROMPT_EMPTY: text must be non-empty string');
    }
    const target = this.locateExactConversationTab(conversationId);
    const safeText = JSON.stringify(text);
    const sendCode = `(() => {
      try {
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
        
        const enterEvent = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13
        });
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
    return { accepted: true, textLength: text.length };
  }
}

