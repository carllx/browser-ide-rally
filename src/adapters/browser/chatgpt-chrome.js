/**
 * ChatGPT Chrome AppleScript 适配器
 * 窄化 DOM 依赖，支持无焦点夺取、严格标签页定位、Draft/Busy 守卫与 New-Turn 边界捕获
 */

import { execFileSync } from 'child_process';
import { extractAndValidateEnvelope } from '../../controller/envelope.js';

/**
 * 默认 AppleScript 执行器
 */
export function defaultAppleScriptExecutor(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

export class ChatGPTChromeAdapter {
  constructor({ executor = defaultAppleScriptExecutor } = {}) {
    this.executor = executor;
  }

  /**
   * 执行针对目标标签页的 JavaScript
   * 优先使用精准的 window/tab 索引，不夺取操作系统焦点
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
    return this.executor(script);
  }

  /**
   * 定位唯一的匹配标签页（0 匹配或多匹配时 fail-closed）
   * @param {string} conversationId 
   * @returns {{ windowIndex: number, tabIndex: number, url: string }}
   */
  locateExactConversationTab(conversationId) {
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('TARGET_LOOKUP_FAIL: conversationId must be a non-empty string');
    }

    const script = `
    tell application "Google Chrome"
      set matchCount to 0
      set targetWin to 0
      set targetTab to 0
      set targetURL to ""
      
      repeat with i from 1 to count of windows
        set w to window i
        repeat with j from 1 to count of tabs of w
          set t to tab j of w
          set u to URL of t
          if u contains "${conversationId}" then
            set matchCount to matchCount + 1
            set targetWin to i
            set targetTab to j
            set targetURL to u
          end if
        end repeat
      end repeat
      
      if matchCount = 0 then
        return "ERROR:ZERO_MATCHES"
      else if matchCount > 1 then
        return "ERROR:AMBIGUOUS_MATCHES:" & matchCount
      else
        set active tab index of (window targetWin) to targetTab
        return "SUCCESS:" & targetWin & ":" & targetTab & ":" & targetURL
      end if
    end tell
    `;

    const out = this.executor(script);
    if (out.startsWith('ERROR:ZERO_MATCHES')) {
      throw new Error(`TARGET_LOOKUP_FAIL: No Chrome tab found matching conversation ID "${conversationId}"`);
    }
    if (out.startsWith('ERROR:AMBIGUOUS_MATCHES')) {
      throw new Error(`TARGET_LOOKUP_FAIL: Multiple Chrome tabs match conversation ID "${conversationId}": ${out}`);
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
   * 前置检查 (Preflight): URL 校验、Draft 守卫与 Busy 守卫
   */
  checkPreflight(windowIndex, tabIndex, conversationId) {
    const raw = this.runTabJS(windowIndex, tabIndex, `
      (() => {
        const url = window.location.href;
        const promptEl = document.querySelector("#prompt-textarea");
        const stopBtn = document.querySelector("button[aria-label='Stop generating']");
        return JSON.stringify({
          url,
          hasPrompt: !!promptEl,
          promptDraft: promptEl ? (promptEl.innerText || promptEl.value || "").trim() : "",
          isGenerating: !!stopBtn
        });
      })()
    `);

    let state;
    try {
      state = JSON.parse(raw);
    } catch (e) {
      throw new Error(`PREFLIGHT_FAIL: Could not parse browser preflight output: ${e.message}`);
    }

    if (!state.url.includes(conversationId)) {
      throw new Error(`PREFLIGHT_FAIL: Target tab URL "${state.url}" does not match conversation "${conversationId}"`);
    }
    if (state.promptDraft.length > 0) {
      throw new Error(`PREFLIGHT_FAIL: Unsent draft present in composer: "${state.promptDraft}"`);
    }
    if (state.isGenerating) {
      throw new Error('PREFLIGHT_FAIL: ChatGPT is currently generating (busy)');
    }

    return state;
  }

  /**
   * 捕获当前 Assistant 轮次基线 (New-turn Boundary)
   * 记录已存在的 Assistant turn 标识和总数，绝不执行历史 envelope
   */
  captureAssistantTurnBaseline(windowIndex, tabIndex) {
    const raw = this.runTabJS(windowIndex, tabIndex, `
      (() => {
        const msgs = Array.from(document.querySelectorAll("[data-message-author-role='assistant']"));
        const ids = msgs.map((el, idx) => el.getAttribute("data-message-id") || ("turn_idx_" + idx));
        return JSON.stringify({
          assistantTurnCount: msgs.length,
          assistantTurnIds: ids
        });
      })()
    `);

    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`BASELINE_FAIL: Failed to establish assistant turn baseline: ${e.message}`);
    }
  }

  /**
   * 安全向浏览器键入文本并提交
   */
  sendTextPrompt(windowIndex, tabIndex, text) {
    // 键入文本
    this.runTabJS(windowIndex, tabIndex, `
      (() => {
        const promptEl = document.querySelector("#prompt-textarea");
        if (!promptEl) throw new Error("No prompt textarea found");
        promptEl.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        const msg = ${JSON.stringify(text)};
        document.execCommand("insertText", false, msg);
      })()
    `);

    // 等待 DOM 微任务更新 React 状态以激活发送按钮
    execFileSync('sleep', ['0.5']);

    // 点击提交
    const submitRaw = this.runTabJS(windowIndex, tabIndex, `
      (() => {
        const btn = document.querySelector("#composer-submit-button") || document.querySelector("button[data-testid='send-button']");
        if (!btn) return JSON.stringify({ error: "no_submit_button" });
        if (btn.disabled) return JSON.stringify({ error: "submit_button_disabled" });
        btn.click();
        return JSON.stringify({ success: true });
      })()
    `);


    let result;
    try {
      result = JSON.parse(submitRaw);
    } catch (e) {
      throw new Error(`SUBMIT_FAIL: Failed to parse submit response: ${e.message}`);
    }

    if (!result.success) {
      throw new Error(`SUBMIT_FAIL: Composer submit failed: ${JSON.stringify(result)}`);
    }

    return true;
  }

  /**
   * 监听仅属于基线之后新出现的 Assistant Turn 并提取校验 Envelope
   */
  waitForNewAssistantEnvelope({
    windowIndex,
    tabIndex,
    baseline,
    expectedNonce,
    binding,
    timeoutMs = 60000,
    pollIntervalMs = 1500
  }) {
    const tStart = Date.now();
    let capturedTurn = null;

    while (Date.now() - tStart < timeoutMs) {
      const pollRaw = this.runTabJS(windowIndex, tabIndex, `
        (() => {
          const stopBtn = document.querySelector("button[aria-label='Stop generating']");
          const msgs = Array.from(document.querySelectorAll("[data-message-author-role='assistant']"));
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const lastId = lastMsg ? (lastMsg.getAttribute("data-message-id") || ("turn_idx_" + (msgs.length - 1))) : null;
          return JSON.stringify({
            isGenerating: !!stopBtn,
            assistantTurnCount: msgs.length,
            lastTurnId: lastId,
            lastTurnText: lastMsg ? lastMsg.innerText.trim() : ""
          });
        })()
      `);

      let poll;
      try {
        poll = JSON.parse(pollRaw);
      } catch (e) {
        // 等待下一次轮询
        execFileSync('sleep', [(pollIntervalMs / 1000).toString()]);
        continue;
      }

      // 严格检查：生成必须已结束，且 Assistant 消息属于新轮次，并且已完整闭合 </RALLY_HANDOFF>
      const isNewTurn = poll.assistantTurnCount > baseline.assistantTurnCount ||
        (poll.lastTurnId && !baseline.assistantTurnIds.includes(poll.lastTurnId));

      if (!poll.isGenerating && isNewTurn && poll.lastTurnText.includes('</RALLY_HANDOFF>') && poll.lastTurnText.includes(expectedNonce)) {
        capturedTurn = {
          turnId: poll.lastTurnId,
          turnIndex: poll.assistantTurnCount - 1,
          rawText: poll.lastTurnText
        };
        break;
      }


      execFileSync('sleep', [(pollIntervalMs / 1000).toString()]);
    }

    if (!capturedTurn) {
      throw new Error(`TIMEOUT: No new Assistant turn containing nonce "${expectedNonce}" observed within ${timeoutMs}ms`);
    }

    // 严格提取并校验 Envelope
    const envelope = extractAndValidateEnvelope(capturedTurn.rawText, {
      expectedNonce,
      binding
    });

    return {
      envelope,
      turnIdentity: {
        turnId: capturedTurn.turnId,
        turnIndex: capturedTurn.turnIndex
      },
      rawText: capturedTurn.rawText
    };
  }

  /**
   * 将实际结果投递回 Browser 会话并等待 ACK
   */
  deliverResultAndAwaitAck({
    windowIndex,
    tabIndex,
    messageText,
    expectedAckPrefix,
    timeoutMs = 60000,
    pollIntervalMs = 1500
  }) {
    // 捕获发送前的 baseline
    const baseline = this.captureAssistantTurnBaseline(windowIndex, tabIndex);

    // 发送消息
    this.sendTextPrompt(windowIndex, tabIndex, messageText);

    // 等待 Assistant 返回包含 ACK 的新 turn
    const tStart = Date.now();
    let ackText = null;

    while (Date.now() - tStart < timeoutMs) {
      const pollRaw = this.runTabJS(windowIndex, tabIndex, `
        (() => {
          const stopBtn = document.querySelector("button[aria-label='Stop generating']");
          const msgs = Array.from(document.querySelectorAll("[data-message-author-role='assistant']"));
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const lastId = lastMsg ? (lastMsg.getAttribute("data-message-id") || ("turn_idx_" + (msgs.length - 1))) : null;
          return JSON.stringify({
            isGenerating: !!stopBtn,
            assistantTurnCount: msgs.length,
            lastTurnId: lastId,
            lastTurnText: lastMsg ? lastMsg.innerText.trim() : ""
          });
        })()
      `);

      let poll;
      try {
        poll = JSON.parse(pollRaw);
      } catch (e) {
        execFileSync('sleep', [(pollIntervalMs / 1000).toString()]);
        continue;
      }

      const isNewTurn = poll.assistantTurnCount > baseline.assistantTurnCount ||
        (poll.lastTurnId && !baseline.assistantTurnIds.includes(poll.lastTurnId));

      if (!poll.isGenerating && isNewTurn && poll.lastTurnText.includes(expectedAckPrefix)) {
        ackText = poll.lastTurnText;
        break;
      }

      execFileSync('sleep', [(pollIntervalMs / 1000).toString()]);
    }

    if (!ackText) {
      throw new Error(`TIMEOUT: Assistant failed to produce ACK matching "${expectedAckPrefix}" within ${timeoutMs}ms`);
    }

    return {
      success: true,
      ackText,
      durationMs: Date.now() - tStart
    };
  }
}
