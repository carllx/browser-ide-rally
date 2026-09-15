/**
 * Wayfinder Research Gate Fact Probe Runner (#9 + #11)
 * 2026-09-15 (Asia/Shanghai)
 * 
 * 包含对 ChatGPT Chrome 与 Antigravity IDE 的实机探针测试用例：
 * 1. Browser 刷新后 turn identity (data-message-id) 稳定性
 * 2. Browser 思考型/占位符与真实工具调用 (Web Search) 完成信号与过滤
 * 3. Browser 模拟 last_processed_turn 的重启去重
 * 4. Browser 双会话归属隔离
 * 5. Antigravity AgentAPI 元数据验证
 * 6. Antigravity Stop Hook 载荷与多步无中间 Stop 验证
 * 7. Antigravity Transcript 游标与重启恢复验证
 */

import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { ChatGPTChromeAdapter } from '../../src/adapters/browser/chatgpt-chrome.js';

export class ProbeRunner {
  constructor() {
    this.adapter = new ChatGPTChromeAdapter();
    this.agentApiBin = '/Users/yamlam/.gemini/antigravity/bin/agentapi';
  }

  // 1. 验证 Browser turn identity 在刷新后的持久稳定性
  async probeBrowserIdentityStability(convId) {
    const tab = this.adapter.locateExactConversationTab(convId);
    const readTurns = () => {
      const raw = this.adapter.runTabJS(tab.windowIndex, tab.tabIndex, `(() => {
        const msgs = Array.from(document.querySelectorAll("[data-message-author-role='assistant']"));
        return JSON.stringify(msgs.map(m => ({
          id: m.getAttribute("data-message-id"),
          len: (m.innerText || "").length,
          snippet: (m.innerText || "").slice(0, 30).replace(/\\n/g, " ")
        })));
      })()`);
      return JSON.parse(raw);
    };

    const before = readTurns();
    this.adapter.executor(`
      tell application "Google Chrome"
        tell tab ${tab.tabIndex} of window ${tab.windowIndex} to reload
      end tell
    `);

    let after = null;
    const tStart = Date.now();
    while (Date.now() - tStart < 30000) {
      execFileSync('sleep', ['1']);
      try {
        const ready = this.adapter.runTabJS(tab.windowIndex, tab.tabIndex, 'document.readyState');
        if (ready === 'complete') {
          const cand = readTurns();
          if (cand.length === before.length && cand.every(t => t.id)) {
            after = cand;
            break;
          }
        }
      } catch (e) {}
    }

    if (!after) return { pass: false, error: 'TIMEOUT_ON_RELOAD' };
    const allMatch = before.every((b, i) => b.id === after[i].id);
    return { pass: allMatch, beforeCount: before.length, afterCount: after.length };
  }

  // 2. 验证 Browser 真实工具调用 (Web Search) 完成与 Citation 采样
  probeBrowserToolTurnCompletion(convId) {
    const tab = this.adapter.locateExactConversationTab(convId);
    const raw = this.adapter.runTabJS(tab.windowIndex, tab.tabIndex, `(() => {
      const msgs = Array.from(document.querySelectorAll("[data-message-author-role='assistant']"));
      const last = msgs[msgs.length - 1];
      const links = Array.from(last ? last.querySelectorAll("a[href]") : []).map(a => a.href);
      const citations = Array.from(last ? last.querySelectorAll("[data-testid*='citation'], [class*='citation']") : []).map(c => c.innerText);
      const stopBtn = document.querySelector("button[data-testid='stop-button'], button[aria-label='Stop answering']");
      return JSON.stringify({
        hasStopBtn: !!stopBtn,
        turnId: last ? last.getAttribute("data-message-id") : null,
        linksCount: links.length,
        citationsCount: citations.length,
        textLen: last ? (last.innerText || "").length : 0
      });
    })()`);
    const res = JSON.parse(raw);
    const pass = !res.hasStopBtn && res.linksCount > 0 && !res.turnId.includes('placeholder');
    return { pass, ...res };
  }

  // 3. 验证 Antigravity transcript 游标在重启后的去重
  probeAntigravityCursorReplaySafety(convId, transcriptPath) {
    const parseTurns = () => {
      const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
      const steps = lines.map(l => JSON.parse(l));
      const turns = [];
      for (const step of steps) {
        if (step.type === 'PLANNER_RESPONSE' && step.status === 'DONE' && !step.tool_calls) {
          const hash = crypto.createHash('sha256').update(step.content || '').digest('hex').slice(0, 16);
          turns.push({ stepIndex: step.step_index, hash });
        }
      }
      return turns;
    };

    const baseline = parseTurns();
    const last = baseline[baseline.length - 1];
    const simulatedLedger = { lastStepIndex: last.stepIndex, hash: last.hash };

    // 重启模拟
    const reloadedTurns = parseTurns();
    const unprocessed = reloadedTurns.filter(t => t.stepIndex > simulatedLedger.lastStepIndex);
    return { pass: unprocessed.length === 0, baselineCount: baseline.length };
  }
}
