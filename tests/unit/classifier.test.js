import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimaryClassifier } from '../../src/tampermonkey/primary-classifier.js';
import { STREAM_CLASS } from '../../src/tampermonkey/constants.js';

test('PrimaryClassifier.extractAssistantMessageId: extracts assistant UUID', () => {
  const assistantChunk = {
    message: {
      id: '1efa0234-58fd-44ca-adec-4a3bb6af573c',
      author: { role: 'assistant' }
    }
  };
  const extracted = PrimaryClassifier.extractAssistantMessageId(assistantChunk);
  assert.equal(extracted, '1efa0234-58fd-44ca-adec-4a3bb6af573c');
});

test('PrimaryClassifier.extractAssistantMessageId: rejects user, system, tool IDs', () => {
  const userChunk = {
    message: {
      id: 'user-message-id-1234567890',
      author: { role: 'user' }
    }
  };
  const toolChunk = {
    message: {
      id: 'tool-call-id-1234567890',
      author: { role: 'tool' }
    }
  };
  const systemChunk = {
    message: {
      id: 'system-prompt-id-1234567890',
      author: { role: 'system' }
    }
  };

  assert.equal(PrimaryClassifier.extractAssistantMessageId(userChunk), null);
  assert.equal(PrimaryClassifier.extractAssistantMessageId(toolChunk), null);
  assert.equal(PrimaryClassifier.extractAssistantMessageId(systemChunk), null);
});

test('PrimaryClassifier.evaluateStreamClass: classifies as PRIMARY_GENERATION when assistant id and convId exist', () => {
  const state = {
    hasConversationId: true,
    assistantMessageId: '1efa0234-58fd-44ca-adec-4a3bb6af573c',
    meaningfulDeltaCount: 3,
    totalChunksCount: 5,
    hasDoneMarker: false
  };
  assert.equal(PrimaryClassifier.evaluateStreamClass(state), STREAM_CLASS.PRIMARY_GENERATION);
});

test('PrimaryClassifier.evaluateStreamClass: classifies auxiliary short stream as AUXILIARY_STREAM', () => {
  const state = {
    hasConversationId: false,
    assistantMessageId: null,
    meaningfulDeltaCount: 0,
    totalChunksCount: 1,
    hasDoneMarker: false
  };
  assert.equal(PrimaryClassifier.evaluateStreamClass(state), STREAM_CLASS.AUXILIARY_STREAM);
});

test('PrimaryClassifier.evaluateStreamClass: returns UNKNOWN when evidence is ambiguous', () => {
  const state = {
    hasConversationId: false,
    assistantMessageId: null,
    meaningfulDeltaCount: 0,
    totalChunksCount: 0,
    hasDoneMarker: false
  };
  assert.equal(PrimaryClassifier.evaluateStreamClass(state), STREAM_CLASS.UNKNOWN);
});
