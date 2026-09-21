/**
 * ChatGPT 浏览器适配器底层 AppleScript、正则与 DOM 探针脚本工具模块
 *
 * 核心设计契约 (#15, #27):
 * 1. 纯脚本构造与输出解析，不持有状态；
 * 2. 精确会话路径正则匹配，杜绝子字符串串台；
 * 3. placeholder-* 与 request-placeholder-* 严格过滤；
 * 4. 提供同步与有界超时的异步 AppleScript 执行器；
 * 5. 将 DOM 探针原始 JSON 输出归一化为 Core 规范事实。
 */

import { execFileSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * 默认同步 AppleScript 执行器
 * @param {string} script
 * @returns {string}
 */
export function defaultAppleScriptExecutor(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

/**
 * 默认异步有界 AppleScript 执行器
 * @param {string} script
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000]
 * @returns {Promise<string>}
 */
export function defaultAsyncAppleScriptExecutor(script, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve((stdout || '').trim());
    });
  });
}

/**
 * 判断错误是否为超时错误
 * @param {Error|any} err
 * @returns {boolean}
 */
export function isTimeoutError(err) {
  if (!err) return false;
  return Boolean(
    err.killed ||
    err.signal === 'SIGTERM' ||
    err.code === 'ETIMEDOUT' ||
    err.timedOut === true ||
    (typeof err.message === 'string' && (
      err.message.includes('timed out') ||
      err.message.includes('TIMEOUT') ||
      err.message.includes('ETIMEDOUT')
    ))
  );
}

/**
 * 构造用于匹配 ChatGPT 会话 URL 的正则表达式模式
 * @param {string} conversationId
 * @returns {string}
 */
export function getConversationUrlPattern(conversationId) {
  const escaped = conversationId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(?:https?:\\/\\/(?:chatgpt\\.com|chat\\.openai\\.com))?\\/(?:g\\/[^\\/]+\\/)?c\\/${escaped}(?:[?#\\/]|$)`;
}

/**
 * 判断 URL 是否精确归属于指定的 ChatGPT 会话 ID
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
  return new RegExp(getConversationUrlPattern(trimmedId)).test(url);
}

/**
 * 判断消息 ID 是否为占位或未就绪 ID
 * @param {string|null|undefined} rawId
 * @returns {boolean}
 */
export function isPlaceholderMessageId(rawId) {
  if (!rawId || typeof rawId !== 'string') return true;
  const trimmed = rawId.trim();
  if (trimmed === '') return true;
  const lower = trimmed.toLowerCase();
  return lower.startsWith('placeholder') || lower.startsWith('request-placeholder');
}

/**
 * 构造定位 Chrome 标签页的 AppleScript
 */
export function buildTabLocationScript(conversationId) {
  const trimmedId = conversationId.trim();
  const safeConvId = JSON.stringify(trimmedId);
  const safeUrlPattern = JSON.stringify(getConversationUrlPattern(trimmedId));
  return `
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
        if u contains convId then
          set isValid to (execute t javascript "(function() { return new RegExp(" & quoted form of urlPat & ").test(location.href); })()")
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
}

/**
 * 解析定位 Chrome 标签页的 AppleScript 输出
 */
export function parseTabLocationOutput(out, conversationId) {
  const trimmedId = conversationId.trim();
  if (!out || typeof out !== 'string') {
    throw new Error(`TARGET_LOOKUP_FAIL: Empty output from Chrome lookup for "${trimmedId}"`);
  }
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
  return {
    windowIndex: parseInt(parts[1], 10),
    tabIndex: parseInt(parts[2], 10),
    url: parts.slice(3).join(':')
  };
}

/**
 * 构造在标签页执行 JavaScript 的 AppleScript
 */
export function buildRunTabJSScript(windowIndex, tabIndex, jsCode) {
  const escapedCode = JSON.stringify(jsCode);
  return `
  tell application "Google Chrome"
    tell tab ${tabIndex} of window ${windowIndex}
      execute javascript ${escapedCode}
    end tell
  end tell
  `;
}

/**
 * 构建注入到目标标签页的 DOM 探针脚本
 * @param {string} conversationId
 * @returns {string}
 */
export function buildProbeScript(conversationId) {
  const trimmedId = conversationId.trim();
  const safeConvId = JSON.stringify(trimmedId);
  const safeUrlPattern = JSON.stringify(getConversationUrlPattern(trimmedId));

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
        
        let lastMessageText = '';
        if (!isPlaceholder) {
          const contentEl = lastEl.querySelector('.markdown') || lastEl;
          lastMessageText = (contentEl.innerText || contentEl.textContent || '').trim();
        }
        
        return JSON.stringify({
          isGenerating,
          assistantCount: count,
          lastMessageId: isPlaceholder ? null : rawId.trim(),
          lastMessageText: isPlaceholder ? '' : lastMessageText,
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
 * 归一化探针解析结果为 Core 规范端点观察事实
 */
export function normalizeProbeResult(probeResult, conversationId, bindingRevision) {
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

  if (!probeResult || typeof probeResult !== 'object') {
    baseObservation.continuity_lost = true;
    baseObservation.reason = 'malformed_probe_result';
    return baseObservation;
  }

  if (probeResult.error) {
    baseObservation.continuity_lost = true;
    baseObservation.reason = `dom_probe_execution_error: ${probeResult.error}`;
    return baseObservation;
  }

  if (probeResult.isGenerating) {
    baseObservation.is_generating = true;
    baseObservation.should_record = false;
    baseObservation.trusted = false;
    baseObservation.continuity_lost = false;
    baseObservation.reason = 'generation_in_progress: ChatGPT is currently generating response';
    return baseObservation;
  }

  if (probeResult.assistantCount === 0) {
    baseObservation.trusted = true;
    baseObservation.latest_completed_cursor = null;
    baseObservation.completed_at = null;
    return baseObservation;
  }

  if (probeResult.isPlaceholder || !probeResult.hasValidLastMessage || !probeResult.lastMessageId || isPlaceholderMessageId(probeResult.lastMessageId)) {
    baseObservation.continuity_lost = true;
    baseObservation.reason = 'placeholder_or_unidentified_turn: final assistant turn lacks valid non-placeholder message id';
    return baseObservation;
  }

  const opaqueCursor = `chatgpt_msg_${probeResult.lastMessageId}`;
  const completedAt = new Date().toISOString();
  const safeRefHash = crypto.createHash('sha256')
    .update(`browser:${conversationId}:${opaqueCursor}`)
    .digest('hex')
    .slice(0, 16);
  const resultRef = `res_${safeRefHash}`;

  baseObservation.trusted = true;
  baseObservation.latest_completed_cursor = opaqueCursor;
  baseObservation.completed_at = completedAt;
  baseObservation.latest_completed_result = {
    cursor: opaqueCursor,
    result_ref: resultRef,
    text: probeResult.lastMessageText || '',
    captured_at: completedAt
  };
  return baseObservation;
}
