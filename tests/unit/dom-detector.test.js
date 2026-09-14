import test from 'node:test';
import assert from 'node:assert/strict';
import { DomDetector } from '../../src/tampermonkey/dom-detector.js';
import { GenerationStore } from '../../src/tampermonkey/generation-store.js';

test('DomDetector: DOM absence without prior Stop presence -> no ui_completed', () => {
  const store = new GenerationStore();
  const session = store.createSession('conv-1');

  let uiCompletedTriggered = false;
  const mockResolver = {
    onDomUiCompleted: () => { uiCompletedTriggered = true; }
  };

  // 构造 detector 并重写 findStopControl
  const detector = Object.create(DomDetector.prototype);
  detector.store = store;
  detector.resolver = mockResolver;
  detector.findStopControl = () => null; // 始终没有 Stop

  detector.handleMutations();
  assert.equal(session.stopSeenForGeneration, false);
  assert.equal(session.domUiCompleted, false);
  assert.equal(uiCompletedTriggered, false);
});

test('DomDetector: Stop transition absent -> PRESENT -> ABSENT triggers ui_completed', () => {
  const store = new GenerationStore();
  const session = store.createSession('conv-1');

  let uiCompletedTriggered = false;
  const mockResolver = {
    onDomUiCompleted: () => { uiCompletedTriggered = true; }
  };

  const detector = Object.create(DomDetector.prototype);
  detector.store = store;
  detector.resolver = mockResolver;

  // 1. 模拟 Stop 出现 (PRESENT)
  detector.findStopControl = () => ({});
  detector.handleMutations();
  assert.equal(session.stopSeenForGeneration, true);
  assert.equal(session.domUiCompleted, false);
  assert.equal(uiCompletedTriggered, false);

  // 2. 模拟 Stop 消失 (ABSENT)
  detector.findStopControl = () => null;
  detector.handleMutations();
  assert.equal(session.domUiCompleted, true);
  assert.equal(uiCompletedTriggered, true);
});
