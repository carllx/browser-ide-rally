// ==UserScript==
// @name         Rally Issue #1 — ChatGPT Network Passive Probe
// @namespace    https://github.com/carllx/browser-ide-rally
// @version      0.1.1
// @description  Minimal passive observer for ChatGPT conversation identity, transport, and turn completion signals.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/**
 * Rally Issue #1 Phase 0 — Minimal Passive Network Probe
 *
 * Rules:
 * 1. Passive only: no mutation, no blocking, clone stream before reading.
 * 2. Privacy-first: no prompts, no assistant bodies, no auth/bearer tokens.
 * 3. In-memory buffer: window.__RALLY_NETWORK_PROBE__.dump().
 */
(function rallyNetworkProbe() {
  'use strict';
  if (window.__RALLY_NETWORK_PROBE__) return;

  const startTime = Date.now();
  const events = [];

  function record(cat, type, detail = {}) {
    const entry = {
      seq: events.length + 1,
      relMs: Date.now() - startTime,
      cat,
      type,
      pagePath: location.pathname,
      ...detail,
    };
    events.push(entry);
    console.debug(`[RallyProbe][${entry.relMs}ms][${cat}:${type}]`, detail);
  }

  function getPathConvId(p = location.pathname) {
    const m = /^\/(?:c|g\/[^/]+\/c)\/([0-9a-fA-F-]{36})/i.exec(p);
    return m ? m[1] : null;
  }

  function parseJson(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  // --- Fetch Interception ---
  const nativeFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    const respPromise = nativeFetch.apply(this, arguments);
    try {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url || '');
      const path = new URL(urlStr, location.origin).pathname;
      const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();

      if (path.includes('/backend-api/') || path.includes('/backend-anon/')) {
        let reqMeta = {};
        if (method === 'POST' && typeof init?.body === 'string') {
          const b = parseJson(init.body);
          if (b && typeof b === 'object') {
            reqMeta = {
              reqConvId: typeof b.conversation_id === 'string' ? b.conversation_id : null,
              parentMsgId: typeof b.parent_message_id === 'string' ? b.parent_message_id : null,
              model: typeof b.model === 'string' ? b.model : null,
            };
          }
        }

        record('fetch', 'request', { urlPath: path, method, routeConvId: getPathConvId(), ...reqMeta });

        respPromise.then((resp) => {
          if (!resp) return;
          const status = resp.status;
          const ct = resp.headers.get('content-type') || '';
          record('fetch', 'response', { urlPath: path, status, ct });

          if (resp.ok && resp.body && (ct.includes('text/event-stream') || ct.includes('application/json'))) {
            inspectStream(resp.clone(), path);
          }
        }).catch((err) => record('fetch', 'error', { urlPath: path, err: err?.name }));
      }
    } catch (e) {
      console.warn('[RallyProbe] fetch err:', e);
    }
    return respPromise;
  };

  function isAnswerContainer(m) {
    if (!m || !m.author || m.author.role !== 'assistant') return false;
    if (m.weight === 0) return false;
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation === true) return false;
    if (m.channel != null && m.channel !== 'final') return false;
    const ct = m.content && m.content.content_type;
    return !ct || ct === 'text';
  }

  async function inspectStream(clonedResp, urlPath) {
    const reader = clonedResp.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = '', hadHandoff = false, streamDone = false;
    let activeAnswerId = null, curMessageIsAnswer = false, streamConvId = null;
    let curOp = '', curPath = '';

    function noteCompletion(path, val, source) {
      if (!curMessageIsAnswer) return;
      let sig = null;
      if (typeof path === 'string') {
        if (/(^|\/)status$/.test(path) && val === 'finished_successfully') sig = 'status:finished_successfully';
        else if (/(^|\/)end_turn$/.test(path) && val === true) sig = 'end_turn:true';
      }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (val.status === 'finished_successfully') sig = 'status:finished_successfully';
        else if (val.end_turn === true) sig = 'end_turn:true';
        else if (val.is_complete === true) sig = 'is_complete:true';
      }
      if (sig) record('stream', 'semantic_terminal', { urlPath, source, signal: sig, activeAnswerId, streamConvId });
    }

    function applyOp(op, path, val) {
      if (Array.isArray(val)) {
        for (const sub of val) {
          if (sub && typeof sub === 'object') {
            applyOp('o' in sub ? sub.o : 'append', 'p' in sub ? sub.p : path, sub.v);
          }
        }
        return;
      }
      noteCompletion(path, val, 'delta_patch');
      if (val && typeof val === 'object' && val.message) {
        const m = val.message;
        if (typeof val.conversation_id === 'string') streamConvId = val.conversation_id;
        const answer = isAnswerContainer(m);
        curMessageIsAnswer = answer;
        if (answer) {
          if (m.id) activeAnswerId = m.id;
          record('stream', 'active_answer_start', { urlPath, activeAnswerId, streamConvId, model: m.metadata?.resolved_model_slug || null });
          if (m.status === 'finished_successfully' || m.end_turn === true || m.metadata?.is_complete === true) {
            record('stream', 'semantic_terminal', { urlPath, source: 'snapshot_inline', activeAnswerId, streamConvId });
          }
        }
        return;
      }
      if (val && typeof val === 'object' && typeof val.conversation_id === 'string') streamConvId = val.conversation_id;
      if (typeof val === 'string' && typeof path === 'string' && /conversation_id$/.test(path)) streamConvId = val;
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') {
            streamDone = true;
            record('stream', 'transport_done', { urlPath, activeAnswerId, streamConvId });
            continue;
          }
          const ev = parseJson(payload);
          if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
          if (typeof ev.conversation_id === 'string') streamConvId = ev.conversation_id;

          if (ev.type === 'stream_handoff' || ev.stream_handoff || ev.v?.stream_handoff) {
            hadHandoff = true;
            const h = ev.stream_handoff || ev.v?.stream_handoff || ev;
            record('stream', 'stream_handoff', {
              urlPath,
              turnExchangeId: h.turn_exchange_id || h.topic_id || null,
              streamConvId,
            });
          }

          if (ev.type === 'message_stream_complete') {
            const evMsgId = ev.message_id || ev.id || null;
            if (evMsgId ? evMsgId === activeAnswerId : curMessageIsAnswer) {
              record('stream', 'semantic_terminal', { urlPath, source: 'message_stream_complete', activeAnswerId, streamConvId });
            }
          }

          const op = 'o' in ev ? ev.o : curOp;
          const path = 'p' in ev ? ev.p : curPath;
          curOp = op;
          curPath = path;
          if ('v' in ev) applyOp(op, path, ev.v);
        }
      }
    } catch (err) {
      record('stream', 'error', { urlPath, err: err?.name });
    } finally {
      record('stream', 'closed', { urlPath, hadHandoff, streamDone, activeAnswerId, streamConvId });
      reader.cancel().catch(() => {});
    }
  }

  // --- WebSocket Interception ---
  const NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    const ws = arguments.length > 1 ? new NativeWS(url, protocols) : new NativeWS(url);
    try {
      const u = new URL(String(url || ''), location.href);
      if (u.hostname === 'ws.chatgpt.com' || u.hostname.endsWith('.chatgpt.com')) {
        record('ws', 'connect', { wsHost: u.hostname, wsPath: u.pathname });
        ws.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') {
            record('ws', 'unparsed_frame_shape', { reason: 'non_string_data', dataType: Object.prototype.toString.call(ev.data) });
            return;
          }
          const j = parseJson(ev.data);
          if (!j) {
            record('ws', 'unparsed_frame_shape', { reason: 'invalid_json', rawPreview: ev.data.slice(0, 80) });
            return;
          }
          const items = Array.isArray(j) ? j : [j];
          for (const it of items) {
            const topic = it?.topic_id || it?.topic || null;
            const pType = it?.payload?.type || it?.type || null;
            const inner = it?.payload?.payload || it?.payload;
            const innerType = inner?.type || null;
            const isTerm = innerType === 'done' || pType === 'conversation-turn-complete' || inner?.status === 'finished_successfully';
            const turnId = inner?.turn_id || null;
            const convId = inner?.conversation_id || null;

            if (inner?.encoded_item) {
              record('ws', 'encoded_item_frame', { topic, pType, innerType, turnId, convId, isTerm });
            } else if (topic || pType || turnId || isTerm) {
              record('ws', isTerm ? 'terminal' : 'frame', { topic, pType, innerType, turnId, convId, isTerm });
            } else {
              record('ws', 'unparsed_frame_shape', { reason: 'unknown_envelope', keys: Object.keys(it || {}) });
            }
          }
        });
        ws.addEventListener('close', (ev) => record('ws', 'close', { code: ev.code }));
      }
    } catch (e) {
      console.warn('[RallyProbe] ws err:', e);
    }
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  Object.setPrototypeOf(PatchedWS, NativeWS);
  window.WebSocket = PatchedWS;

  // --- Measurement-Only UI Completion Marker ---
  function observeUiCompletion() {
    if (!document.documentElement) return;
    let lastStop = false;
    const mo = new MutationObserver(() => {
      try {
        const hasStop = Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]'));
        if (lastStop && !hasStop) record('ui', 'stop_disappeared', { routeConvId: getPathConvId() });
        else if (!lastStop && hasStop) record('ui', 'stop_appeared', { routeConvId: getPathConvId() });
        lastStop = hasStop;
      } catch {}
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.documentElement) observeUiCompletion();
  else document.addEventListener('DOMContentLoaded', observeUiCompletion, { once: true });

  // --- Evidence Buffer API ---
  window.__RALLY_NETWORK_PROBE__ = Object.freeze({
    version: '0.1.1',
    count: () => events.length,
    dump: () => JSON.parse(JSON.stringify(events)),
  });

  record('probe', 'init', { version: '0.1.1', routeConvId: getPathConvId() });
})();
