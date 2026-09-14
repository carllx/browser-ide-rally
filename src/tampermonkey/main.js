/**
 * Rally ChatGPT Runtime Event Detector — Entry Point
 */
import { EventBus } from './event-bus.js';
import { GenerationStore } from './generation-store.js';
import { MetricsCollector } from './metrics.js';
import { CompletionResolver } from './completion-resolver.js';
import { DomDetector } from './dom-detector.js';
import { NetworkDetector } from './network-detector.js';

export function initializeRallyRuntime(customVersion = '__RALLY_VERSION__') {
  if (typeof window === 'undefined') return null;
  if (window.__RALLY_RUNTIME__) return window.__RALLY_RUNTIME__;

  const eventBus = new EventBus();
  const store = new GenerationStore();
  const metrics = new MetricsCollector();
  const resolver = new CompletionResolver(eventBus, store, metrics);

  eventBus.on('any_event', (payload) => {
    metrics.recordEvent(payload);
  });

  const domDetector = new DomDetector(store, resolver);
  const networkDetector = new NetworkDetector(store, resolver, metrics);

  const runtimeApi = Object.freeze({
    version: customVersion,
    tabInstanceId: eventBus.tabInstanceId,
    eventBus,
    store,
    metrics,
    resolver,
    domDetector,
    networkDetector,

    /**
     * 机器可读的完整运行态报告
     */
    report() {
      return metrics.getReport(store, eventBus, customVersion, eventBus.tabInstanceId);
    },

    /**
     * 导出完整事件与 Session 原始数据
     */
    dump() {
      return {
        version: customVersion,
        tab_instance_id: eventBus.tabInstanceId,
        public_events: eventBus.getPublicEvents(),
        received_broadcast_events: eventBus.getReceivedEvents(),
        sessions: store.getAllSessions().map(s => ({
          local_generation_id: s.localGenId,
          conversation_id: s.conversationId,
          message_id: s.messageId,
          network_done: s.networkDone,
          dom_completed: s.domUiCompleted,
          user_stop_seen: s.userStopActionSeen,
          terminal_emitted: s.terminalEmitted,
          terminal_event: s.terminalEventType,
          confidence: s.evidenceConfidence
        })),
        timing_samples: metrics.primary_timing_diffs_ms
      };
    },

    /**
     * 重置当前测试运行数据
     */
    resetTestRun() {
      eventBus.reset();
      store.reset();
      metrics.reset();
      console.log('[Rally] 测试运行数据已重置');
      return true;
    }
  });

  window.__RALLY_RUNTIME__ = runtimeApi;
  console.log(`%c[Rally Runtime Event Detector v${customVersion} 初始化成功]`, 'color: #10b981; font-weight: bold;');
  return runtimeApi;
}

// 自动执行初始化
initializeRallyRuntime();
