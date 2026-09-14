import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationStore } from '../../src/tampermonkey/generation-store.js';
import { CONFIDENCE } from '../../src/tampermonkey/constants.js';

test('GenerationStore: creates session and updates conversation_id from new_chat_pending', () => {
  const store = new GenerationStore();
  const session = store.createSession('new_chat_pending');

  assert.equal(session.conversationId, 'new_chat_pending');
  assert.equal(session.messageId, null);

  // 路由跳转后更新为实际 UUID
  session.bindConversationId('6aa852d6-f6f0-83e8-aa9d-cc55983cb81b');
  assert.equal(session.conversationId, '6aa852d6-f6f0-83e8-aa9d-cc55983cb81b');

  // 多次绑定不改变同一 generation
  session.bindConversationId('6aa852d6-f6f0-83e8-aa9d-cc55983cb81b');
  assert.equal(store.getAllSessions().length, 1);
});

test('GenerationStore: binds assistant message_id without duplicating session', () => {
  const store = new GenerationStore();
  const session = store.createSession('conv-123');

  session.bindAssistantMessageId('mid-abc-456');
  assert.equal(session.messageId, 'mid-abc-456');

  // 重复绑定同一 ID
  session.bindAssistantMessageId('mid-abc-456');
  assert.equal(session.messageId, 'mid-abc-456');
  assert.equal(store.getAllSessions().length, 1);
});

test('GenerationStore: upgradeEvidenceToConfirmed only upgrades network_only once', () => {
  const store = new GenerationStore();
  const session = store.createSession('conv-123');

  session.markTerminalEmitted('response.completed', CONFIDENCE.NETWORK_ONLY);
  assert.equal(session.evidenceConfidence, CONFIDENCE.NETWORK_ONLY);

  const upgraded = session.upgradeEvidenceToConfirmed();
  assert.equal(upgraded, true);
  assert.equal(session.evidenceConfidence, CONFIDENCE.CONFIRMED);

  // 再次升级返回 false
  assert.equal(session.upgradeEvidenceToConfirmed(), false);
});
