/**
 * Realtime client: WebSocket first, HTTP long-polling as a fallback.
 * UI modules subscribe to event kinds; nothing else touches the socket.
 */

import { api, wsUrl } from './api.js';

const RECONNECT_DELAYS = [400, 900, 1800, 3200, 5000, 8000];

export class StreamClient {
  constructor() {
    this.handlers = new Map();      // kind -> Set<fn>
    this.anyHandlers = new Set();
    this.statusHandlers = new Set();
    this.ws = null;
    this.connected = false;
    this.mode = 'ws';               // ws | poll
    this.retry = 0;
    this.closedByUser = false;
    this.pollRunId = null;
    this.pollSince = 0;
    this.pollTimer = null;
    this.lastEventId = 0;
  }

  on(kind, fn) {
    if (!this.handlers.has(kind)) this.handlers.set(kind, new Set());
    this.handlers.get(kind).add(fn);
    return () => this.handlers.get(kind)?.delete(fn);
  }

  onAny(fn) {
    this.anyHandlers.add(fn);
    return () => this.anyHandlers.delete(fn);
  }

  onStatus(fn) {
    this.statusHandlers.add(fn);
    fn(this.connected ? 'online' : 'connecting');
    return () => this.statusHandlers.delete(fn);
  }

  _status(value) {
    this.statusHandlers.forEach((fn) => {
      try { fn(value); } catch (error) { console.error(error); }
    });
  }

  dispatch(event) {
    if (!event || !event.kind) return;
    if (event.id) this.lastEventId = Math.max(this.lastEventId, event.id);
    const set = this.handlers.get(event.kind);
    if (set) {
      set.forEach((fn) => {
        try { fn(event.data || {}, event); } catch (error) { console.error('[DAGENT] handler error', event.kind, error); }
      });
    }
    this.anyHandlers.forEach((fn) => {
      try { fn(event); } catch (error) { console.error(error); }
    });
  }

  connect() {
    this.closedByUser = false;
    this._openSocket();
  }

  _openSocket() {
    try {
      this.ws = new WebSocket(wsUrl());
    } catch (error) {
      console.warn('[DAGENT] WebSocket unavailable, falling back to polling', error);
      this._startPolling();
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.mode = 'ws';
      this._status('online');
    };
    this.ws.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch (error) {
        return;
      }
      if (event.kind === 'ping') return;
      if (event.kind === 'hello') {
        this.dispatch({ kind: 'hello', data: event.data || {} });
        return;
      }
      this.dispatch(event);
    };
    this.ws.onerror = () => {
      // onclose follows and handles the retry
    };
    this.ws.onclose = () => {
      this.connected = false;
      this._status('offline');
      if (this.closedByUser) return;
      const delay = RECONNECT_DELAYS[Math.min(this.retry, RECONNECT_DELAYS.length - 1)];
      this.retry += 1;
      this._status('reconnecting');
      setTimeout(() => {
        if (this.retry >= 3 && !this.connected) this._startPolling();
        this._openSocket();
      }, delay);
    };
  }

  send(payload) {
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify(payload));
        return true;
      } catch (error) {
        console.warn(error);
      }
    }
    return false;
  }

  /** Fallback: poll run events over HTTP while a run is active. */
  _startPolling() {
    if (this.pollTimer) return;
    this.mode = 'poll';
    const tick = async () => {
      this.pollTimer = setTimeout(tick, 1200);
      try {
        const runs = await api.runs();
        const active = (runs.active || [])[0];
        if (!active) return;
        const data = await api.runEvents(active.run_id, this.pollSince, 12);
        (data.events || []).forEach((event) => this.dispatch(event));
        if (data.last_id) this.pollSince = data.last_id;
      } catch (error) {
        /* server busy - keep trying */
      }
    };
    tick();
  }

  close() {
    this.closedByUser = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (error) { /* ignore */ }
    }
  }
}

export const stream = new StreamClient();
