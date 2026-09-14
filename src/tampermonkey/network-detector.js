/**
 * 被动 Fetch 网络拦截器：基于 response.clone()，不干扰主页面通信
 */
import { PrimaryClassifier } from './primary-classifier.js';
import { STREAM_CLASS } from './constants.js';

export class NetworkDetector {
  constructor(store, resolver, metrics) {
    this.store = store;
    this.resolver = resolver;
    this.metrics = metrics;
    this.patched = false;
    this.init();
  }

  init() {
    if (typeof window === 'undefined' || !window.fetch || this.patched) return;
    const originalFetch = window.fetch;
    const self = this;

    window.fetch = async function patchedFetch(...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';

      // 仅观察 ChatGPT conversation 生成与相关长连接
      if (url.includes('/backend-api/f/conversation') || (url.includes('/backend-api/conversation') && method === 'POST')) {
        const response = await originalFetch.apply(this, args);

        // 关键修复 D：真正被动观察，使用 response.clone()，返回原始未经篡改的 response
        try {
          if (response && response.body) {
            const clone = response.clone();
            self.inspectStream(clone);
          }
        } catch (e) {
          console.debug('[NetworkDetector] stream clone failed:', e);
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
    let buffer = '';
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
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();

        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();

            if (payload === '[DONE]') {
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

              // 评估流类型
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
            } catch (e) {}
          }
        }

        if (done) {
          if (!isPrimary) {
            // 关键修复：辅流缺少 [DONE] 属于正常预检，安全忽略，绝不发射中断事件！
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
      try { reader.cancel(); } catch (e) {}
    }
  }
}
