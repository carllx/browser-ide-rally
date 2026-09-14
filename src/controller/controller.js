/**
 * Rally Relay 控制器 (Rally Controller)
 * 驱动单次单飞行中 (Single In-flight) Browser ↔ IDE 中继轮次
 */

import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { validateBinding } from './binding.js';
import { PHASES, createExchange, transitionExchange, markBlocked, markUnknownDelivery } from './exchange.js';
import { formatStatusDump, formatCompactStatus } from '../status/status-view.js';

export class RallyController {
  constructor({
    binding,
    browserAdapter,
    ideAdapter,
    artifactDir = os.tmpdir()
  }) {
    this.binding = binding;
    this.browserAdapter = browserAdapter;
    this.ideAdapter = ideAdapter;
    this.artifactDir = artifactDir;
    this.activeExchange = null;
  }

  /**
   * 执行一次完整的端到端中继轮转
   * 
   * @param {object} options
   * @param {string} [options.exchangeId]
   * @param {string} [options.nonce]
   * @param {boolean} [options.promptBrowser=false] 是否由 Controller 先向浏览器发送生成 envelope 的提示词
   * @param {number} [options.timeoutMs=60000]
   * @returns {Promise<object>}
   */
  async executeRoundTrip({
    exchangeId = `ex-${Date.now()}`,
    nonce = `RALLY_HANDOFF_${crypto.randomUUID()}`,
    promptBrowser = false,
    timeoutMs = 60000
  } = {}) {
    // 1. 校验 Binding 合法性
    const bindingValidation = validateBinding(this.binding);
    if (!bindingValidation.valid) {
      throw new Error(`Controller: Invalid binding: ${bindingValidation.errors.join('; ')}`);
    }

    // 2. 初始化 Exchange
    const exchange = createExchange({
      exchange_id: exchangeId,
      nonce,
      binding_id: this.binding.binding_id,
      binding_revision: this.binding.binding_revision
    });
    this.activeExchange = exchange;

    // 检查暂停状态
    if (this.binding.paused) {
      markBlocked(exchange, 'Binding is paused by operator', { needs_human: true });
      return this._buildReturn(false, exchange, 'Binding is paused');
    }

    try {
      // 3. Browser 前置检查与标签页定位
      console.log(`[Controller] Locating exact browser tab for conversation ${this.binding.browser.conversation_id}...`);
      const tabInfo = this.browserAdapter.locateExactConversationTab(this.binding.browser.conversation_id);
      console.log(`[Controller] Found tab at window ${tabInfo.windowIndex}, tab ${tabInfo.tabIndex}. Running preflight...`);
      this.browserAdapter.checkPreflight(tabInfo.windowIndex, tabInfo.tabIndex, this.binding.browser.conversation_id);

      // 4. 建立 New-Turn 基线
      console.log('[Controller] Capturing assistant turn baseline...');
      const baseline = this.browserAdapter.captureAssistantTurnBaseline(tabInfo.windowIndex, tabInfo.tabIndex);
      console.log(`[Controller] Baseline turn count: ${baseline.assistantTurnCount}`);

      // 5. 若配置要求，向 Browser 提交生成请求
      if (promptBrowser) {
        console.log(`[Controller] Submitting handoff prompt with nonce "${nonce}" to browser...`);
        const handoffPrompt = `Please produce an explicit Rally handoff envelope.

Respond ONLY with this exact block and nothing else:

<RALLY_HANDOFF>
{
  "version": 1,
  "exchange_id": "${exchangeId}",
  "nonce": "${nonce}",
  "binding_id": "${this.binding.binding_id}",
  "binding_revision": ${this.binding.binding_revision},
  "operation": "rally.echo",
  "target": "bound_ide",
  "payload": {
    "text": "Return exactly RALLY_ECHO:${nonce}"
  }
}
</RALLY_HANDOFF>`;

        this.browserAdapter.sendTextPrompt(tabInfo.windowIndex, tabInfo.tabIndex, handoffPrompt);
        console.log('[Controller] Prompt submitted to browser.');
      }

      // 6. 等待并提取仅属于 New-Turn 的 Envelope
      console.log(`[Controller] Polling for new assistant turn containing completed envelope [nonce=${nonce}]...`);
      const captured = this.browserAdapter.waitForNewAssistantEnvelope({
        windowIndex: tabInfo.windowIndex,
        tabIndex: tabInfo.tabIndex,
        baseline,
        expectedNonce: nonce,
        binding: this.binding,
        timeoutMs
      });

      console.log('[Controller] New-turn envelope successfully captured and validated:');
      console.log(JSON.stringify(captured.envelope, null, 2));

      transitionExchange(exchange, PHASES.VALIDATED, {
        evidence: `Envelope captured from turn ${captured.turnIdentity.turnId}`
      });

      // 7. 严格核验目标 IDE 会话的工作区与仓库身份
      console.log(`[Controller] Verifying IDE identity for conversation ${this.binding.ide.conversation_id}...`);
      const verifiedTarget = this.ideAdapter.verifyTargetIdentity(
        this.binding.ide.conversation_id,
        this.binding.ide.workspace_identity,
        this.binding.ide.repository_identity
      );
      console.log(`[Controller] IDE identity verified: ws=${verifiedTarget.workspace}, repo=${verifiedTarget.repository}`);

      // 8. 由 Controller 拥有并生成不可预测的产物路径
      const artifactPath = path.join(this.artifactDir, `rally-ingress-result-${nonce}.json`);

      // 9. 派发受限任务至 IDE
      console.log(`[Controller] Dispatching controlled echo task to IDE receiver (${artifactPath})...`);
      this.ideAdapter.dispatchEchoTask({
        conversationId: this.binding.ide.conversation_id,
        envelope: captured.envelope,
        artifactPath
      });

      transitionExchange(exchange, PHASES.DELIVERED_TO_IDE, {
        evidence: `Dispatched echo task to IDE conv ${this.binding.ide.conversation_id}`
      });

      // 10. 轮询并验证 IDE 真实产物
      console.log('[Controller] Polling for receiver artifact...');
      let idePollResult;
      try {
        idePollResult = this.ideAdapter.pollReceiverArtifact({
          artifactPath,
          expectedNonce: nonce,
          timeoutMs
        });
      } catch (pollErr) {
        // 投递已发出但产物未在超时内确认，标记为未知投递结果，禁止隐式重试
        markUnknownDelivery(exchange, `Receiver result polling failed: ${pollErr.message}`);
        return this._buildReturn(false, exchange, pollErr.message);
      }

      console.log(`[Controller] IDE receiver produced valid result in ${idePollResult.durationMs}ms:`, idePollResult.result);

      transitionExchange(exchange, PHASES.RESULT_OBSERVED, {
        evidence: `IDE receiver produced verified echo artifact in ${idePollResult.durationMs}ms`
      });

      // 11. 将真实结果回投至 Browser 会话并等待 ACK
      const returnMsg = `Rally Ingress Result for Nonce ${nonce}:\n\n${idePollResult.result.result}\n\nReply only:\nACK:${nonce}`;
      const expectedAckPrefix = `ACK:${nonce}`;

      console.log('[Controller] Returning IDE result to browser and awaiting ACK...');
      transitionExchange(exchange, PHASES.DELIVERED_TO_BROWSER, {
        evidence: `Delivering result to browser conv ${this.binding.browser.conversation_id}`
      });

      let browserAckResult;
      try {
        browserAckResult = this.browserAdapter.deliverResultAndAwaitAck({
          windowIndex: tabInfo.windowIndex,
          tabIndex: tabInfo.tabIndex,
          messageText: returnMsg,
          expectedAckPrefix,
          timeoutMs
        });
      } catch (ackErr) {
        markUnknownDelivery(exchange, `Browser delivery/ACK failed: ${ackErr.message}`);
        return this._buildReturn(false, exchange, ackErr.message);
      }

      console.log(`[Controller] Browser ACK observed in ${browserAckResult.durationMs}ms: ${browserAckResult.ackText}`);

      // 12. 终态：Browser 确认完成
      transitionExchange(exchange, PHASES.BROWSER_ACKNOWLEDGED, {
        evidence: `Browser ACK verified in ${browserAckResult.durationMs}ms: "${browserAckResult.ackText.substring(0, 40)}..."`
      });


      return this._buildReturn(true, exchange, null, {
        capturedEnvelope: captured.envelope,
        ideResult: idePollResult.result,
        browserAck: browserAckResult.ackText
      });

    } catch (err) {
      // 若当前阶段尚未阻断，则置为 BLOCKED
      if (exchange.phase !== PHASES.BLOCKED && exchange.phase !== PHASES.UNKNOWN_DELIVERY) {
        markBlocked(exchange, err.message, { needs_human: true });
      }
      return this._buildReturn(false, exchange, err.message);
    }
  }

  _buildReturn(success, exchange, error = null, extra = {}) {
    return {
      success,
      error,
      binding: this.binding,
      exchange,
      statusDump: formatStatusDump(this.binding, exchange),
      compactStatus: formatCompactStatus(this.binding, exchange),
      ...extra
    };
  }
}
