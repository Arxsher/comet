// Talks to the Comet server when there is one. On a static host (GitHub Pages,
// Netlify, `npx serve`…) it falls back to "local mode": rooms live in
// localStorage and sync between tabs of the same browser.

import { store } from './util.js';
import { roomSlug } from './identity.js';

/** Set this to e.g. "https://comet.example.com" to use a server on another origin. */
export const SERVER_ORIGIN = document.querySelector('meta[name="comet-server"]')?.content?.replace(/\/$/, '') || '';

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
export function getMode() {
  modePromise ||= (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res = await fetch(`${SERVER_ORIGIN}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const body = res.ok ? await res.json() : null;
      return body?.ok ? 'server' : 'local';
    } catch {
      return 'local';
    }
  })();
  return modePromise;
}

export function wsUrl() {
  const origin = SERVER_ORIGIN || location.origin;
  return origin.replace(/^http/, 'ws') + '/ws';
}

export function shareUrl(id, mode) {
  if (mode === 'server') return `${SERVER_ORIGIN || location.origin}/r/${id}`;
  return new URL(`room.html?r=${encodeURIComponent(id)}`, location.href).href;
}

export const roomHref = (id) => `room.html?r=${encodeURIComponent(id)}`;
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
  if ((await getMode()) === 'server') return (await request('/api/rooms')).rooms;
  return local.list();
}

export async function getStats() {
  if ((await getMode()) === 'server') return request('/api/stats');
  const rooms = local.list();
  const people = rooms.reduce((n, r) => n + r.people, 0);
  return { people, liveRooms: rooms.filter((r) => r.people).length, rooms: rooms.length };
}

export async function getRoom(id) {
  if (!isValidRoomId(id)) return null;
  if ((await getMode()) === 'server') {
    try {
      return (await request(`/api/rooms/${id}`)).room;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  return local.get(id);
}

export async function createRoom({ id, name, topic, isPublic }) {
  if ((await getMode()) === 'server') {
    return (await request('/api/rooms', { method: 'POST', body: JSON.stringify({ id, name, topic, isPublic }) })).room;
  }
  return local.create({ id, name, topic, isPublic });
}

// ------------------------------------------------------------- local mode

export const local = {
  rooms() {
    let rooms = store.get('comet:local:rooms');
    if (!rooms) {
      rooms = {};
      const now = Date.now();
      for (const r of SEED_ROOMS) rooms[r.id] = { ...r, isPublic: true, createdAt: now, lastActivity: now - 1 };
      store.set('comet:local:rooms', rooms);
    }
    return rooms;
  },
  presence(id) {
    const all = store.get(`comet:local:presence:${id}`, {});
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
    store.set('comet:local:rooms', rooms);
    return this.summary(room);
  },
  touch(id) {
    const rooms = this.rooms();
    if (rooms[id]) {
      rooms[id].lastActivity = Date.now();
      store.set('comet:local:rooms', rooms);
    }
  },
};
