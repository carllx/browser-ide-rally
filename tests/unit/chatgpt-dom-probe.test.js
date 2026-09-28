/**
 * ChatGPT Browser DOM 探针兼容性专项测试 (ChatGPT DOM Probe Compatibility Suite)
 * 
 * 覆盖契约 (#34):
 * 1. 当前 live DOM: 支持 data-markdown-text-style="assistant-message" 与 data-chatgpt-selection-message-id；
 * 2. 现代 DOM 属性变体: 结合 data-chatgpt-search-unit-key="...:assistant" 与 data-chatgpt-search-message-ids；
 * 3. 遗留 DOM 安全回退 (Legacy Fallback): [data-message-author-role="assistant"] 与 data-message-id；
 * 4. 空会话 (No Assistant Message): assistantCount === 0 时受信任且游标为 null；
 * 5. 占位过滤 (Placeholder Rejection): placeholder-* 与 request-placeholder-* 严格拒绝，不可作为 completion cursor；
 * 6. 生成中暂态 (Generation in Progress): stop-button 存在时 is_generating=true 且 should_record=false，continuity_lost=false；
 * 7. 畸形 DOM / 无法解析 ID 严格 Fail-Closed: 绝不臆造完成游标；
 * 8. 探测时刻 URL 漂移安全 Fail-Closed。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  buildProbeScript,
  normalizeProbeResult
} from '../../src/adapters/browser/chatgpt-browser-scripts.js';

describe('ChatGPT Browser DOM 探针兼容性专项测试', () => {
  const targetConvId = '6aa8de2c-24c8-83ea-a807-4d7780add444';
  const targetUrl = `https://chatgpt.com/c/${targetConvId}`;

  function runProbeInDOM(html, { url = targetUrl, convId = targetConvId } = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously' });
    const probeScript = buildProbeScript(convId);
    const rawOutput = dom.window.eval(probeScript);
    const probeResult = JSON.parse(rawOutput);
    return {
      probeResult,
      normalized: normalizeProbeResult(probeResult, convId, 1)
    };
  }

  it('1. 当前 live DOM: 正确解析 data-chatgpt-selection-message-id 与 assistant-message', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-chatgpt-selection-message-id="msg-live-turn-1">
            <div data-markdown-text-style="assistant-message">
              <p>这是第一轮回复</p>
            </div>
          </div>
          <div data-chatgpt-selection-message-id="msg-live-turn-2">
            <div data-markdown-text-style="assistant-message">
              <p>这是第二轮最新回复</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.isGenerating, false);
    assert.equal(probeResult.assistantCount, 2);
    assert.equal(probeResult.lastMessageId, 'msg-live-turn-2');
    assert.equal(probeResult.hasValidLastMessage, true);
    assert.equal(probeResult.isPlaceholder, false);
    assert.match(probeResult.lastMessageText, /这是第二轮最新回复/);

    assert.equal(normalized.trusted, true);
    assert.equal(normalized.is_generating, false);
    assert.equal(normalized.continuity_lost, false);
    assert.equal(normalized.latest_completed_cursor, 'chatgpt_msg_msg-live-turn-2');
    assert.equal(normalized.latest_completed_result.cursor, 'chatgpt_msg_msg-live-turn-2');
    assert.match(normalized.latest_completed_result.text, /这是第二轮最新回复/);
  });

  it('2. 现代 DOM 属性变体: 支持 data-chatgpt-search-unit-key 与 search-message-ids', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="msg-search-id-0 msg-search-id-0">
            <div data-markdown-text-style="assistant-message">前序轮次</div>
          </div>
          <div data-chatgpt-search-unit-key="fallback-turn-1:2:assistant" data-chatgpt-search-message-ids="msg-search-id-1 msg-search-id-1">
            <div data-markdown-text-style="assistant-message">最新完成轮次</div>
          </div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.assistantCount, 2);
    assert.equal(probeResult.lastMessageId, 'msg-search-id-1');
    assert.equal(normalized.trusted, true);
    assert.equal(normalized.latest_completed_cursor, 'chatgpt_msg_msg-search-id-1');
  });

  it('3. 遗留 DOM 安全回退 (Legacy Fallback): 支持 data-message-author-role 与 data-message-id', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-message-author-role="user" data-message-id="user-msg-1">User prompt</div>
          <div data-message-author-role="assistant" data-message-id="legacy-msg-uuid-999">
            <div class="markdown">Legacy assistant response</div>
          </div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.assistantCount, 1);
    assert.equal(probeResult.lastMessageId, 'legacy-msg-uuid-999');
    assert.equal(probeResult.isPlaceholder, false);
    assert.equal(probeResult.lastMessageText, 'Legacy assistant response');

    assert.equal(normalized.trusted, true);
    assert.equal(normalized.latest_completed_cursor, 'chatgpt_msg_legacy-msg-uuid-999');
  });

  it('4. 空会话 (No Assistant Message): 只有用户消息或空白页面时返回受信任 null 游标', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-message-author-role="user">刚刚发送但尚未生成回复</div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.assistantCount, 0);
    assert.equal(probeResult.lastMessageId, null);
    assert.equal(probeResult.hasValidLastMessage, false);

    assert.equal(normalized.trusted, true);
    assert.equal(normalized.latest_completed_cursor, null);
    assert.equal(normalized.completed_at, null);
  });

  it('5. 占位消息过滤: placeholder-* 与 request-placeholder-* 严格 fail-closed', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-chatgpt-selection-message-id="request-placeholder-tool-use-id">
            <div data-markdown-text-style="assistant-message">工具调用中...</div>
          </div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.isPlaceholder, true);
    assert.equal(probeResult.lastMessageId, null);
    assert.equal(probeResult.hasValidLastMessage, false);

    assert.equal(normalized.trusted, false);
    assert.equal(normalized.continuity_lost, true);
    assert.equal(normalized.latest_completed_cursor, undefined);
    assert.match(normalized.reason, /placeholder_or_unidentified_turn/);
  });

  it('6. 生成中暂态 (Generation in progress): stop-button 存在时为运行时活动，绝非 continuity loss', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-chatgpt-selection-message-id="msg-streaming-id">
            <div data-markdown-text-style="assistant-message">正在流式输出中...</div>
          </div>
          <button data-testid="stop-button">Stop streaming</button>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.isGenerating, true);

    assert.equal(normalized.is_generating, true);
    assert.equal(normalized.should_record, false);
    assert.equal(normalized.trusted, false);
    assert.equal(normalized.continuity_lost, false);
    assert.equal(normalized.latest_completed_cursor, undefined);
    assert.match(normalized.reason, /generation_in_progress/);
  });

  it('7. 畸形 DOM / 无法解析 ID 严格 Fail-Closed，绝不臆造完成游标', () => {
    // 存在 assistant-message 内容，但容器缺失任何有效的 message ID 属性
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div>
            <div data-markdown-text-style="assistant-message">缺少 ID 的破损消息</div>
          </div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html);

    assert.equal(probeResult.isPlaceholder, true);
    assert.equal(probeResult.lastMessageId, null);
    assert.equal(probeResult.hasValidLastMessage, false);

    assert.equal(normalized.trusted, false);
    assert.equal(normalized.continuity_lost, true);
    assert.equal(normalized.latest_completed_cursor, undefined);
    assert.match(normalized.reason, /placeholder_or_unidentified_turn/);
  });

  it('8. 探测时刻 URL 漂移 (TOCTOU) 安全 Fail-Closed', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-chatgpt-selection-message-id="msg-123">
            <div data-markdown-text-style="assistant-message">回复内容</div>
          </div>
        </body>
      </html>
    `;

    const { probeResult, normalized } = runProbeInDOM(html, {
      url: 'https://chatgpt.com/c/different-navigated-conv-id'
    });

    assert.equal(probeResult.error, 'tab_url_mismatch_at_probe_time');
    assert.equal(normalized.trusted, false);
    assert.equal(normalized.continuity_lost, true);
    assert.match(normalized.reason, /tab_url_mismatch_at_probe_time/);
  });
});
