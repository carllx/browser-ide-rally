/**
 * ChatGPT Browser Adapter 单元与契约测试
 * 
 * 验证重点：
 * 1. 精确会话定位：唯一匹配成功返回坐标；0 匹配或多匹配严格 fail-closed；
 * 2. 生成中生命周期守卫：scoped button[data-testid="stop-button"] 激活时拒绝提交完成游标；
 * 3. 占位与未识别轮次守卫：无 data-message-id 或 placeholder 前缀时 fail-closed；
 * 4. 可靠完成：生成结束且具备稳定 message-id 时，输出受信任观察与不透明游标；
 * 5. 空会话：无 assistant 消息时受信任且游标为 null；
 * 6. DOM 探测异常与 AppleScript 错误捕获：安全 fail-closed。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTBrowserAdapter } from '../../src/adapters/browser/chatgpt-browser-adapter.js';

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

  it('5. 生成中 (button[data-testid="stop-button"]) 时 fail-closed，绝不提交未完成游标', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      // 模拟 DOM 探测：ChatGPT 正在生成中
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

    assert.equal(obs.trusted, false);
    assert.equal(obs.latest_completed_cursor, null);
    assert.equal(obs.continuity_lost, true);
    assert.match(obs.reason, /generation_in_progress/);
  });

  it('6. 占位身份 (placeholder/无 message-id) 时 fail-closed，绝不提交为完成游标', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      // 模拟 DOM 探测：Assistant 消息还在占位，尚无 final data-message-id
      return JSON.stringify({
        isGenerating: false,
        assistantCount: 1,
        lastMessageId: null,
        hasValidLastMessage: false,
        isPlaceholder: true
      });
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, false);
    assert.equal(obs.latest_completed_cursor, null);
    assert.equal(obs.continuity_lost, true);
    assert.match(obs.reason, /placeholder_or_unidentified_turn/);
  });

  it('7. 成功捕获最终完成轮次，输出受信任观察与不透明游标 (opaque cursor)', () => {
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
    assert.equal(obs.latest_completed_cursor, `chatgpt_msg_${finalMsgUuid}`);
    assert.equal(obs.conversation_id, targetConvId);
    assert.equal(obs.binding_revision, 1);
    assert.ok(obs.completed_at);
  });

  it('8. 空会话（assistantCount === 0）受信任且完成游标为 null', () => {
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

  it('9. 浏览器未运行或执行探测脚本崩溃时 fail-closed', () => {
    const mockExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      throw new Error('Chrome AppleScript connection failed');
    };

    const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
    const obs = adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    assert.equal(obs.trusted, false);
    assert.equal(obs.latest_completed_cursor, null);
    assert.equal(obs.continuity_lost, true);
    assert.match(obs.reason, /dom_probe_failed/);
  });
});
