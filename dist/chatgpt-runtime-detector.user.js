// ==UserScript==
// @name         ChatGPT Runtime Event Detector (Rally Prototype)
// @namespace    https://github.com/carllx/browser-ide-rally
// @version      0.3.0
// @description  ChatGPT Web 运行时双探测器生命周期感知原型 (Phase 3)
// @author       Rally Team
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/carllx/browser-ide-rally/main/dist/chatgpt-runtime-detector.user.js
// @downloadURL  https://raw.githubusercontent.com/carllx/browser-ide-rally/main/dist/chatgpt-runtime-detector.user.js
// ==/UserScript==

(() => {
  // src/tampermonkey/constants.js
  var STREAM_CLASS = Object.freeze({
    PRIMARY_GENERATION: "PRIMARY_GENERATION",
    AUXILIARY_STREAM: "AUXILIARY_STREAM",
    UNKNOWN: "UNKNOWN"
  });
  var EVENTS = Object.freeze({
    STARTED: "response.started",
    NETWORK_COMPLETED: "response.network_completed",
    UI_COMPLETED: "response.ui_completed",
    COMPLETED: "response.completed",
    STOPPED_BY_USER: "response.stopped_by_user",
    INTERRUPTED: "response.interrupted",
    FAILED: "response.failed"
  });
  var CONFIDENCE = Object.freeze({
    CONFIRMED: "confirmed",
    NETWORK_ONLY: "network_only",
    DOM_ONLY: "dom_only"
  });
  var CONFIG = Object.freeze({
    GRACE_WINDOW_MS: 400,
    BROADCAST_CHANNEL_NAME: "chatgpt-runtime-events"
  });

  // src/tampermonkey/event-bus.js
  var EventBus = class {
    constructor(tabInstanceId = null) {
      this.tabInstanceId = tabInstanceId || "tab_" + Math.random().toString(36).substring(2, 9);
      this.publicEvents = [];
      this.receivedEvents = [];
      this.listeners = /* @__PURE__ */ new Map();
      if (typeof BroadcastChannel !== "undefined") {
        try {
          this.bc = new BroadcastChannel(CONFIG.BROADCAST_CHANNEL_NAME);
          this.bc.onmessage = (ev) => this.handleIncomingBroadcast(ev.data);
        } catch (e) {
          this.bc = null;
        }
      }
    }
    handleIncomingBroadcast(data) {
      if (!data || data.tab_instance_id === this.tabInstanceId) return;
      this.receivedEvents.push({
        received_at: (/* @__PURE__ */ new Date()).toISOString(),
        ...data
      });
      this.emitLocal("broadcast_received", data);
    }
    on(eventName, handler) {
      if (!this.listeners.has(eventName)) {
        this.listeners.set(eventName, []);
      }
      this.listeners.get(eventName).push(handler);
      return () => {
        const arr = this.listeners.get(eventName) || [];
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      };
    }
    emitLocal(eventName, payload) {
      const list = this.listeners.get(eventName) || [];
      for (const fn of list) {
        try {
          fn(payload);
        } catch (e) {
        }
      }
    }
    publish(eventType, session, sources, confidence, reason, extra = {}) {
      const payload = {
        tab_instance_id: this.tabInstanceId,
        local_generation_id: session?.localGenId || null,
        conversation_id: session?.conversationId || null,
        message_id: session?.messageId || null,
        event: eventType,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        confidence,
        sources,
        reason,
        ...extra
      };
      this.publicEvents.push(payload);
      this.emitLocal(eventType, payload);
      this.emitLocal("any_event", payload);
      if (this.bc) {
        try {
          this.bc.postMessage(payload);
        } catch (e) {
        }
      }
      return payload;
    }
    getPublicEvents() {
      return [...this.publicEvents];
    }
    getReceivedEvents() {
      return [...this.receivedEvents];
    }
    reset() {
      this.publicEvents.length = 0;
      this.receivedEvents.length = 0;
    }
  };

  // src/tampermonkey/generation-store.js
  var GenerationSession = class {
    constructor(localGenId, conversationId = null) {
      this.localGenId = localGenId;
      this.conversationId = conversationId;
      this.messageId = null;
      this.streamClass = null;
      this.networkStarted = false;
      this.networkDone = false;
      this.networkDoneTimeMs = null;
      this.stopSeenForGeneration = false;
      this.domUiCompleted = false;
      this.domStopTimeMs = null;
      this.userStopActionSeen = false;
      this.startedEmitted = false;
      this.terminalEmitted = false;
      this.terminalEventType = null;
      this.evidenceConfidence = null;
      this.graceTimer = null;
    }
    bindConversationId(cid) {
      if (cid && (!this.conversationId || this.conversationId === "new_chat_pending")) {
        this.conversationId = cid;
      }
    }
    bindAssistantMessageId(mid) {
      if (mid && !this.messageId) {
        this.messageId = mid;
      }
    }
    markTerminalEmitted(eventType, confidence) {
      this.terminalEmitted = true;
      this.terminalEventType = eventType;
      this.evidenceConfidence = confidence;
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
    }
    /**
     * 晚到 DOM 证据安全升级：只修改内部 evidence，严禁重复发射公开事件
     */
    upgradeEvidenceToConfirmed() {
      if (this.terminalEmitted && this.evidenceConfidence === CONFIDENCE.NETWORK_ONLY) {
        this.evidenceConfidence = CONFIDENCE.CONFIRMED;
        return true;
      }
      return false;
    }
  };
  var GenerationStore = class {
    constructor() {
      this.activeSession = null;
      this.history = [];
    }
    createSession(conversationId = null) {
      const localId = "gen_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
      const session = new GenerationSession(localId, conversationId);
      this.activeSession = session;
      this.history.push(session);
      return session;
    }
    getActiveSession() {
      return this.activeSession;
    }
    clearActiveSession(session) {
      if (this.activeSession === session) {
        this.activeSession = null;
      }
    }
    getAllSessions() {
      return [...this.history];
    }
    reset() {
      if (this.activeSession && this.activeSession.graceTimer) {
        clearTimeout(this.activeSession.graceTimer);
      }
      this.activeSession = null;
      this.history.length = 0;
    }
  };

  // src/tampermonkey/metrics.js
  var MetricsCollector = class {
    constructor() {
      this.historical_baseline = Object.freeze({
        normal_completed_provenance: 14,
        user_stopped_provenance: 2
      });
      this.primary_timing_diffs_ms = [];
      this.counters = {
        primary_generations: 0,
        auxiliary_streams_ignored: 0,
        confirmed_completions: 0,
        network_only_completions: 0,
        dom_only_completions: 0,
        stopped_by_user: 0,
        generic_interrupted: 0,
        duplicates_prevented: 0
      };
    }
    recordTimingDiff(session) {
      if (session && session.networkDoneTimeMs && session.domStopTimeMs) {
        const diff = +(session.domStopTimeMs - session.networkDoneTimeMs).toFixed(1);
        this.primary_timing_diffs_ms.push(diff);
      }
    }
    recordAuxiliaryIgnored() {
      this.counters.auxiliary_streams_ignored++;
    }
    recordEvent(eventPayload) {
      const ev = eventPayload.event;
      const conf = eventPayload.confidence;
      if (ev === "response.started") {
        this.counters.primary_generations++;
      } else if (ev === "response.completed") {
        if (conf === "confirmed") this.counters.confirmed_completions++;
        else if (conf === "network_only") this.counters.network_only_completions++;
        else if (conf === "dom_only") this.counters.dom_only_completions++;
      } else if (ev === "response.stopped_by_user") {
        this.counters.stopped_by_user++;
      } else if (ev === "response.interrupted") {
        this.counters.generic_interrupted++;
      }
    }
    calculatePercentiles() {
      const arr = this.primary_timing_diffs_ms;
      if (arr.length === 0) return { median: null, p95: null, max: null };
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted[sorted.length - 1]
      };
    }
    getReport(store, eventBus, version, tabInstanceId) {
      const timing = this.calculatePercentiles();
      const currentNormal = this.counters.confirmed_completions + this.counters.network_only_completions + this.counters.dom_only_completions;
      const totalNormalWithBaseline = this.historical_baseline.normal_completed_provenance + currentNormal;
      return {
        runtime_version: version,
        tab_instance_id: tabInstanceId,
        gate_status: {
          current_candidate_normal: currentNormal,
          historical_baseline_normal: this.historical_baseline.normal_completed_provenance,
          cumulative_normal_total: totalNormalWithBaseline,
          gate_target: 20,
          pass_normal_gate: totalNormalWithBaseline >= 20,
          stopped_by_user: this.counters.stopped_by_user,
          generic_interruption_samples: this.counters.generic_interrupted,
          // 关键修复 G：没有负样本真实 ground truth 前，标记 NOT YET VALIDATED
          generic_interruption_status: this.counters.generic_interrupted > 0 ? "VALIDATED_IN_SESSION" : "NOT YET VALIDATED",
          auxiliary_streams_safely_ignored: this.counters.auxiliary_streams_ignored,
          duplicates_prevented: this.counters.duplicates_prevented
        },
        timing_primary_only: {
          samples_count: this.primary_timing_diffs_ms.length,
          median_ms: timing.median,
          p95_ms: timing.p95,
          max_ms: timing.max,
          raw_samples: [...this.primary_timing_diffs_ms]
        },
        counters: { ...this.counters },
        public_events: eventBus ? eventBus.getPublicEvents() : [],
        received_broadcast_events: eventBus ? eventBus.getReceivedEvents() : [],
        sessions_count: store ? store.getAllSessions().length : 0
      };
    }
    reset() {
      this.primary_timing_diffs_ms.length = 0;
      Object.keys(this.counters).forEach((k) => this.counters[k] = 0);
    }
  };

  // src/tampermonkey/completion-resolver.js
  var CompletionResolver = class {
    constructor(eventBus, store, metrics) {
      this.eventBus = eventBus;
      this.store = store;
      this.metrics = metrics;
    }
    onNetworkStarted(session) {
      if (session && !session.startedEmitted) {
        session.startedEmitted = true;
        this.eventBus.publish(EVENTS.STARTED, session, ["network"], CONFIDENCE.CONFIRMED, "primary_stream_active");
      }
    }
    onNetworkDone(session) {
      if (!session || session.terminalEmitted) return;
      session.networkDone = true;
      this.evaluateCompletion(session, "network_done");
    }
    onDomUiCompleted(session) {
      if (!session) return;
      if (session.terminalEmitted) {
        const upgraded = session.upgradeEvidenceToConfirmed();
        if (upgraded) {
          this.metrics.recordTimingDiff(session);
          console.debug("[Resolver] \u665A\u5230 DOM \u5230\u8FBE\uFF1A\u8BC1\u636E\u9759\u9ED8\u5347\u7EA7\u4E3A confirmed\uFF0C\u4E0D\u91CD\u53D1\u516C\u5F00\u4E8B\u4EF6");
        }
        return;
      }
      this.evaluateCompletion(session, "dom_ui_completed");
    }
    evaluateCompletion(session, trigger) {
      if (!session || session.terminalEmitted) return;
      if (session.networkDone && session.domUiCompleted) {
        if (session.graceTimer) {
          clearTimeout(session.graceTimer);
          session.graceTimer = null;
        }
        session.markTerminalEmitted(EVENTS.COMPLETED, CONFIDENCE.CONFIRMED);
        this.metrics.recordTimingDiff(session);
        this.eventBus.publish(EVENTS.COMPLETED, session, ["network", "dom"], CONFIDENCE.CONFIRMED, "dual_signals_aligned");
        this.store.clearActiveSession(session);
        return;
      }
      if (session.networkDone && !session.domUiCompleted) {
        if (!session.graceTimer) {
          session.graceTimer = setTimeout(() => {
            if (!session.terminalEmitted) {
              session.markTerminalEmitted(EVENTS.COMPLETED, CONFIDENCE.NETWORK_ONLY);
              this.eventBus.publish(EVENTS.COMPLETED, session, ["network"], CONFIDENCE.NETWORK_ONLY, "grace_window_timeout_fallback", {
                dom_confirmation_missing: true
              });
            }
          }, CONFIG.GRACE_WINDOW_MS);
        }
        return;
      }
      if (session.domUiCompleted && !session.networkDone) {
        if (!session.graceTimer) {
          session.graceTimer = setTimeout(() => {
            if (!session.terminalEmitted) {
              session.markTerminalEmitted(EVENTS.COMPLETED, CONFIDENCE.DOM_ONLY);
              this.eventBus.publish(EVENTS.COMPLETED, session, ["dom"], CONFIDENCE.DOM_ONLY, "network_done_timeout_fallback", {
                network_hook_missing: true
              });
              this.store.clearActiveSession(session);
            }
          }, CONFIG.GRACE_WINDOW_MS);
        }
        return;
      }
    }
    onStreamClosedWithoutDone(session, error = null) {
      if (!session || session.terminalEmitted) return;
      if (session.userStopActionSeen) {
        session.markTerminalEmitted(EVENTS.STOPPED_BY_USER, CONFIDENCE.CONFIRMED);
        this.eventBus.publish(EVENTS.STOPPED_BY_USER, session, ["dom", "network"], CONFIDENCE.CONFIRMED, "user_clicked_stop_and_stream_aborted");
        this.store.clearActiveSession(session);
        return;
      }
      const reason = error ? `stream_error: ${error.message || error}` : "primary_stream_closed_without_done";
      session.markTerminalEmitted(EVENTS.INTERRUPTED, CONFIDENCE.CONFIRMED);
      this.eventBus.publish(EVENTS.INTERRUPTED, session, ["network"], CONFIDENCE.CONFIRMED, reason);
      this.store.clearActiveSession(session);
    }
  };

  // src/tampermonkey/dom-detector.js
  var DomDetector = class {
    constructor(store, resolver) {
      this.store = store;
      this.resolver = resolver;
      this.lastStopPresent = false;
      this.observer = null;
      this.init();
    }
    init() {
      this.bindUserInteraction();
      this.safeAttachObserver();
    }
    findStopControl() {
      return document.querySelector(
        'button[aria-label*="Stop"], button[data-testid*="stop-button"], button[data-testid*="stop"], button[aria-label*="\u505C\u6B62"]'
      );
    }
    bindUserInteraction() {
      if (typeof window === "undefined") return;
      window.addEventListener("click", (e) => {
        const btn = e.target.closest && e.target.closest(
          'button[aria-label*="Stop"], button[data-testid*="stop-button"], button[data-testid*="stop"], button[aria-label*="\u505C\u6B62"]'
        );
        if (btn) {
          const session = this.store.getActiveSession();
          if (session && !session.terminalEmitted) {
            session.userStopActionSeen = true;
            console.debug("[DomDetector] \u6355\u83B7\u5230\u7528\u6237\u7269\u7406\u70B9\u51FB Stop \u6309\u94AE");
          }
        }
      }, true);
    }
    safeAttachObserver() {
      if (typeof document === "undefined") return;
      const startObserving = () => {
        const target = document.documentElement || document.body;
        if (!target) {
          setTimeout(startObserving, 50);
          return;
        }
        this.observer = new MutationObserver(() => this.handleMutations());
        this.observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-label", "disabled", "data-testid"]
        });
        this.handleMutations();
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startObserving, { once: true });
        if (document.documentElement) startObserving();
      } else {
        startObserving();
      }
    }
    handleMutations() {
      const session = this.store.getActiveSession();
      const hasStop = Boolean(this.findStopControl());
      if (session && !session.terminalEmitted) {
        if (hasStop) {
          session.stopSeenForGeneration = true;
        } else if (!hasStop && session.stopSeenForGeneration && !session.domUiCompleted) {
          session.domUiCompleted = true;
          session.domStopTimeMs = typeof performance !== "undefined" ? performance.now() : Date.now();
          this.resolver.onDomUiCompleted(session);
        }
      }
      this.lastStopPresent = hasStop;
    }
    destroy() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
    }
  };

  // src/tampermonkey/primary-classifier.js
  var PrimaryClassifier = class {
    /**
     * 从 chunk 结构中精准提取 Assistant message_id
     * 严格要求 role === 'assistant'，坚决拒绝 user、system、tool 消息
     */
    static extractAssistantMessageId(chunk) {
      if (!chunk || typeof chunk !== "object") return null;
      if (chunk.message && typeof chunk.message.id === "string") {
        const author = chunk.message.author;
        if (author && author.role === "assistant") {
          return chunk.message.id;
        }
        if (author && author.role && author.role !== "assistant") {
          return null;
        }
      }
      if (typeof chunk.message_id === "string" && chunk.message_id.length > 20) {
        if (chunk.role === "assistant" || chunk.message_role === "assistant") {
          return chunk.message_id;
        }
        if (chunk.role && chunk.role !== "assistant") return null;
      }
      if (typeof chunk.p === "string" && chunk.p.endsWith("/id") && typeof chunk.v === "string" && chunk.v.length > 20) {
        if (chunk.p.includes("assistant") || !chunk.p.includes("user")) {
          return chunk.v;
        }
      }
      for (const key of Object.keys(chunk)) {
        if (key === "input_message" || key === "user") continue;
        if (typeof chunk[key] === "object" && chunk[key] !== null) {
          const found = this.extractAssistantMessageId(chunk[key]);
          if (found) return found;
        }
      }
      return null;
    }
    /**
     * 检查是否包含有意义的生成文本/分词增量
     */
    static hasMeaningfulContentDelta(chunk) {
      if (!chunk || typeof chunk !== "object") return false;
      if ("v" in chunk) {
        const v = chunk.v;
        if (typeof v === "string" && v.length > 0) return true;
        if (Array.isArray(v) && v.length > 0) return true;
        if (typeof v === "object" && v !== null && (v.message || v.parts)) return true;
      }
      return false;
    }
    /**
     * 基于累积状态评估当前流类别
     */
    static evaluateStreamClass(streamState) {
      const {
        hasConversationId,
        assistantMessageId,
        meaningfulDeltaCount,
        totalChunksCount,
        hasDoneMarker
      } = streamState;
      if (hasConversationId && (assistantMessageId || meaningfulDeltaCount >= 2)) {
        return STREAM_CLASS.PRIMARY_GENERATION;
      }
      if (totalChunksCount > 0 && !assistantMessageId && meaningfulDeltaCount === 0) {
        return STREAM_CLASS.AUXILIARY_STREAM;
      }
      return STREAM_CLASS.UNKNOWN;
    }
  };

  // src/tampermonkey/network-detector.js
  var NetworkDetector = class {
    constructor(store, resolver, metrics) {
      this.store = store;
      this.resolver = resolver;
      this.metrics = metrics;
      this.patched = false;
      this.init();
    }
    init() {
      if (typeof window === "undefined" || !window.fetch || this.patched) return;
      const originalFetch = window.fetch;
      const self = this;
      window.fetch = async function patchedFetch(...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url || "";
        const method = args[1] && args[1].method || args[0] && args[0].method || "GET";
        if (url.includes("/backend-api/f/conversation") || url.includes("/backend-api/conversation") && method === "POST") {
          const response = await originalFetch.apply(this, args);
          try {
            if (response && response.body) {
              const clone = response.clone();
              self.inspectStream(clone);
            }
          } catch (e) {
            console.debug("[NetworkDetector] stream clone failed:", e);
          }
          return response;
        }
        return originalFetch.apply(this, args);
      };
      this.patched = true;
    }
    async inspectStream(clonedResponse) {
      const reader = clonedResponse.body ? clonedResponse.body.getReader() : null;
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      let isPrimary = false;
      let localSession = null;
      let streamClass = STREAM_CLASS.UNKNOWN;
      const streamState = {
        hasConversationId: false,
        assistantMessageId: null,
        meaningfulDeltaCount: 0,
        totalChunksCount: 0,
        hasDoneMarker: false
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          const now = typeof performance !== "undefined" ? performance.now() : Date.now();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") {
                streamState.hasDoneMarker = true;
                if (isPrimary && localSession) {
                  localSession.networkDone = true;
                  localSession.networkDoneTimeMs = now;
                  this.resolver.onNetworkDone(localSession);
                }
                continue;
              }
              try {
                const chunk = JSON.parse(payload);
                streamState.totalChunksCount++;
                if (chunk.conversation_id) streamState.hasConversationId = true;
                if (PrimaryClassifier.hasMeaningfulContentDelta(chunk)) {
                  streamState.meaningfulDeltaCount++;
                }
                const extractedMid = PrimaryClassifier.extractAssistantMessageId(chunk);
                if (extractedMid) {
                  streamState.assistantMessageId = extractedMid;
                }
                if (!isPrimary) {
                  streamClass = PrimaryClassifier.evaluateStreamClass(streamState);
                  if (streamClass === STREAM_CLASS.PRIMARY_GENERATION) {
                    isPrimary = true;
                    localSession = this.store.getActiveSession() || this.store.createSession(chunk.conversation_id);
                    localSession.streamClass = STREAM_CLASS.PRIMARY_GENERATION;
                    localSession.bindConversationId(chunk.conversation_id);
                    localSession.bindAssistantMessageId(extractedMid);
                    localSession.networkStarted = true;
                    this.resolver.onNetworkStarted(localSession);
                  }
                } else if (localSession) {
                  localSession.bindConversationId(chunk.conversation_id);
                  localSession.bindAssistantMessageId(extractedMid);
                }
              } catch (e) {
              }
            }
          }
          if (done) {
            if (!isPrimary) {
              this.metrics.recordAuxiliaryIgnored();
              return;
            }
            if (localSession && !localSession.networkDone && !localSession.terminalEmitted) {
              this.resolver.onStreamClosedWithoutDone(localSession);
            }
            break;
          }
        }
      } catch (err) {
        if (isPrimary && localSession && !localSession.terminalEmitted) {
          this.resolver.onStreamClosedWithoutDone(localSession, err);
        }
      } finally {
        try {
          reader.cancel();
        } catch (e) {
        }
      }
    }
  };

  // src/tampermonkey/main.js
  function initializeRallyRuntime(customVersion = "__RALLY_VERSION__") {
    if (typeof window === "undefined") return null;
    if (window.__RALLY_RUNTIME__) return window.__RALLY_RUNTIME__;
    const eventBus = new EventBus();
    const store = new GenerationStore();
    const metrics = new MetricsCollector();
    const resolver = new CompletionResolver(eventBus, store, metrics);
    eventBus.on("any_event", (payload) => {
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
          sessions: store.getAllSessions().map((s) => ({
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
        console.log("[Rally] \u6D4B\u8BD5\u8FD0\u884C\u6570\u636E\u5DF2\u91CD\u7F6E");
        return true;
      }
    });
    window.__RALLY_RUNTIME__ = runtimeApi;
    console.log(`%c[Rally Runtime Event Detector v${customVersion} \u521D\u59CB\u5316\u6210\u529F]`, "color: #10b981; font-weight: bold;");
    return runtimeApi;
  }
  initializeRallyRuntime();
})();
