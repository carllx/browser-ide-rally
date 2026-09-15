/**
 * ChatGPT Browser Adapter 单元与契约测试
 * 
 * 验证重点：
 * 1. 精确会话定位：唯一匹配成功返回坐标；0 匹配或多匹配严格 fail-closed；
 * 2. 子串误判防护：URL 中包含 conversationId 作为子串或查询参数时拒绝作为匹配；
 * 3. 探针时刻 URL 重验与 TOCTOU 消除：探测执行瞬间若 URL 发生变化，立即 fail-closed；
 * 4. 严格过滤 request-placeholder-* 与 placeholder-*：即使生成结束，也绝不将其作为 completion cursor；
 * 5. 正常生成中 (button[data-testid="stop-button"])：视为运行时活动，continuity_lost=false，不可污染或清空已有事实；
 * 6. 可靠完成：生成结束且具备稳定非占位 message-id 时，输出受信任观察与不透明游标；
 * 7. 空会话：无 assistant 消息时受信任且游标为 null；
 * 8. DOM 探测异常与 AppleScript 错误捕获：安全 fail-closed。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatGPTBrowserAdapter,
  isExactConversationUrl,
  isPlaceholderMessageId
} from '../../src/adapters/browser/chatgpt-browser-adapter.js';

describe('ChatGPTBrowserAdapter 单元与契约测试', () => {
  const targetConvId = '6aa8de2c-24c8-83ea-a807-4d7780add444';

  it('1. 精确匹配唯一标签页成功解析 window 与 tab 索引', () => {
    const mockExecutor = (script) => {
      assert.ok(script.includes(targetConvId));
      return `SUCCESS:1:2:https://chatgpt.com/g/g-p-123/c/${targetConvId}`;
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const loc = adapter.locateExactConversationTab(targetConvId);

    assert.equal(loc.windowIndex, 1);
    assert.equal(loc.tabIndex, 2);
    assert.equal(loc.url, `https://chatgpt.com/g/g-p-123/c/${targetConvId}`);
  });

  it('2. 标签页 0 匹配时严格 fail-closed 抛出明确异常', () => {
    const mockExecutor = () => 'ERROR:ZERO_MATCHES';
    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });

    assert.throws(
      () => adapter.locateExactConversationTab('missing-conv-id'),
      /TARGET_LOOKUP_FAIL: No Chrome tab found matching conversation/
    );
  });

  it('3. 标签页多重匹配（含歧义）时严格 fail-closed 抛出明确异常', () => {
    const mockExecutor = () => 'ERROR:AMBIGUOUS_MATCHES:2';
    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });

    assert.throws(
      () => adapter.locateExactConversationTab('ambiguous-conv-id'),
      /TARGET_LOOKUP_FAIL: Ambiguous match: 2 tabs match conversation/
    );
  });

  it('4. 会话 ID 为空或非法时拒绝查找', () => {
    const adapter = new ChatGPTBrowserAdapter({ executor: () => '' });
    assert.throws(() => adapter.locateExactConversationTab(''), /TARGET_LOOKUP_FAIL/);
    assert.throws(() => adapter.locateExactConversationTab(null), /TARGET_LOOKUP_FAIL/);
  });

  it('5. 纯函数 isExactConversationUrl 正确区分标准/GPT 路径与子串假阳性', () => {
    // 合法路径（限定官方域名）
    assert.equal(isExactConversationUrl(`https://chatgpt.com/c/${targetConvId}`, targetConvId), true);
    assert.equal(isExactConversationUrl(`https://chatgpt.com/g/g-p-123/c/${targetConvId}`, targetConvId), true);
    assert.equal(isExactConversationUrl(`https://chat.openai.com/c/${targetConvId}`, targetConvId), true);
    assert.equal(isExactConversationUrl(`https://chatgpt.com/c/${targetConvId}?param=1`, targetConvId), true);
    assert.equal(isExactConversationUrl(`https://chatgpt.com/c/${targetConvId}#bottom`, targetConvId), true);

    // 假阳性 / 子串 / 参数伪造 / 非官方域名
    assert.equal(isExactConversationUrl(`https://chatgpt.com/c/${targetConvId}-extra`, targetConvId), false);
    assert.equal(isExactConversationUrl(`https://chatgpt.com/c/prefix-${targetConvId}`, targetConvId), false);
    assert.equal(isExactConversationUrl(`https://chatgpt.com/search?q=${targetConvId}`, targetConvId), false);
    assert.equal(isExactConversationUrl(`https://other.com/c/${targetConvId}`, targetConvId), false); // 非官方域名严格拒绝
    assert.equal(isExactConversationUrl('', targetConvId), false);
    assert.equal(isExactConversationUrl(null, targetConvId), false);
  });

  it('6. 纯函数 isPlaceholderMessageId 严格识别空值、placeholder 及 request-placeholder-*', () => {
    // 占位家族
    assert.equal(isPlaceholderMessageId('request-placeholder-123'), true);
    assert.equal(isPlaceholderMessageId('request-placeholder-tool-call'), true);
    assert.equal(isPlaceholderMessageId('placeholder-456'), true);
    assert.equal(isPlaceholderMessageId(''), true);
    assert.equal(isPlaceholderMessageId('   '), true);
    assert.equal(isPlaceholderMessageId(null), true);
    assert.equal(isPlaceholderMessageId(undefined), true);

    // 真正完成的 message-id
    assert.equal(isPlaceholderMessageId('e9f921d8-bbb7-4535-9897-1d0e93378ff9'), false);
    assert.equal(isPlaceholderMessageId('0b01c43a-2ca6-4c1a-8b1e-e2823f8c03f6'), false);
  });

  it('7. 验证实机 request-placeholder-* 在生成结束后绝不能成为 completion cursor (Gate 1)', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: false, // 生成已停止
        assistantCount: 2,
        lastMessageId: 'request-placeholder-tool-use-uuid',
        hasValidLastMessage: true,
        isPlaceholder: true // 适配器内嵌或 probe 标记
      });
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, false);
    assert.equal(obs.latest_completed_cursor, undefined);
    assert.equal(obs.continuity_lost, true);
    assert.match(obs.reason, /placeholder_or_unidentified_turn/);
  });

  it('8. 探测时刻 URL 发生变更 (TOCTOU) 时严格 fail-closed (Gate 2)', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        error: 'tab_url_mismatch_at_probe_time',
        currentUrl: 'https://chatgpt.com/c/different-navigated-conversation',
        expectedConvId: targetConvId
      });
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, false);
    assert.equal(obs.latest_completed_cursor, undefined);
    assert.equal(obs.continuity_lost, true);
    assert.match(obs.reason, /tab_url_mismatch_at_probe_time/);
  });

  it('9. 正常生成中 (stop-button) 为运行时活动，continuity_lost=false 绝非连续性丢失 (Gate 3)', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: true,
        assistantCount: 2,
        lastMessageId: 'streaming-temp-id',
        hasValidLastMessage: true,
        isPlaceholder: false
      });
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.is_generating, true);
    assert.equal(obs.should_record, false); // 核心：runtime-only，不可录入 Core
    assert.equal(obs.trusted, false); // 绝不升级 trusted
    assert.equal(obs.continuity_lost, false); // 核心：绝非 continuity loss！
    assert.equal(obs.latest_completed_cursor, undefined);
    assert.match(obs.reason, /generation_in_progress/);
  });

  it('10. 成功捕获最终完成轮次，输出受信任观察与不透明游标 (opaque cursor)', () => {
    const finalMsgUuid = 'e9f921d8-bbb7-4535-9897-1d0e93378ff9';
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: false,
        assistantCount: 4,
        lastMessageId: finalMsgUuid,
        hasValidLastMessage: true,
        isPlaceholder: false
      });
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, true);
    assert.equal(obs.is_generating, false);
    assert.equal(obs.continuity_lost, false);
    assert.equal(obs.latest_completed_cursor, `chatgpt_msg_${finalMsgUuid}`);
    assert.equal(obs.conversation_id, targetConvId);
    assert.equal(obs.binding_revision, 1);
    assert.ok(obs.completed_at);
  });

  it('11. 空会话（assistantCount === 0）受信任且完成游标为 null', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: false,
        assistantCount: 0,
        lastMessageId: null,
        hasValidLastMessage: false,
        isPlaceholder: false
      });
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, true);
    assert.equal(obs.latest_completed_cursor, null);
    assert.equal(obs.completed_at, null);
  });

  it('12. 浏览器执行探针崩溃或底层 AppleScript 抛出异常时 fail-closed', () => {
    const mockExecutor = () => {
      throw new Error('AppleScript process terminated unexpectedly');
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, false);
    assert.equal(obs.latest_completed_cursor, undefined);
    assert.equal(obs.continuity_lost, true);
    assert.match(obs.reason, /AppleScript process terminated/);
  });
});
