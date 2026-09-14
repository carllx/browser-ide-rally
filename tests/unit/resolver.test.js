import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionResolver } from '../../src/tampermonkey/completion-resolver.js';
import { EventBus } from '../../src/tampermonkey/event-bus.js';
import { GenerationStore } from '../../src/tampermonkey/generation-store.js';
import { MetricsCollector } from '../../src/tampermonkey/metrics.js';
import { EVENTS, CONFIDENCE } from '../../src/tampermonkey/constants.js';

function setup() {
  const eventBus = new EventBus('test_tab');
  const store = new GenerationStore();
  const metrics = new MetricsCollector();
  const resolver = new CompletionResolver(eventBus, store, metrics);
  return { eventBus, store, metrics, resolver };
}

test('Resolver: DONE + DOM -> confirmed exactly once', () => {
  const { eventBus, store, resolver } = setup();
  const session = store.createSession('conv-1');

  resolver.onNetworkStarted(session);
  assert.equal(eventBus.getPublicEvents().length, 1);
  assert.equal(eventBus.getPublicEvents()[0].event, EVENTS.STARTED);

  // Network DONE
  session.networkDoneTimeMs = 1000;
  resolver.onNetworkDone(session);

  // DOM Stop removed
  session.domStopTimeMs = 1022;
  session.domUiCompleted = true;
  resolver.onDomUiCompleted(session);

  const completedEvents = eventBus.getPublicEvents().filter(e => e.event === EVENTS.COMPLETED);
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].confidence, CONFIDENCE.CONFIRMED);
  assert.deepEqual(completedEvents[0].sources, ['network', 'dom']);
});

test('Resolver: DONE + no DOM after grace -> network_only exactly once', async () => {
  const { eventBus, store, resolver } = setup();
  const session = store.createSession('conv-1');

  resolver.onNetworkStarted(session);
  resolver.onNetworkDone(session);

  // 等待超过 400ms Grace Window
  await new Promise(r => setTimeout(r, 450));

  const completedEvents = eventBus.getPublicEvents().filter(e => e.event === EVENTS.COMPLETED);
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].confidence, CONFIDENCE.NETWORK_ONLY);
  assert.equal(completedEvents[0].dom_confirmation_missing, true);
});

test('Resolver: late DOM upgrades evidence but emits no second completed', async () => {
  const { eventBus, store, resolver } = setup();
  const session = store.createSession('conv-1');

  resolver.onNetworkStarted(session);
  session.networkDoneTimeMs = 1000;
  resolver.onNetworkDone(session);

  // 等待超时，触发 network_only
  await new Promise(r => setTimeout(r, 450));
  assert.equal(eventBus.getPublicEvents().filter(e => e.event === EVENTS.COMPLETED).length, 1);

  // 晚到 DOM 到达
  session.domStopTimeMs = 1900;
  session.domUiCompleted = true;
  resolver.onDomUiCompleted(session);

  // 关键校验：绝不能发射第二个 completed 事件！
  const allCompleted = eventBus.getPublicEvents().filter(e => e.event === EVENTS.COMPLETED);
  assert.equal(allCompleted.length, 1);
  // 但内部 session evidence 升级为 confirmed
  assert.equal(session.evidenceConfidence, CONFIDENCE.CONFIRMED);
});

test('Resolver: Stop click alone does not emit stopped_by_user', () => {
  const { eventBus, store } = setup();
  const session = store.createSession('conv-1');

  // 用户点击 Stop 按钮
  session.userStopActionSeen = true;

  // 关键校验：此时没有任何终态事件发出！
  const terminals = eventBus.getPublicEvents().filter(e =>
    [EVENTS.COMPLETED, EVENTS.STOPPED_BY_USER, EVENTS.INTERRUPTED].includes(e.event)
  );
  assert.equal(terminals.length, 0);
  assert.equal(session.terminalEmitted, false);
});

test('Resolver: Stop + stream termination without DONE -> stopped_by_user', () => {
  const { eventBus, store, resolver } = setup();
  const session = store.createSession('conv-1');

  resolver.onNetworkStarted(session);
  session.userStopActionSeen = true;

  // 流在没有 [DONE] 的情况下中断关闭
  resolver.onStreamClosedWithoutDone(session);

  const events = eventBus.getPublicEvents();
  const stoppedEv = events.find(e => e.event === EVENTS.STOPPED_BY_USER);
  assert.ok(stoppedEv);
  assert.equal(stoppedEv.confidence, CONFIDENCE.CONFIRMED);
  assert.equal(session.terminalEmitted, true);
});

test('Resolver: Stop + later normal DONE -> completed wins', () => {
  const { eventBus, store, resolver } = setup();
  const session = store.createSession('conv-1');

  resolver.onNetworkStarted(session);
  // 用户点击了 Stop，但流实际上已经收到了 [DONE]（或同时到达）
  session.userStopActionSeen = true;
  session.domUiCompleted = true;

  resolver.onNetworkDone(session);

  const completedEv = eventBus.getPublicEvents().find(e => e.event === EVENTS.COMPLETED);
  assert.ok(completedEv);
  assert.equal(completedEv.confidence, CONFIDENCE.CONFIRMED);
  assert.equal(eventBus.getPublicEvents().find(e => e.event === EVENTS.STOPPED_BY_USER), undefined);
});
