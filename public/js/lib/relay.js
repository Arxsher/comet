// Relay mode: Midsentence on any static host, with no server, accounts or API keys.
//
// Free public MQTT brokers act as a dumb pub/sub relay. Everything said in a
// room is end-to-end encrypted in the browser with a key derived from the room
// id, so brokers only ever see opaque bytes on hashed topics. The room id is
// the secret: link-only rooms get long random ids; public rooms are public anyway.
//
// Topics, all under RELAY_PREFIX:
//   r/<topicKey>  the room channel: encrypted envelopes { k, from, sid, seq, ...data }
//   m/<topicKey>  retained, encrypted room meta { id, name, topic, isPublic, createdAt }
//   h/<topicKey>  retained, encrypted history { lines, updatedAt }
//   d/<roomId>    retained, plain JSON directory entry (public rooms only)
//
// Nobody owns a room, so the present member who joined first acts as its
// "host": it keeps the retained history and directory entry fresh, and sends
// recent lines to newcomers. Everyone else is an equal peer.
//
// Importable in Node (no DOM needed): the tests drive it against a local broker.

import { MqttClient } from './mqtt.js';

export const RELAY_PREFIX = 'midsentence-app/v1/';
export const DEFAULT_RELAYS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];

const LIMITS = { text: 500, name: 32, roomName: 48, topic: 90, members: 50, lines: 300, history: 150, sync: 60 };

const TIMING = {
  join: 900, // a joiner listens this long for history and replies before `welcome`
  ping: 10_000, // presence heartbeat (also carries the current draft)
  ttl: 25_000, // members not heard from for this long have left
  sweep: 5000,
  typeGap: 50, // at most one outgoing keystroke message per 50ms
  debounce: 1000, // host: history and directory writes
  directory: 30_000, // host: refresh the public directory entry
  historyRefresh: 4 * 60_000, // host: re-stamp history so `updatedAt` tracks "last seen occupied"
  dissolve: 10 * 60_000, // an empty room with history older than this starts over
  lookup: 2500, // getRoom: longest wait for retained meta
  peek: 700, // getRoom: how long to collect "here" replies
  grace: 400, // after a SUBACK: time for retained messages to land
};

const DIRECTORY = { fresh: 75_000, maxAge: 7 * 24 * 3600_000, listed: 60, entries: 500 };
const HISTORY_BYTES = 64 * 1024; // stay well under public brokers' message size limits
const SYNC_BYTES = 32 * 1024;
const MAX_PAYLOAD = 256 * 1024;
const DEDUPE_WINDOW = 1024; // how far a copy via a lagging broker may trail and still be recognised
const BOOT = Date.now();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ------------------------------------------------------------- validation

const ROOM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
const MEMBER_ID_RE = /^[a-z0-9]{6,32}$/i;
const LINE_ID_RE = /^[a-z0-9]{6,32}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
// C0/C1 controls, DEL, line separators and bidi overrides (which can spoof text direction).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

export const isValidRoomId = (id) => typeof id === 'string' && ROOM_ID_RE.test(id);

const cleanText = (value) => (typeof value === 'string' ? value.replace(CONTROL_ALL, ' ').slice(0, LIMITS.text) : '');
const cleanLabel = (value, max) => (typeof value === 'string' ? value.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const cleanColor = (value) => (typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : '#ff7a59');
const clampCaret = (caret, text) => (Number.isInteger(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** A timestamp from someone else's clock: positive, and never ahead of ours. */
const time = (value) => (Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : 0);
/** Stricter, for directory freshness: a far-future `seenAt` would keep a fake entry "live" forever. */
const recent = (value) => (Number.isFinite(value) && value > 0 && value < Date.now() + 5 * 60_000 ? value : 0);
// Emoji are never plain ASCII words, which also keeps keys like "__proto__" out of reaction maps.
const isEmoji = (value) =>
  typeof value === 'string' && value.length <= 16 && /[^\x00-\x7f]/.test(value) && !/[\sA-Za-z_<>&"'\\]/.test(value) && !CONTROL.test(value);

function readMember(raw, id) {
  if (!isObject(raw) || raw.id !== id) return null;
  const text = cleanText(raw.text);
  return {
    id,
    name: cleanLabel(raw.name, LIMITS.name) || 'Anonymous',
    color: cleanColor(raw.color),
    joinedAt: time(raw.joinedAt) || Date.now(),
    text,
    caret: clampCaret(raw.caret, text),
    away: raw.away === true,
  };
}

function readReactions(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const [emoji, who] of Object.entries(raw).slice(0, 12)) {
    if (!isEmoji(emoji) || !Array.isArray(who)) continue;
    const ids = [...new Set(who.filter((id) => typeof id === 'string' && MEMBER_ID_RE.test(id)))].slice(0, 100);
    if (ids.length) out[emoji] = ids;
  }
  return out;
}

function readLine(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !LINE_ID_RE.test(raw.id)) return null;
  const author = raw.author;
  if (!isObject(author) || typeof author.id !== 'string' || !MEMBER_ID_RE.test(author.id)) return null;
  const text = cleanText(raw.text).trim();
  const ts = time(raw.ts);
  if (!text || !ts) return null;
  return {
    id: raw.id,
    author: { id: author.id, name: cleanLabel(author.name, LIMITS.name) || 'Anonymous', color: cleanColor(author.color) },
    text,
    ts,
    reactions: readReactions(raw.reactions),
  };
}

function readMeta(raw, id) {
  if (!isObject(raw) || raw.id !== id) return null;
  return {
    id,
    name: cleanLabel(raw.name, LIMITS.roomName) || 'Untitled room',
    topic: cleanLabel(raw.topic, LIMITS.topic),
    isPublic: raw.isPublic === true,
    createdAt: time(raw.createdAt) || Date.now(),
  };
}

function readDirectoryEntry(id, payload) {
  if (!isValidRoomId(id) || payload.length > 4096) return null;
  let raw;
  try {
    raw = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  const seenAt = isObject(raw) && raw.id === id ? recent(raw.seenAt) : 0;
  if (!seenAt) return null;
  const people = Number.isInteger(raw.people) ? Math.max(0, Math.min(raw.people, LIMITS.members)) : 0;
  const members = Array.isArray(raw.members)
    ? raw.members.filter(isObject).slice(0, Math.min(5, people)).map((m) => ({ name: cleanLabel(m.name, LIMITS.name) || 'Anonymous', color: cleanColor(m.color) }))
    : [];
  return {
    id,
    name: cleanLabel(raw.name, LIMITS.roomName) || 'Untitled room',
    topic: cleanLabel(raw.topic, LIMITS.topic),
    createdAt: time(raw.createdAt) || seenAt,
    lastActivity: time(raw.lastActivity) || seenAt,
    people,
    members,
    seenAt,
  };
}

const copyReactions = (reactions) => Object.fromEntries(Object.entries(reactions).map(([emoji, ids]) => [emoji, [...ids]]));
const copyLine = (line) => ({ ...line, author: { ...line.author }, reactions: copyReactions(line.reactions) });
const publicMember = ({ id, name, color, text, caret, away, joinedAt }) => ({ id, name, color, text, caret, away, joinedAt });
const byJoined = (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byLiveliness = (a, b) => b.people - a.people || b.lastActivity - a.lastActivity;

/** The newest lines that fit in `maxBytes` of JSON. */
function fitLines(lines, maxBytes) {
  let size = 2;
  let start = lines.length;
  while (start > 0) {
    const next = encoder.encode(JSON.stringify(lines[start - 1])).length + 1;
    if (size + next > maxBytes) break;
    size += next;
    start--;
  }
  return lines.slice(start);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Bugs in handlers shouldn't break the message pipeline, but shouldn't vanish either.
const report = (err) => setTimeout(() => {
  throw err;
});
const roomError = (code, message) => Object.assign(new Error(message), { code });
const offlineError = () => roomError('offline', 'Couldn’t reach the relay. Check your connection and try again.');

// ------------------------------------------------------------------ ids

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ROOM_WORDS = [
  ['quiet', 'amber', 'lunar', 'swift', 'velvet', 'cosmic', 'misty', 'golden', 'neon', 'silver', 'brave', 'gentle', 'hidden', 'sunny', 'wild', 'electric'],
  ['otter', 'harbor', 'falcon', 'meadow', 'lantern', 'orbit', 'maple', 'river', 'ember', 'nova', 'spark', 'pixel', 'cloud', 'canyon', 'koala', 'tiger'],
];

/** Uniform random integer in [0, n) for n ≤ 256 (rejection sampling, no modulo bias). */
function randomInt(n) {
  const limit = 256 - (256 % n);
  for (;;) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    if (byte < limit) return byte % n;
  }
}

export function randomId(length = 12) {
  let out = '';
  while (out.length < length) out += ALPHABET[randomInt(36)];
  return out;
}

/**
 * A new room id. Link-only rooms are only as private as their id is hard to
 * guess, so they get 16 random base36 characters (~82 bits) after the slug.
 */
export function relayRoomId(isPublic = true) {
  const word = (list) => list[randomInt(list.length)];
  return `${word(ROOM_WORDS[0])}-${word(ROOM_WORDS[1])}-${randomId(isPublic ? 3 : 16)}`;
}

let lastSeq = 0;
const nextSeq = () => ++lastSeq;
/** One per page load. With `seq` it identifies a message, so copies arriving via several brokers are dropped. */
export const SESSION_ID = randomId(10);

// --------------------------------------------------------------- crypto

const ciphers = new Map();

/**
 * The room's key material, derived once per room id and cached:
 * { roomId, topicKey, seal(value, channel) → Uint8Array, open(bytes, channel) → value | null }.
 * Payloads are a 12-byte random IV followed by AES-GCM ciphertext of JSON.
 */
export function roomCrypto(roomId) {
  let cipher = ciphers.get(roomId);
  if (!cipher) {
    cipher = deriveCipher(roomId);
    cipher.catch(() => ciphers.delete(roomId));
    ciphers.set(roomId, cipher);
  }
  return cipher;
}

async function deriveCipher(roomId) {
  const { subtle } = globalThis.crypto;
  const base = await subtle.importKey('raw', encoder.encode(roomId), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode('midsentence/v1'), iterations: 60_000 }, base, 256)
  );
  const key = await subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  // The topic comes from the derived bits rather than straight from the room
  // id, so recovering an id from a topic someone sees on a broker costs the
  // same PBKDF2 work as guessing the key itself.
  const label = encoder.encode('midsentence/v1/topic/');
  const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array([...label, ...bits])));
  const topicKey = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  bits.fill(0);

  // The channel is bound in as associated data, so a payload can't be replayed from one topic onto another.
  const aad = (channel) => encoder.encode(`midsentence/v1/${channel}`);
  return {
    roomId,
    topicKey,
    async seal(value, channel) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = encoder.encode(JSON.stringify(value));
      const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(channel) }, key, data));
      const out = new Uint8Array(12 + sealed.length);
      out.set(iv);
      out.set(sealed, 12);
      return out;
    },
    async open(payload, channel) {
      if (!(payload instanceof Uint8Array) || payload.length < 28 || payload.length > MAX_PAYLOAD) return null;
      try {
        const plain = await subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12), additionalData: aad(channel) }, key, payload.subarray(12));
        const value = JSON.parse(decoder.decode(plain));
        return isObject(value) ? value : null;
      } catch {
        return null; // not for us, tampered with, or junk
      }
    },
  };
}

export const roomTopics = (topicKey, prefix = RELAY_PREFIX) => ({
  room: `${prefix}r/${topicKey}`,
  meta: `${prefix}m/${topicKey}`,
  history: `${prefix}h/${topicKey}`,
});

function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

// ------------------------------------------------------------------ hub

/**
 * One per page. Connects to every broker in parallel and keeps each one
 * reconnecting on its own, so the app works as long as any one is reachable.
 * Publishes fan out to all connected brokers; subscriptions apply to current
 * and future connections. Consumers de-duplicate what arrives twice.
 *
 * status: 'connecting' (never been live) | 'live' (≥ 1 broker) | 'reconnecting'
 * Events (hub.on): 'status' (status), 'link' (url: a broker connected afresh), 'change'.
 */
export class RelayHub {
  constructor({ urls = DEFAULT_RELAYS, WebSocket, keepalive = 30 } = {}) {
    this.urls = [...new Set(urls)].filter((url) => typeof url === 'string' && /^wss?:\/\//i.test(url));
    this.WebSocket = WebSocket;
    this.keepalive = keepalive;
    this.status = 'connecting';
    this.everLive = false;
    this.will = null;
    this.closed = false;
    this.subs = new Map(); // filter → Set(handler)
    this.listeners = new Map();
    /** Room meta seen on this page, by room id (filled by lookups, creation and rooms). */
    this.metaCache = new Map();
    this.links = this.urls.map((url) => new Link(this, url));
    for (const link of this.links) link.open();

    // Network back, or tab back from the background (where sockets quietly die):
    // reconnect what's down right away and probe what claims to be up.
    this.wake = this.wake.bind(this);
    this.onVisible = () => document.visibilityState === 'visible' && this.wake();
    if (typeof window !== 'undefined') window.addEventListener?.('online', this.wake);
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', this.onVisible);
  }

  get live() {
    return this.links.some((link) => link.live);
  }

  on(event, fn) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(event, value) {
    for (const fn of [...(this.listeners.get(event) || [])]) fn(value);
  }

  /** Called by links whenever a connection or subscription changes. */
  changed() {
    const status = this.live ? 'live' : this.everLive ? 'reconnecting' : 'connecting';
    if (status === 'live') this.everLive = true;
    if (status !== this.status) {
      this.status = status;
      this.emit('status', status);
    }
    this.emit('change');
  }

  /** handler(topic, payload: Uint8Array, { retain }). Returns unsubscribe(). */
  subscribe(filter, handler) {
    let handlers = this.subs.get(filter);
    if (!handlers) {
      this.subs.set(filter, (handlers = new Set()));
      for (const link of this.links) link.subscribe([filter]);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size || this.subs.get(filter) !== handlers) return;
      this.subs.delete(filter);
      for (const link of this.links) link.unsubscribe([filter]);
    };
  }

  dispatch(topic, payload, info) {
    for (const [filter, handlers] of this.subs) {
      if (!topicMatches(filter, topic)) continue;
      for (const handler of [...handlers]) {
        try {
          handler(topic, payload, info);
        } catch (err) {
          report(err);
        }
      }
    }
  }

  /** QoS 0 publish to every connected broker. Returns how many it went to. */
  publish(topic, payload, { retain = false } = {}) {
    let sent = 0;
    for (const link of this.links) if (link.client?.publish(topic, payload, { retain })) sent++;
    return sent;
  }

  /**
   * Sets the last will ({ topic, payload } or null) for every connection. Live
   * connections are replaced make-before-break, so nothing drops meanwhile.
   */
  setWill(will) {
    this.will = will;
    for (const link of this.links) if (link.client || link.pending) link.open();
  }

  /** Resolves true once ≥ 1 broker is live and every live broker has acknowledged `filters`. */
  settled(filters, timeout = 0) {
    const done = () => {
      const live = this.links.filter((link) => link.live);
      return live.length > 0 && live.every((link) => filters.every((f) => link.client.acked.has(f)));
    };
    return this.until(done, timeout);
  }

  /** Resolves true once ≥ 1 broker is live (false after `timeout` ms, if given). */
  ready(timeout = 0) {
    return this.until(() => this.live, timeout);
  }

  until(check, timeout) {
    if (check()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer;
      const off = this.on('change', () => check() && finish(true));
      const finish = (ok) => {
        clearTimeout(timer);
        off();
        resolve(ok);
      };
      if (timeout) timer = setTimeout(() => finish(check()), timeout);
    });
  }

  wake() {
    for (const link of this.links) link.wake();
  }

  /** graceful: false drops sockets without DISCONNECT, so brokers publish the last will (tests use it to simulate a crash). */
  close({ graceful = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    for (const link of this.links) link.close(graceful);
    if (typeof window !== 'undefined') window.removeEventListener?.('online', this.wake);
    if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', this.onVisible);
    this.listeners.clear();
  }
}

/** One broker: a current connection, maybe a pending one, and a backoff timer. */
class Link {
  constructor(hub, url) {
    this.hub = hub;
    this.url = url;
    this.client = null; // the connection in use
    this.pending = null; // a connection being set up (first, after a drop, or replacing `client`)
    this.attempt = 0;
    this.timer = null;
  }

  get live() {
    return Boolean(this.client?.connected);
  }

  open() {
    const { hub } = this;
    if (hub.closed) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pending) {
      const stale = this.pending;
      this.pending = null;
      stale.end();
    }
    const client = new MqttClient(this.url, { will: hub.will, keepalive: hub.keepalive, WebSocket: hub.WebSocket });
    client.acked = new Set();
    client.onmessage = (topic, payload, info) => hub.dispatch(topic, payload, info);
    this.pending = client;
    client.connect().then(
      () => {
        if (this.pending !== client || hub.closed) return client.end();
        client.onclose = () => this.dropped(client);
        const filters = [...hub.subs.keys()];
        if (!filters.length) return this.adopt(client);
        client.subscribe(filters).then(() => {
          for (const f of filters) if (hub.subs.has(f)) client.acked.add(f);
          this.adopt(client);
        }, () => this.failed(client));
      },
      () => this.failed(client)
    );
  }

  /** The pending connection is ready (and subscribed): make it the current one. */
  adopt(client) {
    if (this.pending !== client) return client.end();
    this.pending = null;
    const previous = this.client;
    this.client = client;
    this.attempt = 0;
    if (previous) {
      previous.onclose = previous.onmessage = null;
      previous.end();
    }
    this.hub.changed();
    if (!previous) this.hub.emit('link', this.url);
  }

  failed(client) {
    client.end(); // never destroy(): that would fire a will we're still using
    if (this.pending !== client) return;
    this.pending = null;
    if (!this.client) this.retry(); // a failed replacement leaves the current connection in place
  }

  dropped(client) {
    if (this.client !== client) return;
    this.client = null;
    this.hub.changed();
    if (!this.pending) this.retry();
  }

  retry() {
    if (this.hub.closed) return;
    const delayMs = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delayMs);
  }

  subscribe(filters) {
    for (const client of [this.client, this.pending]) {
      if (!client?.connected) continue; // a pending connection subscribes to everything once it connects
      client.subscribe(filters).then(() => {
        for (const f of filters) if (this.hub.subs.has(f)) client.acked.add(f);
        this.hub.changed();
      }, () => {});
    }
  }

  unsubscribe(filters) {
    for (const client of [this.client, this.pending]) {
      if (!client?.connected) continue;
      for (const f of filters) client.acked.delete(f);
      client.unsubscribe(filters).catch(() => {});
    }
  }

  wake() {
    if (this.client) this.client.checkAlive();
    else if (!this.pending) {
      this.attempt = 0;
      this.open();
    }
  }

  close(graceful) {
    clearTimeout(this.timer);
    for (const client of [this.client, this.pending]) if (client) graceful ? client.end() : client.destroy();
    this.client = this.pending = null;
  }
}

// ------------------------------------------------------------ directory

const seedMeta = (seed) => ({ id: seed.id, name: seed.name, topic: seed.topic || '', isPublic: true, createdAt: BOOT });

function roomSummary(meta, { people = 0, members = [], lastActivity } = {}) {
  const { id, name, topic, isPublic, createdAt } = meta;
  return { id, name, topic, isPublic, createdAt, lastActivity: lastActivity || createdAt, people, members };
}

/**
 * The list of public rooms, from retained entries at d/<roomId>. Seeded rooms
 * are always listed. Entries nobody has refreshed for 75s count as empty.
 */
export class RelayDirectory {
  constructor(hub, { seeds = [], prefix = RELAY_PREFIX } = {}) {
    this.hub = hub;
    this.seeds = seeds.filter((seed) => isValidRoomId(seed?.id));
    this.prefix = prefix;
    this.filter = `${prefix}d/+`;
    this.entries = new Map();
    this.watchers = new Set();
    this.isReady = false;
    this.off = hub.subscribe(this.filter, (topic, payload) => this.receive(topic, payload));
  }

  /** Resolves once the retained entries have (most likely) arrived, or after ~2.5s offline. */
  ready() {
    this.readyPromise ||= this.hub
      .settled([this.filter], TIMING.lookup)
      .then((ok) => ok && delay(TIMING.grace))
      .then(() => {
        this.isReady = true;
      });
    return this.readyPromise;
  }

  receive(topic, payload) {
    const id = topic.slice(this.filter.length - 1);
    if (!payload.length) {
      if (this.entries.delete(id)) this.changed();
      return;
    }
    const entry = readDirectoryEntry(id, payload);
    if (!entry) return;
    const known = this.entries.get(id);
    if (known && known.seenAt > entry.seenAt) return; // brokers can hold different versions: keep the freshest
    this.entries.set(id, entry);
    if (this.entries.size > DIRECTORY.entries) {
      const oldest = [...this.entries.values()].reduce((a, b) => (a.seenAt <= b.seenAt ? a : b));
      this.entries.delete(oldest.id);
    }
    this.changed();
  }

  summarize(entry, now) {
    const fresh = now - entry.seenAt <= DIRECTORY.fresh;
    return {
      id: entry.id,
      name: entry.name,
      topic: entry.topic,
      isPublic: true,
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
      people: fresh ? entry.people : 0,
      members: fresh ? entry.members.map((m) => ({ ...m })) : [],
    };
  }

  /** The summary for one listed room, or null. */
  lookup(id, now = Date.now()) {
    const seed = this.seeds.find((s) => s.id === id);
    const entry = this.entries.get(id);
    if (seed) return this.summarize({ createdAt: BOOT, lastActivity: BOOT, people: 0, members: [], seenAt: 0, ...entry, ...seedMeta(seed) }, now);
    if (!entry || now - Math.max(entry.seenAt, entry.lastActivity) > DIRECTORY.maxAge) return null;
    return this.summarize(entry, now);
  }

  /** Public rooms, busiest first, then most recently active. */
  rooms(now = Date.now()) {
    const seeds = this.seeds.map((seed) => this.lookup(seed.id, now));
    const others = [];
    for (const id of this.entries.keys()) {
      if (this.seeds.some((s) => s.id === id)) continue;
      const room = this.lookup(id, now);
      if (room) others.push(room);
    }
    others.sort(byLiveliness);
    return [...seeds, ...others.slice(0, Math.max(0, DIRECTORY.listed - seeds.length))].sort(byLiveliness);
  }

  stats() {
    const rooms = this.rooms();
    return { people: rooms.reduce((n, r) => n + r.people, 0), liveRooms: rooms.filter((r) => r.people > 0).length, rooms: rooms.length };
  }

  /** callback(rooms) once known and again on every change. Returns unsubscribe(). */
  watch(callback) {
    const watcher = { callback, last: null };
    this.watchers.add(watcher);
    this.ready().then(() => this.notify(watcher));
    // Entries go stale with time alone, so look again every so often.
    this.ticker ||= setInterval(() => this.notifyAll(), 10_000);
    return () => {
      this.watchers.delete(watcher);
      if (this.watchers.size) return;
      clearInterval(this.ticker);
      this.ticker = null;
    };
  }

  changed() {
    if (!this.isReady || this.pendingNotify || !this.watchers.size) return;
    this.pendingNotify = setTimeout(() => {
      this.pendingNotify = null;
      this.notifyAll();
    }, 120);
  }

  notifyAll() {
    for (const watcher of this.watchers) this.notify(watcher);
  }

  notify(watcher) {
    if (!this.watchers.has(watcher)) return;
    const rooms = this.rooms();
    const key = JSON.stringify(rooms);
    if (key === watcher.last) return;
    watcher.last = key;
    try {
      watcher.callback(rooms);
    } catch (err) {
      report(err);
    }
  }

  close() {
    this.off();
    clearInterval(this.ticker);
    clearTimeout(this.pendingNotify);
    this.ticker = this.pendingNotify = null;
    this.watchers.clear();
  }
}

// --------------------------------------------------- room lookup/creation

/** Waits for a retained, encrypted record on `topic`. Null if no broker has one. */
function fetchRetained(hub, topic, decode, deadline) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const off = hub.subscribe(topic, (_, payload) => {
      if (payload.length) decode(payload).then((value) => value && finish(value), () => {});
    });
    timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    hub.settled([topic], Math.max(1, deadline - Date.now())).then(async (ok) => {
      if (!ok || done) return;
      await delay(TIMING.grace);
      // Retained messages follow the SUBACK. Unless a broker is still on its
      // first connection attempt, we've now heard from everyone who could answer.
      if (!hub.links.some((link) => !link.live && link.attempt === 0)) finish(null);
    });
  });
}

/** Asks who's in a room. Members answer `here`, which also proves the room exists. */
async function peekRoom(hub, cipher, topics, wait) {
  const visitor = randomId(12);
  const members = new Map();
  let meta = null;
  const off = hub.subscribe(topics.room, (_, payload) => {
    cipher.open(payload, 'r').then((msg) => {
      if (msg?.k !== 'here' || msg.from === visitor) return;
      const member = readMember(msg.member, msg.from);
      if (member && MEMBER_ID_RE.test(member.id)) members.set(member.id, member);
      meta ||= readMeta(msg.room, cipher.roomId);
    });
  });
  try {
    await hub.settled([topics.room], wait * 2);
    hub.publish(topics.room, await cipher.seal({ k: 'peek', from: visitor, sid: SESSION_ID, seq: nextSeq() }, 'r'));
    await delay(wait);
  } finally {
    off();
  }
  return { members: [...members.values()].sort(byJoined), meta };
}

/**
 * getRoom() for relay mode: the room summary, or null if it doesn't exist.
 * Seeded rooms resolve immediately; others need their retained meta (or
 * someone present to vouch for them). Throws { code: 'offline' } when no broker answers.
 */
export async function getRelayRoom(hub, id, { seeds = [], directory = null, prefix = RELAY_PREFIX, timeout = TIMING.lookup } = {}) {
  if (!isValidRoomId(id)) return null;
  const seed = seeds.find((s) => s.id === id);
  if (seed) return directory?.lookup(id) || roomSummary(seedMeta(seed), { lastActivity: BOOT });

  const deadline = Date.now() + timeout;
  if (!(await hub.ready(timeout))) throw offlineError();
  const cipher = await roomCrypto(id);
  const topics = roomTopics(cipher.topicKey, prefix);
  let meta = hub.metaCache.get(id);
  if (!meta) {
    meta = await fetchRetained(hub, topics.meta, (payload) => cipher.open(payload, 'm').then((raw) => readMeta(raw, id)), deadline);
    if (meta) hub.metaCache.set(id, meta);
  }

  if (meta?.isPublic && directory) {
    await directory.ready();
    const listed = directory.lookup(id);
    if (listed) return roomSummary(meta, listed);
  }

  const here = await peekRoom(hub, cipher, topics, TIMING.peek);
  if (!meta && here.meta) hub.metaCache.set(id, (meta = here.meta));
  if (!meta && here.members.length) meta = fallbackMeta(id);
  if (!meta) return null;
  const members = here.members.slice(0, 5).map(({ name, color }) => ({ name, color }));
  return roomSummary(meta, { people: here.members.length, members, lastActivity: here.members.length ? Date.now() : undefined });
}

/** createRoom() for relay mode. Publishes the retained meta (and a directory entry if public). */
export async function createRelayRoom(hub, { id, name, topic, isPublic = true, seeds = [], prefix = RELAY_PREFIX } = {}) {
  if (id != null && id !== '' && !isValidRoomId(id)) throw roomError('bad_id', 'Room links can only use a–z, 0–9 and dashes.');
  const listed = isPublic !== false;
  if (!(await hub.ready(TIMING.lookup * 2))) throw offlineError();

  if (id) {
    const exists = () => roomError('exists', 'That room already exists.');
    if (seeds.some((s) => s.id === id) || hub.metaCache.has(id)) throw exists();
    const cipher = await roomCrypto(id);
    const decode = (payload) => cipher.open(payload, 'm').then((raw) => readMeta(raw, id));
    const found = await fetchRetained(hub, roomTopics(cipher.topicKey, prefix).meta, decode, Date.now() + TIMING.lookup);
    if (found) {
      hub.metaCache.set(id, found);
      throw exists();
    }
  }

  const now = Date.now();
  const meta = {
    id: id || relayRoomId(listed),
    name: cleanLabel(name, LIMITS.roomName) || 'Untitled room',
    topic: cleanLabel(topic, LIMITS.topic),
    isPublic: listed,
    createdAt: now,
  };
  const cipher = await roomCrypto(meta.id);
  if (!hub.publish(roomTopics(cipher.topicKey, prefix).meta, await cipher.seal(meta, 'm'), { retain: true })) throw offlineError();
  hub.metaCache.set(meta.id, meta);
  if (listed) {
    const entry = { id: meta.id, name: meta.name, topic: meta.topic, createdAt: now, lastActivity: now, people: 0, members: [], seenAt: now };
    hub.publish(`${prefix}d/${meta.id}`, JSON.stringify(entry), { retain: true });
  }
  return roomSummary(meta, { lastActivity: now });
}

/** When people are present but the meta is gone (a broker lost it), name the room after its id. */
function fallbackMeta(id) {
  const name = id
    .replace(/-[a-z0-9]{16}$|-[a-z0-9]{3}$/, '')
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
  return { id, name: name.slice(0, LIMITS.roomName) || 'Untitled room', topic: '', isPublic: false, createdAt: Date.now() };
}

// ----------------------------------------------------------------- room

/**
 * A room connection with the same interface and events as SocketRoom:
 * type(), commit(), react(), profile(), away(), close(); emits status,
 * welcome, join, leave, profile, type, line, react, error and replaced.
 *
 * Wire messages (encrypted on the room channel) are envelopes
 * { k, from, sid, seq, ...data } with k one of: hello, here, ping, type, line,
 * react, profile, away, bye, peek, sync.
 */
export class RelayRoom {
  constructor({ roomId, me, on = {}, hub, seeds = [], prefix = RELAY_PREFIX, sid = SESSION_ID, timing = {} }) {
    this.handlers = on;
    this.roomId = roomId;
    this.hub = hub;
    this.prefix = prefix;
    this.sid = sid;
    this.t = { ...TIMING, ...timing };
    const seed = seeds.find((s) => s.id === roomId);
    this.seed = Boolean(seed);
    this.meta = seed ? seedMeta(seed) : hub.metaCache.get(roomId) || null;
    this.metaKnown = !seed && Boolean(this.meta); // real meta we can republish (not a seed's or a fallback)
    this.me = { id: me.id, name: cleanLabel(me.name, LIMITS.name) || 'Anonymous', color: cleanColor(me.color), text: '', caret: 0, away: false, joinedAt: Date.now() };
    this.members = new Map(); // everyone else here: id → member + { sid, seen }
    this.lines = []; // oldest first
    this.lineIndex = new Map();
    this.streams = new Map(); // `${from}:${sid}` → { max, seen, typeSeq }
    this.history = null;
    this.historyFloor = 0;
    this.outbox = [];
    this.inbox = Promise.resolve();
    this.outgoing = Promise.resolve();
    this.timers = new Map();
    this.offs = [];
    this.phase = 'joining'; // → 'joined' → 'closed'
    this.closed = false;
    this.lastActivity = Date.now();
    this.lastTypeAt = 0;
    this.lastSentAt = 0;
    this.lastPeekReply = 0;
    queueMicrotask(() => this.emit('status', 'connecting'));
    this.start().catch(report);
  }

  emit(type, payload) {
    if (!this.closed) this.handlers[type]?.(payload);
  }

  async start() {
    this.cipher = await roomCrypto(this.roomId);
    if (this.closed) return;
    const topics = (this.topics = roomTopics(this.cipher.topicKey, this.prefix));
    // Our goodbye, sealed once up front. It doubles as the MQTT last will, so a
    // crashed or killed tab still says bye, and close() can send it synchronously.
    this.byePayload = await this.cipher.seal({ k: 'bye', from: this.me.id, sid: this.sid, seq: nextSeq(), id: this.me.id }, 'r');
    if (this.closed) return;
    this.hub.setWill({ topic: topics.room, payload: this.byePayload });
    this.offs.push(
      this.hub.subscribe(topics.room, (_, payload) => this.enqueue('r', payload)),
      this.hub.subscribe(topics.meta, (_, payload) => this.enqueue('m', payload)),
      this.hub.subscribe(topics.history, (_, payload) => this.enqueue('h', payload)),
      this.hub.on('status', (status) => this.onHubStatus(status)),
      // A broker came back while others stayed up: peers who only share that one need to hear from us.
      this.hub.on('link', () => this.phase === 'joined' && this.send('ping', { member: this.wireMe() }))
    );
    await this.hub.settled([topics.room, topics.meta, topics.history]);
    if (this.closed) return;
    this.send('hello', { member: this.wireMe() });
    this.later('welcome', () => this.welcome(), this.t.join);
  }

  welcome() {
    const others = this.members.size;
    if (!this.meta && !others) return this.fail('not_found', 'This room has ended or never existed.');
    if (others >= LIMITS.members) return this.fail('full', 'This room is full.');
    this.meta ||= fallbackMeta(this.roomId);

    const now = Date.now();
    if (!others && this.history && now - this.history.updatedAt > this.t.dissolve) {
      // Like on the server: a room that's sat empty for a while starts over.
      this.lines = [];
      this.lineIndex.clear();
      this.history = null;
      this.historyFloor = now;
      this.hub.publish(this.topics.history, new Uint8Array(0), { retain: true });
    }

    this.phase = 'joined';
    this.emit('status', this.hub.live ? 'live' : 'reconnecting');
    this.emit('welcome', {
      you: this.me.id,
      room: this.summary(),
      members: [this.publicMe(), ...[...this.members.values()].map(publicMember)],
      lines: this.lines.map(copyLine),
    });

    this.every('ping', () => this.send('ping', { member: this.wireMe() }), this.t.ping);
    this.every('sweep', () => this.sweep(), this.t.sweep);
    this.every('directory', () => this.isHost() && this.publishDirectory(), this.t.directory);
    this.every('history', () => this.isHost() && this.lines.length && this.publishHistory(), this.t.historyRefresh);
    if (this.isHost() && this.metaKnown) this.publishMeta(); // cheap self-healing if a broker lost it
    this.scheduleDirectory();
    if (this.me.text) this.queueType();
    this.flushOutbox();
  }

  fail(code, message) {
    this.emit('error', { code, message });
    this.close();
  }

  // -------------------------------------------------------------- inbound

  enqueue(channel, payload) {
    if (!payload.length || payload.length > MAX_PAYLOAD) return;
    // Decrypting is async; chain it so messages are handled strictly in arrival order.
    this.inbox = this.inbox
      .then(async () => {
        if (this.closed) return;
        const value = await this.cipher.open(payload, channel);
        if (!value || this.closed) return;
        if (channel === 'r') this.receive(value);
        else if (channel === 'm') this.receiveMeta(value);
        else this.receiveHistory(value);
      })
      .catch(report);
  }

  receive(msg) {
    const { k: kind, from, sid, seq } = msg;
    if (typeof kind !== 'string' || typeof from !== 'string' || !MEMBER_ID_RE.test(from)) return;
    if (typeof sid !== 'string' || !sid || sid.length > 40 || !Number.isSafeInteger(seq) || seq < 1) return;
    if (from === this.me.id) {
      // Our own echo — or another tab took our seat (a duplicated tab): the newer one wins, as on the server.
      if (sid !== this.sid && kind === 'hello' && this.phase === 'joined') this.replaced();
      return;
    }
    // A bye is idempotent and may be our precomputed last will, so it skips the replay check.
    if (kind === 'bye') return this.onBye(from, sid);
    const stream = this.fresh(from, sid, seq);
    if (!stream) return;
    const known = this.members.get(from);
    if (known) known.seen = Date.now();
    // Background tabs may run our ping timer only once a minute, but incoming
    // messages still arrive: answer one with a ping when ours is overdue.
    if (this.phase === 'joined' && Date.now() - this.lastSentAt > this.t.ping) this.send('ping', { member: this.wireMe() });

    switch (kind) {
      case 'hello':
        return this.onHello(msg, stream);
      case 'here':
      case 'ping':
      case 'profile':
        return this.onPresence(msg, stream);
      case 'type':
        return this.onType(msg, stream);
      case 'line':
        return this.onLine(msg, stream);
      case 'react':
        return this.onReact(msg);
      case 'away':
        return this.onAway(msg);
      case 'peek':
        return this.onPeek();
      case 'sync':
        return this.mergeLines(msg.lines, { fresher: true });
    }
  }

  /** De-duplicates by (from, sid, seq). Returns the sender's stream state, or null for a repeat. */
  fresh(from, sid, seq) {
    const key = `${from}:${sid}`;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { max: 0, seen: new Set(), typeSeq: 0 };
      this.streams.set(key, stream);
      if (this.streams.size > 500) this.streams.delete(this.streams.keys().next().value);
    }
    if (seq <= stream.max - DEDUPE_WINDOW || stream.seen.has(seq)) return null;
    stream.seen.add(seq);
    if (seq > stream.max) {
      stream.max = seq;
      if (stream.seen.size > DEDUPE_WINDOW * 2) for (const n of stream.seen) if (n <= seq - DEDUPE_WINDOW) stream.seen.delete(n);
    }
    return stream;
  }

  onHello(msg, stream) {
    if (!this.upsert(msg, stream, msg.again === true ? 'quiet' : 'arrival')) return;
    // Everyone answers, so the newcomer learns who's here; the host also sends recent lines.
    this.send('here', { member: this.wireMe(), room: this.metaKnown ? this.meta : undefined });
    if (this.phase === 'joined' && this.isHost()) this.send('sync', { lines: fitLines(this.lines.slice(-LIMITS.sync), SYNC_BYTES) });
  }

  onPresence(msg, stream) {
    this.upsert(msg, stream, 'quiet');
    if (msg.k === 'here' && !this.metaKnown && !this.seed) {
      const meta = readMeta(msg.room, this.roomId);
      if (meta) this.setMeta(meta);
    }
  }

  /** Adds or refreshes a member from a message carrying { member }. `how`: 'arrival' | 'quiet'. */
  upsert(msg, stream, how) {
    const info = readMember(msg.member, msg.from);
    if (!info) return null;
    let member = this.members.get(info.id);
    const draftIsNewer = msg.seq > stream.typeSeq;
    if (draftIsNewer) stream.typeSeq = msg.seq;

    if (!member) {
      if (this.members.size >= LIMITS.members * 2) return null;
      member = { ...info, sid: msg.sid, seen: Date.now() };
      this.members.set(info.id, member);
      if (this.phase === 'joined') {
        this.emit('join', { member: publicMember(member), quiet: how !== 'arrival' });
        this.membershipChanged({ arrived: true });
      }
      return member;
    }

    // Only a hello moves a member to a new session (a reload); stray messages from an old one don't.
    if (msg.k === 'hello') member.sid = msg.sid;
    member.seen = Date.now();
    const profileChanged = member.name !== info.name || member.color !== info.color || member.away !== info.away;
    Object.assign(member, { name: info.name, color: info.color, away: info.away, joinedAt: info.joinedAt });
    let draftChanged = false;
    if (draftIsNewer && (member.text !== info.text || member.caret !== info.caret)) {
      Object.assign(member, { text: info.text, caret: info.caret });
      draftChanged = true;
    }
    if (this.phase === 'joined') {
      if (profileChanged) {
        this.emit('profile', { member: publicMember(member) });
        this.membershipChanged();
      }
      if (draftChanged) this.emit('type', { id: member.id, text: member.text, caret: member.caret });
    }
    return member;
  }

  onType(msg, stream) {
    const member = this.members.get(msg.from);
    // An older keystroke (e.g. via a slower broker) must never overwrite a newer one.
    if (!member || msg.seq <= stream.typeSeq) return;
    stream.typeSeq = msg.seq;
    member.text = cleanText(msg.text);
    member.caret = clampCaret(msg.caret, member.text);
    this.lastActivity = Date.now();
    if (this.phase === 'joined') this.emit('type', { id: member.id, text: member.text, caret: member.caret });
  }

  onLine(msg, stream) {
    const line = readLine(msg.line);
    if (!line || line.author.id !== msg.from || this.lineIndex.has(line.id)) return;
    line.reactions = {};
    this.addLine(line);
    // Committing clears the author's draft; that also outranks any older keystroke still in flight.
    const member = this.members.get(msg.from);
    if (msg.seq > stream.typeSeq) {
      stream.typeSeq = msg.seq;
      if (member?.text) {
        member.text = '';
        member.caret = 0;
        if (this.phase === 'joined') this.emit('type', { id: member.id, text: '', caret: 0 });
      }
    }
    if (this.phase !== 'joined') return;
    this.emit('line', { line: copyLine(line) });
    this.touched();
  }

  onReact(msg) {
    const line = this.lineIndex.get(msg.line);
    if (!line || !isEmoji(msg.emoji) || typeof msg.on !== 'boolean') return;
    if (!this.setReaction(line, msg.emoji, msg.from, msg.on) || this.phase !== 'joined') return;
    this.emit('react', { line: line.id, reactions: copyReactions(line.reactions) });
    this.scheduleHistory();
  }

  onAway(msg) {
    const member = this.members.get(msg.from);
    const away = msg.away === true;
    if (!member || member.away === away) return;
    member.away = away;
    if (this.phase === 'joined') this.emit('profile', { member: publicMember(member) });
  }

  onPeek() {
    // A lobby visitor asking who's here. Rate-limited: lobbies poll.
    const now = Date.now();
    if (this.phase !== 'joined' || now - this.lastPeekReply < 2000) return;
    this.lastPeekReply = now;
    this.send('here', { member: this.wireMe(), room: this.metaKnown ? this.meta : undefined });
  }

  onBye(from, sid) {
    const member = this.members.get(from);
    // A late will from someone's previous session (they reloaded) must not remove the new one.
    if (member && member.sid === sid) this.removeMember(from);
  }

  receiveMeta(raw) {
    if (this.seed) return;
    const meta = readMeta(raw, this.roomId);
    if (meta) this.setMeta(meta);
  }

  setMeta(meta) {
    this.meta = meta;
    this.metaKnown = true;
    this.hub.metaCache.set(this.roomId, meta);
  }

  receiveHistory(raw) {
    const updatedAt = time(raw.updatedAt);
    // Older than a dissolve we performed: a stale copy from another broker.
    if (!updatedAt || updatedAt < this.historyFloor || !Array.isArray(raw.lines)) return;
    if (!this.history || updatedAt > this.history.updatedAt) this.history = { updatedAt };
    this.mergeLines(raw.lines, { fresher: false });
  }

  /**
   * Merges lines from retained history or a host's sync. Before welcome they're
   * folded into the transcript (a sync's reactions beat retained history's);
   * afterwards, lines we didn't have arrive as ordinary `line` events.
   */
  mergeLines(rawLines, { fresher }) {
    if (!Array.isArray(rawLines)) return;
    const added = [];
    for (const raw of rawLines.slice(-LIMITS.history)) {
      const line = readLine(raw);
      if (!line || line.ts < this.historyFloor) continue;
      const known = this.lineIndex.get(line.id);
      if (known) {
        if (fresher && this.phase === 'joining') known.reactions = line.reactions;
        continue;
      }
      this.addLine(line);
      added.push(line);
    }
    if (this.phase === 'joined') for (const line of added) this.emit('line', { line: copyLine(line) });
  }

  // ------------------------------------------------------------- outbound

  send(kind, data = {}, after) {
    if (!this.cipher || this.closed) return;
    this.lastSentAt = Date.now();
    const envelope = { k: kind, from: this.me.id, sid: this.sid, seq: nextSeq(), ...data };
    // Chained so publish order matches seq order.
    this.outgoing = this.outgoing
      .then(() => this.cipher.seal(envelope, 'r'))
      .then((payload) => {
        // After close() (and its bye), only lines still go out — anything else would bring us back as a ghost.
        if (this.closed && kind !== 'line') return;
        const sent = this.hub.publish(this.topics.room, payload) > 0;
        after?.(sent);
      })
      .catch(report);
  }

  wireMe() {
    const { id, name, color, joinedAt, text, caret, away } = this.me;
    return { id, name, color, joinedAt, text, caret, away };
  }

  publicMe() {
    return publicMember(this.me);
  }

  type(text, caret) {
    this.me.text = cleanText(text);
    this.me.caret = clampCaret(caret, this.me.text);
    this.lastActivity = Date.now();
    if (this.phase === 'joined') this.queueType();
  }

  /** Throttled to one message per typeGap, always sending the latest draft (trailing edge). */
  queueType() {
    if (this.timers.has('type')) return; // the scheduled send will pick up the latest draft
    const wait = this.lastTypeAt + this.t.typeGap - Date.now();
    if (wait <= 0) this.sendType();
    else this.later('type', () => this.sendType(), wait);
  }

  sendType() {
    this.lastTypeAt = Date.now();
    this.send('type', { text: this.me.text, caret: this.me.caret });
  }

  commit(text, nonce) {
    this.cancel('type');
    this.me.text = '';
    this.me.caret = 0;
    const body = cleanText(text).trim();
    if (!body) {
      if (this.phase === 'joined') this.sendType();
      return;
    }
    const item = { text: body, nonce: typeof nonce === 'string' ? nonce.slice(0, 40) : undefined };
    // Offline (or not in yet): hold the line and send it once we're back, like SocketRoom does.
    if (this.phase === 'joined' && this.hub.live && !this.outbox.length) this.sendLine(item);
    else this.outbox.push(item);
  }

  sendLine({ text, nonce }) {
    const line = { id: randomId(12), author: { id: this.me.id, name: this.me.name, color: this.me.color }, text, ts: Date.now(), reactions: {} };
    this.send('line', { line, nonce }, (sent) => {
      if (!sent) return this.outbox.push({ text, nonce });
      if (this.closed) return;
      this.addLine(line);
      this.touched();
      this.emit('line', { line: copyLine(line), nonce });
    });
  }

  flushOutbox() {
    if (this.phase !== 'joined' || !this.hub.live) return;
    for (const item of this.outbox.splice(0)) this.sendLine(item);
  }

  react(lineId, emoji) {
    const line = this.lineIndex.get(lineId);
    if (!line || !isEmoji(emoji) || this.phase !== 'joined') return;
    const on = !line.reactions[emoji]?.includes(this.me.id);
    if (!this.setReaction(line, emoji, this.me.id, on)) return;
    this.emit('react', { line: line.id, reactions: copyReactions(line.reactions) });
    // The desired state, not a toggle, so a duplicate or replay can't flip it back.
    this.send('react', { line: line.id, emoji, on });
    this.scheduleHistory();
  }

  profile({ name, color } = {}) {
    const clean = cleanLabel(name, LIMITS.name);
    if (clean) this.me.name = clean;
    if (typeof color === 'string' && COLOR_RE.test(color)) this.me.color = color.toLowerCase();
    this.send('profile', { member: this.wireMe() });
    if (this.phase !== 'joined') return;
    this.emit('profile', { member: this.publicMe() });
    this.scheduleDirectory();
  }

  away(away) {
    this.me.away = Boolean(away);
    this.send('away', { away: this.me.away });
  }

  replaced() {
    this.emit('replaced');
    this.close({ quiet: true }); // the other tab holds our seat now: no bye
  }

  /** Leaves the room. The bye goes out synchronously; the returned promise settles once the rest is sent. */
  close({ quiet = false } = {}) {
    if (this.closed) return Promise.resolve();
    const alone = this.phase === 'joined' && this.members.size === 0;
    this.closed = true;
    this.phase = 'closed';
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const off of this.offs.splice(0)) off();
    if (quiet || !this.byePayload) return Promise.resolve();
    this.hub.publish(this.topics.room, this.byePayload);
    let final;
    if (alone) {
      // Last one out: mark the room empty in the directory, and re-stamp the
      // history so it dissolves ten minutes from now (as on the server) instead
      // of right away — a reload shouldn't wipe a room you're alone in.
      if (this.meta?.isPublic) this.hub.publish(this.directoryTopic(), JSON.stringify(this.directoryEntry(0)), { retain: true });
      if (this.lines.length) final = this.publishHistory();
    }
    return Promise.all([this.outgoing, final]).then(() => {});
  }

  // ----------------------------------------------------- presence & host

  present() {
    return [this.me, ...this.members.values()].sort(byJoined);
  }

  /** The present member who joined first keeps the room's retained state. */
  isHost() {
    return this.present()[0] === this.me;
  }

  summary() {
    const present = this.present();
    return roomSummary(this.meta, {
      people: present.length,
      members: present.slice(0, 5).map(({ name, color }) => ({ name, color })),
      lastActivity: this.lastActivity,
    });
  }

  sweep() {
    if (!this.hub.live) return; // we can't hear anyone right now; that isn't them leaving
    const cutoff = Date.now() - this.t.ttl;
    for (const member of [...this.members.values()]) if (member.seen < cutoff) this.removeMember(member.id);
  }

  removeMember(id) {
    if (!this.members.delete(id) || this.phase !== 'joined') return;
    this.emit('leave', { id });
    this.membershipChanged();
  }

  membershipChanged({ arrived = false } = {}) {
    if (this.phase !== 'joined') return;
    if (arrived) {
      this.lastActivity = Date.now();
      if (this.isHost() && this.metaKnown) this.publishMeta();
    }
    this.scheduleDirectory();
  }

  onHubStatus(status) {
    if (this.phase !== 'joined') return;
    if (status !== 'live') return this.emit('status', 'reconnecting');
    // Back from a full outage. We couldn't hear anyone meanwhile, so give
    // everyone a fresh grace period and say hello again: they answer, and the
    // host re-sends the lines we missed.
    const now = Date.now();
    for (const member of this.members.values()) member.seen = now;
    this.emit('status', 'live');
    this.send('hello', { member: this.wireMe(), again: true });
    this.flushOutbox();
  }

  addLine(line) {
    this.lineIndex.set(line.id, line);
    let i = this.lines.length;
    while (i > 0 && this.lines[i - 1].ts > line.ts) i--;
    this.lines.splice(i, 0, line);
    if (this.lines.length > LIMITS.lines) for (const old of this.lines.splice(0, this.lines.length - LIMITS.lines)) this.lineIndex.delete(old.id);
  }

  setReaction(line, emoji, who, on) {
    const ids = line.reactions[emoji] || [];
    if (ids.includes(who) === on) return false;
    if (on && !ids.length && Object.keys(line.reactions).length >= 12) return false;
    const next = on ? [...ids, who] : ids.filter((id) => id !== who);
    if (next.length) line.reactions[emoji] = next;
    else delete line.reactions[emoji];
    return true;
  }

  touched() {
    this.lastActivity = Date.now();
    this.scheduleHistory();
  }

  scheduleHistory() {
    if (this.phase === 'joined') this.debounce('history-soon', () => this.isHost() && this.publishHistory(), this.t.debounce);
  }

  publishHistory() {
    const record = { lines: fitLines(this.lines.slice(-LIMITS.history), HISTORY_BYTES), updatedAt: Date.now() };
    return this.cipher
      .seal(record, 'h')
      .then((payload) => this.hub.publish(this.topics.history, payload, { retain: true }))
      .catch(report);
  }

  publishMeta() {
    this.cipher
      .seal(this.meta, 'm')
      .then((payload) => this.hub.publish(this.topics.meta, payload, { retain: true }))
      .catch(report);
  }

  directoryTopic() {
    return `${this.prefix}d/${this.roomId}`;
  }

  directoryEntry(people = this.members.size + 1) {
    const { id, name, topic, createdAt } = this.meta;
    const members = people ? this.present().slice(0, 5).map(({ name, color }) => ({ name, color })) : [];
    return { id, name, topic, createdAt, lastActivity: this.lastActivity, people, members, seenAt: Date.now() };
  }

  scheduleDirectory() {
    if (this.phase !== 'joined' || !this.meta?.isPublic) return;
    this.debounce('directory-soon', () => this.isHost() && this.publishDirectory(), this.t.debounce);
  }

  publishDirectory() {
    if (this.meta?.isPublic) this.hub.publish(this.directoryTopic(), JSON.stringify(this.directoryEntry()), { retain: true });
  }

  // --------------------------------------------------------------- timers

  later(name, fn, ms) {
    clearTimeout(this.timers.get(name));
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms)
    );
  }

  debounce(name, fn, ms) {
    if (!this.timers.has(name)) this.later(name, fn, ms);
  }

  every(name, fn, ms) {
    this.timers.set(name, setInterval(fn, ms));
  }

  cancel(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }
}
