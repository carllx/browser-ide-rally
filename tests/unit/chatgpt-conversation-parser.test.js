/**
 * ChatGPT 会话链接解析与归一化单一共享模块单元测试 (#39)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChatGPTConversationUrl,
  normalizeChatGPTConversationInput,
  CHATGPT_URL_PATTERN,
  CHATGPT_TOKEN_PATTERN
} from '../../src/surface/chatgpt-conversation-parser.js';

describe('Issue #39: ChatGPT Conversation URL & Input Normalization Authority', () => {
  describe('1. 严格 URL 解析器 (parseChatGPTConversationUrl - Onboarding 契约)', () => {
    test('正确解析标准 chatgpt.com URL', () => {
      assert.equal(
        parseChatGPTConversationUrl('https://chatgpt.com/c/6774a3f1-0001-4000-8000-000000000001'),
        '6774a3f1-0001-4000-8000-000000000001'
      );
    });

    test('正确解析旧版 chat.openai.com URL', () => {
      assert.equal(
        parseChatGPTConversationUrl('https://chat.openai.com/c/conv-classic-123'),
        'conv-classic-123'
      );
    });

    test('正确解析 Custom GPT 路径 URL', () => {
      assert.equal(
        parseChatGPTConversationUrl('https://chatgpt.com/g/g-2DQzUNuik-code-copilot/c/conv-custom-gpt-456'),
        'conv-custom-gpt-456'
      );
    });

    test('正确解析携带查询参数与锚点的 URL', () => {
      assert.equal(
        parseChatGPTConversationUrl('https://chatgpt.com/c/conv-params-789?model=gpt-4o#bottom'),
        'conv-params-789'
      );
      assert.equal(
        parseChatGPTConversationUrl('https://chatgpt.com/c/conv-trailing-slash/'),
        'conv-trailing-slash'
      );
    });

    test('拒绝裸 ID、相对路径与非 ChatGPT URL', () => {
      assert.throws(() => parseChatGPTConversationUrl('conv-plain-id-only'), /Invalid ChatGPT conversation URL/i);
      assert.throws(() => parseChatGPTConversationUrl('/c/conv-relative-123'), /Invalid ChatGPT conversation URL/i);
      assert.throws(() => parseChatGPTConversationUrl('https://google.com/search?q=chatgpt'), /Invalid ChatGPT conversation URL/i);
      assert.throws(() => parseChatGPTConversationUrl(''), /Invalid ChatGPT conversation URL/i);
      assert.throws(() => parseChatGPTConversationUrl(null), /Invalid ChatGPT conversation URL/i);
    });
  });

  describe('2. 归一化输入解析器 (normalizeChatGPTConversationInput - Browser Rebind 契约)', () => {
    test('支持标准 chatgpt.com URL 并提取 exact ID', () => {
      assert.equal(
        normalizeChatGPTConversationInput('https://chatgpt.com/c/6774a3f1-0001-4000-8000-000000000001'),
        '6774a3f1-0001-4000-8000-000000000001'
      );
    });

    test('支持旧版 chat.openai.com URL 并提取 exact ID', () => {
      assert.equal(
        normalizeChatGPTConversationInput('https://chat.openai.com/c/conv-classic-123'),
        'conv-classic-123'
      );
    });

    test('支持 Custom GPTs 路径 URL 并提取 exact ID', () => {
      assert.equal(
        normalizeChatGPTConversationInput('https://chatgpt.com/g/g-2DQzUNuik-code-copilot/c/conv-custom-gpt-456'),
        'conv-custom-gpt-456'
      );
    });

    test('支持带 query、hash 与尾部斜杠的 URL 并归一化为相同的 exact ID', () => {
      const targetId = '6774a3f1-0001-4000-8000-000000000001';
      assert.equal(
        normalizeChatGPTConversationInput(`https://chatgpt.com/c/${targetId}?model=gpt-4o#bottom`),
        targetId
      );
      assert.equal(
        normalizeChatGPTConversationInput(`https://chatgpt.com/c/${targetId}/`),
        targetId
      );
      assert.equal(
        normalizeChatGPTConversationInput(`  https://chatgpt.com/c/${targetId}   `),
        targetId
      );
    });

    test('支持合法的 Bare Exact ID (纯会话 ID)', () => {
      assert.equal(
        normalizeChatGPTConversationInput('6774a3f1-0001-4000-8000-000000000001'),
        '6774a3f1-0001-4000-8000-000000000001'
      );
      assert.equal(
        normalizeChatGPTConversationInput('conv-valid_ID-123'),
        'conv-valid_ID-123'
      );
    });

    test('严格 Fail-Closed：非 ChatGPT 域名与类 URL/路径字符串绝不 Fall-Through 为裸 ID', () => {
      const invalidInputs = [
        'https://google.com/search?q=chatgpt',
        'https://chatgpt.com/',
        'https://chatgpt.com/c/',
        'https://evil.com/c/fake-id',
        '/c/conv-relative-path-123',
        'chatgpt.com/c/conv-no-protocol-123',
        'https://chat.openai.com/gpts',
        'http://localhost:3000/c/conv-local',
        'ftp://chatgpt.com/c/conv-ftp'
      ];

      for (const input of invalidInputs) {
        assert.throws(
          () => normalizeChatGPTConversationInput(input),
          /INVALID_CHATGPT_CONVERSATION/,
          `输入 "${input}" 必须被严格拒绝，绝不能被解析为裸 ID`
        );
      }
    });

    test('严格 Fail-Closed：包含非法字符的非 URL 字符串被拒绝', () => {
      const invalidTokens = [
        'conv id with space',
        'conv!@#$',
        'conv<script>',
        'conv;rm -rf',
        'conv"quoted"',
        ''
      ];

      for (const token of invalidTokens) {
        assert.throws(
          () => normalizeChatGPTConversationInput(token),
          /INVALID_CHATGPT_CONVERSATION/
        );
      }
    });
  });
});
