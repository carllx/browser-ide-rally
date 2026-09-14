import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTChromeAdapter } from '../../src/adapters/browser/chatgpt-chrome.js';

test('[unit] Security Negative Test: Browser 0 matches fails closed', () => {
  const fakeExecutor = () => 'ERROR:ZERO_MATCHES';
  const adapter = new ChatGPTChromeAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.locateExactConversationTab('conv-missing');
  }, /TARGET_LOOKUP_FAIL: No Chrome tab found/);
});

test('[unit] Security Negative Test: Browser ambiguous matches (>1) fails closed', () => {
  const fakeExecutor = () => 'ERROR:AMBIGUOUS_MATCHES:2';
  const adapter = new ChatGPTChromeAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.locateExactConversationTab('conv-duplicate');
  }, /TARGET_LOOKUP_FAIL: Multiple Chrome tabs match/);
});

test('[unit] Security Negative Test: Browser draft guard blocks execution', () => {
  const fakeExecutor = (script) => {
    return JSON.stringify({
      url: 'https://chatgpt.com/c/conv-123',
      hasPrompt: true,
      promptDraft: 'Unsent user thought...',
      isGenerating: false
    });
  };
  const adapter = new ChatGPTChromeAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.checkPreflight(1, 1, 'conv-123');
  }, /PREFLIGHT_FAIL: Unsent draft present/);
});

test('[unit] Security Negative Test: Browser busy guard blocks execution', () => {
  const fakeExecutor = (script) => {
    return JSON.stringify({
      url: 'https://chatgpt.com/c/conv-123',
      hasPrompt: true,
      promptDraft: '',
      isGenerating: true
    });
  };
  const adapter = new ChatGPTChromeAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.checkPreflight(1, 1, 'conv-123');
  }, /PREFLIGHT_FAIL: ChatGPT is currently generating/);
});

test('[unit] Security Negative Test: Wrong Browser conversation URL blocks execution', () => {
  const fakeExecutor = (script) => {
    return JSON.stringify({
      url: 'https://chatgpt.com/c/wrong-conv-999',
      hasPrompt: true,
      promptDraft: '',
      isGenerating: false
    });
  };
  const adapter = new ChatGPTChromeAdapter({ executor: fakeExecutor });
  assert.throws(() => {
    adapter.checkPreflight(1, 1, 'conv-123');
  }, /PREFLIGHT_FAIL: Target tab URL/);
});

test('[unit] BrowserAdapter: captureAssistantTurnBaseline captures message count and IDs', () => {
  const fakeExecutor = () => {
    return JSON.stringify({
      assistantTurnCount: 3,
      assistantTurnIds: ['msg-1', 'msg-2', 'msg-3']
    });
  };
  const adapter = new ChatGPTChromeAdapter({ executor: fakeExecutor });
  const baseline = adapter.captureAssistantTurnBaseline(1, 1);
  assert.equal(baseline.assistantTurnCount, 3);
  assert.deepEqual(baseline.assistantTurnIds, ['msg-1', 'msg-2', 'msg-3']);
});
