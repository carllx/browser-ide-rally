// ==UserScript==
// @name         Rally Issue #1 — ChatGPT Network Passive Probe
// @namespace    https://github.com/carllx/browser-ide-rally
// @version      0.1.0
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
      path: location.pathname,
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

  async function inspectStream(clonedResp, urlPath) {
    const reader = clonedResp.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = '', hadHandoff = false, terminal = null;

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
            terminal = '[DONE]';
            record('stream', 'terminal_done', { urlPath });
            continue;
          }
          const d = parseJson(payload);
          if (!d || typeof d !== 'object') continue;

          if ((d.stream_handoff || d.v?.stream_handoff) && !hadHandoff) {
            hadHandoff = true;
            const h = d.stream_handoff || d.v?.stream_handoff;
            record('stream', 'stream_handoff', { urlPath, turnExchangeId: h?.turn_exchange_id || null });
          }

          const convId = d.conversation_id || d.v?.conversation_id;
          const msg = d.message || d.v?.message;
          const st = msg?.status;
          const endTurn = msg?.end_turn || d.v?.end_turn;

          if (convId && !terminal) {
            record('stream', 'identity', { urlPath, streamConvId: convId, msgId: msg?.id || null });
          }
          if (st === 'finished_successfully' || endTurn === true) {
            terminal = st || 'end_turn';
            record('stream', 'terminal_signal', { urlPath, signal: terminal, msgId: msg?.id || null });
          }
        }
      }
    } catch (err) {
      record('stream', 'error', { urlPath, err: err?.name });
    } finally {
      record('stream', 'closed', { urlPath, hadHandoff, terminal });
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
        record('ws', 'connect', { host: u.hostname, path: u.pathname });
        ws.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          const j = parseJson(ev.data);
          if (!j) return;
          const items = Array.isArray(j) ? j : [j];
          for (const it of items) {
            const topic = it?.topic_id || it?.topic || null;
            const pType = it?.payload?.type || it?.type || null;
            const inner = it?.payload?.payload || it?.payload;
            const innerType = inner?.type || null;
            const isTerm = innerType === 'done' || pType === 'conversation-turn-complete' || inner?.status === 'finished_successfully';
            if (topic || pType || inner?.turn_id || isTerm) {
              record('ws', isTerm ? 'terminal' : 'frame', {
                topic,
                pType,
                innerType,
                turnId: inner?.turn_id || null,
                convId: inner?.conversation_id || null,
                isTerm,
              });
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

  // --- Evidence Buffer API ---
  window.__RALLY_NETWORK_PROBE__ = Object.freeze({
    version: '0.1.0',
    count: () => events.length,
    dump: () => JSON.parse(JSON.stringify(events)),
    clear: () => { events.length = 0; },
  });

  record('probe', 'init', { version: '0.1.0', routeConvId: getPathConvId() });
})();
