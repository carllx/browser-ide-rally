/**
 * 事件总线与跨 Tab 通信
 */
import { CONFIG } from './constants.js';

export class EventBus {
  constructor(tabInstanceId = null) {
    this.tabInstanceId = tabInstanceId || 'tab_' + Math.random().toString(36).substring(2, 9);
    this.publicEvents = [];
    this.receivedEvents = [];
    this.listeners = new Map();

    if (typeof BroadcastChannel !== 'undefined') {
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
      received_at: new Date().toISOString(),
      ...data
    });
    this.emitLocal('broadcast_received', data);
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
      try { fn(payload); } catch (e) {}
    }
  }

  publish(eventType, session, sources, confidence, reason, extra = {}) {
    const payload = {
      tab_instance_id: this.tabInstanceId,
      local_generation_id: session?.localGenId || null,
      conversation_id: session?.conversationId || null,
      message_id: session?.messageId || null,
      event: eventType,
      timestamp: new Date().toISOString(),
      confidence,
      sources,
      reason,
      ...extra
    };

    this.publicEvents.push(payload);
    this.emitLocal(eventType, payload);
    this.emitLocal('any_event', payload);

    if (this.bc) {
      try {
        this.bc.postMessage(payload);
      } catch (e) {}
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

  destroy() {
    if (this.bc) {
      try {
        this.bc.close();
      } catch (e) {}
      this.bc = null;
    }
    this.listeners.clear();
  }
}
