// A room connection with one interface and two engines:
//  - SocketRoom: the real thing, over WebSocket to the Comet server.
//  - LocalRoom:  BroadcastChannel + localStorage, so the app still works
//                (across tabs) when it's deployed as plain static files.

import { wsUrl, local } from './api.js';
import { store } from './util.js';
import { uid } from './identity.js';

export function connectRoom({ mode, ...options }) {
  return mode === 'server' ? new SocketRoom(options) : new LocalRoom(options);
}

class Emitter {
  constructor(handlers = {}) {
    this.handlers = handlers;
  }
  emit(type, payload) {
    this.handlers[type]?.(payload);
  }
}

// ------------------------------------------------------------------ socket

class SocketRoom extends Emitter {
  constructor({ roomId, me, on }) {
    super(on);
    this.roomId = roomId;
    this.me = { ...me };
    this.draft = { text: '', caret: 0 };
    this.outbox = [];
    this.attempt = 0;
    this.closed = false;
    this.live = false;
    this.onOnline = () => this.ws?.readyState !== 1 && this.reconnectNow();
    window.addEventListener('online', this.onOnline);
    this.open();
  }

  open() {
    this.emit('status', this.attempt ? 'reconnecting' : 'connecting');
    const ws = (this.ws = new WebSocket(wsUrl()));
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: this.roomId, me: this.me }));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = (event) => {
      this.live = false;
      if (this.closed) return;
      if (event.code === 4000) return this.emit('replaced');
      this.scheduleReconnect();
    };
  }

  receive(msg) {
    if (msg.t === 'welcome') {
      this.live = true;
      this.attempt = 0;
      this.emit('status', 'live');
      this.emit('welcome', msg);
      if (this.draft.text) this.send({ t: 'type', ...this.draft });
      for (const queued of this.outbox.splice(0)) this.send(queued);
      return;
    }
    if (msg.t === 'error') {
      if (msg.code === 'not_found' || msg.code === 'full') this.closed = true;
      return this.emit('error', msg);
    }
    this.emit(msg.t, msg);
  }

  scheduleReconnect() {
    this.emit('status', 'reconnecting');
    const delay = Math.min(8000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delay);
  }

  reconnectNow() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.ws?.close();
    this.open();
  }

  send(msg) {
    if (this.ws?.readyState === 1 && this.live) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  type(text, caret) {
    this.draft = { text, caret };
    this.send({ t: 'type', text, caret });
  }

  commit(text, nonce) {
    this.draft = { text: '', caret: 0 };
    const msg = { t: 'commit', text, nonce };
    if (!this.send(msg)) this.outbox.push(msg);
  }

  react(line, emoji) {
    this.send({ t: 'react', line, emoji });
  }

  profile(patch) {
    Object.assign(this.me, patch);
    this.send({ t: 'profile', ...patch });
  }

  away(away) {
    this.send({ t: 'away', away });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.onOnline);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'leave' }));
    this.ws?.close();
  }
}

// ------------------------------------------------------------------- local

const HEARTBEAT = 2500;
const TTL = 9000;

class LocalRoom extends Emitter {
  constructor({ roomId, me, on }) {
    super(on);
    this.roomId = roomId;
    this.me = { ...me, text: '', caret: 0, away: false, joinedAt: Date.now(), typedAt: 0 };
    this.members = new Map();
    this.seen = new Map();
    this.closed = false;
    this.linesKey = `comet:local:lines:${roomId}`;
    this.presenceKey = `comet:local:presence:${roomId}`;
    queueMicrotask(() => this.start());
  }

  start() {
    if (!local.get(this.roomId)) {
      this.closed = true;
      return this.emit('error', { code: 'not_found', message: 'This room has ended or never existed.' });
    }
    this.emit('status', 'local');
    this.channel = 'BroadcastChannel' in window ? new BroadcastChannel(`comet:${this.roomId}`) : null;
    if (this.channel) this.channel.onmessage = (e) => this.receive(e.data);

    this.writePresence();
    for (const m of local.presence(this.roomId)) {
      if (m.id !== this.me.id) this.track(m);
    }
    this.members.set(this.me.id, this.me);
    this.emit('welcome', {
      you: this.me.id,
      room: local.get(this.roomId),
      members: [...this.members.values()],
      lines: store.get(this.linesKey, []),
    });
    this.post({ t: 'join', member: this.me });

    this.beat = setInterval(() => this.tick(), HEARTBEAT);
    this.onStorage = (e) => {
      // Another tab may have pruned the presence map — make sure we're still in it.
      if (e.key === this.presenceKey && !(this.me.id in store.get(this.presenceKey, {}))) this.writePresence();
    };
    window.addEventListener('storage', this.onStorage);
  }

  track(member) {
    this.members.set(member.id, { ...this.members.get(member.id), ...member });
    this.seen.set(member.id, Date.now());
  }

  receive(msg) {
    if (this.closed || !msg || msg.from === this.me.id) return;
    if (msg.from) this.seen.set(msg.from, Date.now());
    switch (msg.t) {
      case 'join':
      case 'here': {
        const known = this.members.has(msg.member.id);
        this.track(msg.member);
        if (!known) this.emit('join', { member: msg.member });
        if (msg.t === 'join') this.post({ t: 'here', member: this.me });
        break;
      }
      case 'type': {
        const m = this.members.get(msg.id);
        if (m) Object.assign(m, { text: msg.text, caret: msg.caret, typedAt: Date.now() });
        this.emit('type', msg);
        break;
      }
      case 'line':
        this.emit('line', { line: msg.line });
        break;
      case 'react':
        this.emit('react', msg);
        break;
      case 'profile':
        if (this.members.has(msg.member.id)) {
          this.track(msg.member);
          this.emit('profile', msg);
        }
        break;
      case 'leave':
        if (this.members.delete(msg.id)) this.emit('leave', { id: msg.id });
        break;
    }
  }

  post(msg) {
    this.channel?.postMessage({ ...msg, from: this.me.id });
  }

  writePresence() {
    const all = store.get(this.presenceKey, {});
    const now = Date.now();
    for (const [id, m] of Object.entries(all)) if (now - m.ts > TTL) delete all[id];
    const { name, color, text, caret, away, joinedAt } = this.me;
    all[this.me.id] = { name, color, text, caret, away, joinedAt, ts: now };
    store.set(this.presenceKey, all);
  }

  tick() {
    this.writePresence();
    const fresh = new Map(local.presence(this.roomId).map((m) => [m.id, m]));
    const now = Date.now();
    for (const id of [...this.members.keys()]) {
      if (id === this.me.id) continue;
      if (!fresh.has(id) && now - (this.seen.get(id) || 0) > TTL) {
        this.members.delete(id);
        this.emit('leave', { id });
      }
    }
    for (const [id, m] of fresh) {
      if (id !== this.me.id && !this.members.has(id)) {
        this.track(m);
        this.emit('join', { member: { id, ...m } });
      }
    }
  }

  type(text, caret) {
    Object.assign(this.me, { text, caret, typedAt: Date.now() });
    this.post({ t: 'type', id: this.me.id, text, caret });
  }

  commit(text, nonce) {
    const body = text.trim();
    this.type('', 0);
    if (!body) return;
    const line = {
      id: uid(10),
      author: { id: this.me.id, name: this.me.name, color: this.me.color },
      text: body.slice(0, 500),
      ts: Date.now(),
      reactions: {},
    };
    const lines = store.get(this.linesKey, []);
    lines.push(line);
    store.set(this.linesKey, lines.slice(-300));
    local.touch(this.roomId);
    this.post({ t: 'line', line });
    this.emit('line', { line, nonce });
  }

  react(lineId, emoji) {
    const lines = store.get(this.linesKey, []);
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const who = new Set(line.reactions[emoji] || []);
    who.has(this.me.id) ? who.delete(this.me.id) : who.add(this.me.id);
    if (who.size) line.reactions[emoji] = [...who];
    else delete line.reactions[emoji];
    store.set(this.linesKey, lines);
    const msg = { t: 'react', line: lineId, reactions: line.reactions };
    this.post(msg);
    this.emit('react', msg);
  }

  profile(patch) {
    Object.assign(this.me, patch);
    this.writePresence();
    this.post({ t: 'profile', member: this.me });
    this.emit('profile', { member: this.me });
  }

  away(away) {
    this.me.away = away;
    this.post({ t: 'profile', member: this.me });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beat);
    window.removeEventListener('storage', this.onStorage);
    this.post({ t: 'leave', id: this.me.id });
    const all = store.get(this.presenceKey, {});
    delete all[this.me.id];
    store.set(this.presenceKey, all);
    this.channel?.close();
  }
}
