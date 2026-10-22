// Talks to the Midsentence server when there is one. On a static host (Vercel,
// GitHub Pages, Netlify, `npx serve`…) it switches to "relay mode": rooms run
// over free public MQTT brokers, end-to-end encrypted (see relay.js). "Local
// mode" (rooms sync between tabs of one browser) is only used when relay mode
// is turned off with <meta name="midsentence-relay" content="off">.

import { store } from './util.js';
import { roomSlug } from './identity.js';
import { DEFAULT_RELAYS, RelayDirectory, RelayHub, createRelayRoom, getRelayRoom } from './relay.js';

/** Set this to e.g. "https://chat.example.com" to use a server on another origin. */
export const SERVER_ORIGIN = document.querySelector('meta[name="midsentence-server"]')?.content?.replace(/\/$/, '') || '';

export const SEED_ROOMS = [
  { id: 'lobby', name: 'The Lobby', topic: 'Say hi. Everyone passes through here.' },
  { id: 'late-night', name: 'Late Night Thoughts', topic: 'For the 2am ideas that can’t wait.' },
  { id: 'design-crit', name: 'Design Crit', topic: 'Show your work, get honest feedback.' },
  { id: 'code-and-coffee', name: 'Code & Coffee', topic: 'Bugs, builds and brews.' },
  { id: 'now-playing', name: 'Now Playing', topic: 'What’s in your headphones right now?' },
];

const PRESENCE_TTL = 9000;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;

let modePromise;
/** 'server' when a Midsentence server answers, else 'relay' (or 'local' if relay is turned off). */
export function getMode() {
  modePromise ||= (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res = await fetch(`${SERVER_ORIGIN}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const body = res.ok ? await res.json() : null;
      if (body?.ok) return 'server';
    } catch {}
    return relayUrls().length ? 'relay' : 'local';
  })();
  return modePromise;
}

/**
 * Broker URLs for relay mode, from (in order) localStorage['midsentence:relay'],
 * <meta name="midsentence-relay">, or the defaults. Comma-separated; "off" disables relay mode.
 */
export function relayUrls() {
  let raw = null;
  try {
    raw = localStorage.getItem('midsentence:relay');
  } catch {}
  if (!raw?.trim()) raw = document.querySelector('meta[name="midsentence-relay"]')?.content || '';
  if (raw.trim().toLowerCase() === 'off') return [];
  const urls = raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^wss?:\/\//i.test(url));
  return urls.length ? urls : DEFAULT_RELAYS;
}

let hub;
let directory;
/** The page's one connection to the relay brokers, shared by lookups, the room list and the room. */
export const relayHub = () => (hub ||= new RelayHub({ urls: relayUrls() }));
const relayDirectory = () => (directory ||= new RelayDirectory(relayHub(), { seeds: SEED_ROOMS }));

export function wsUrl() {
  const origin = SERVER_ORIGIN || location.origin;
  return origin.replace(/^http/, 'ws') + '/ws';
}

/**
 * Links to link-only relay rooms carry the id in the #fragment: there the id is
 * the encryption key, and fragments never reach the web server's logs.
 */
export function shareUrl(id, mode, { secret = false } = {}) {
  if (mode === 'server') return `${SERVER_ORIGIN || location.origin}/r/${id}`;
  return new URL(roomHref(id, { secret }), location.href).href;
}

export const roomHref = (id, { secret = false } = {}) => (secret ? `room.html#${encodeURIComponent(id)}` : `room.html?r=${encodeURIComponent(id)}`);
export const isValidRoomId = (id) => typeof id === 'string' && ID_RE.test(id);

async function request(path, options = {}) {
  const res = await fetch(`${SERVER_ORIGIN}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Request failed'), { status: res.status, code: body.code });
  return body;
}

// ------------------------------------------------------------------ public

export async function listRooms() {
  const mode = await getMode();
  if (mode === 'server') return (await request('/api/rooms')).rooms;
  if (mode === 'relay') {
    await relayDirectory().ready();
    return relayDirectory().rooms();
  }
  return local.list();
}

export async function getStats() {
  const mode = await getMode();
  if (mode === 'server') return request('/api/stats');
  if (mode === 'relay') {
    await relayDirectory().ready();
    return relayDirectory().stats();
  }
  const rooms = local.list();
  const people = rooms.reduce((n, r) => n + r.people, 0);
  return { people, liveRooms: rooms.filter((r) => r.people).length, rooms: rooms.length };
}

export async function getRoom(id) {
  if (!isValidRoomId(id)) return null;
  const mode = await getMode();
  if (mode === 'server') {
    try {
      return (await request(`/api/rooms/${id}`)).room;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  if (mode === 'relay') return getRelayRoom(relayHub(), id, { seeds: SEED_ROOMS, directory: relayDirectory() });
  return local.get(id);
}

export async function createRoom({ id, name, topic, isPublic }) {
  const mode = await getMode();
  if (mode === 'server') {
    return (await request('/api/rooms', { method: 'POST', body: JSON.stringify({ id, name, topic, isPublic }) })).room;
  }
  // Relay mode gives link-only rooms a long random id: there, the id is the encryption key.
  if (mode === 'relay') return createRelayRoom(relayHub(), { id, name, topic, isPublic, seeds: SEED_ROOMS });
  return local.create({ id, name, topic, isPublic });
}

/**
 * Calls callback(rooms) with the public room list as soon as it's known and
 * again whenever it changes. Relay mode pushes updates; the server and local
 * modes poll every 8s while the page is visible. Returns unsubscribe().
 */
export function watchRooms(callback) {
  let stopped = false;
  let stop = () => {};
  getMode().then((mode) => {
    if (stopped) return;
    if (mode === 'relay') {
      stop = relayDirectory().watch(callback);
      return;
    }
    let last = null;
    const refresh = async () => {
      try {
        const rooms = await listRooms();
        const key = JSON.stringify(rooms);
        if (!stopped && key !== last) {
          last = key;
          callback(rooms);
        }
      } catch {}
    };
    const poll = () => document.visibilityState === 'visible' && refresh();
    const timer = setInterval(poll, 8000);
    document.addEventListener('visibilitychange', poll);
    refresh();
    stop = () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  });
  return () => {
    stopped = true;
    stop();
  };
}

// ------------------------------------------------------------- local mode

export const local = {
  rooms() {
    let rooms = store.get('midsentence:local:rooms');
    if (!rooms) {
      rooms = {};
      const now = Date.now();
      for (const r of SEED_ROOMS) rooms[r.id] = { ...r, isPublic: true, createdAt: now, lastActivity: now - 1 };
      store.set('midsentence:local:rooms', rooms);
    }
    return rooms;
  },
  presence(id) {
    const all = store.get(`midsentence:local:presence:${id}`, {});
    const now = Date.now();
    return Object.entries(all)
      .filter(([, m]) => now - m.ts < PRESENCE_TTL)
      .map(([memberId, m]) => ({ id: memberId, ...m }));
  },
  summary(room) {
    const members = this.presence(room.id);
    return { ...room, people: members.length, members: members.slice(0, 5).map(({ name, color }) => ({ name, color })) };
  },
  list() {
    return Object.values(this.rooms())
      .filter((r) => r.isPublic)
      .map((r) => this.summary(r))
      .sort((a, b) => b.people - a.people || b.lastActivity - a.lastActivity);
  },
  get(id) {
    const room = this.rooms()[id];
    return room ? this.summary(room) : null;
  },
  create({ id, name, topic, isPublic = true }) {
    const rooms = this.rooms();
    if (id && rooms[id]) throw Object.assign(new Error('That room already exists.'), { code: 'exists' });
    const room = {
      id: id || roomSlug(),
      name: (name || '').trim().slice(0, 48) || 'Untitled room',
      topic: (topic || '').trim().slice(0, 90),
      isPublic: isPublic !== false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    rooms[room.id] = room;
    store.set('midsentence:local:rooms', rooms);
    return this.summary(room);
  },
  touch(id) {
    const rooms = this.rooms();
    if (rooms[id]) {
      rooms[id].lastActivity = Date.now();
      store.set('midsentence:local:rooms', rooms);
    }
  },
};
