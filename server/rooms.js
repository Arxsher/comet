// In-memory room state. Rooms are ephemeral: nothing touches disk, and a
// room without people is swept after EMPTY_TTL_MS (seeded rooms stay open).

import { randomBytes } from 'node:crypto';

export const LIMITS = {
  text: 500,
  name: 32,
  roomName: 48,
  topic: 90,
  lines: 300,
  membersPerRoom: 50,
  rooms: 2000,
};

export const REACTIONS = ['👍', '❤️', '😂', '🔥', '👀', '✨'];

const EMPTY_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const ADJECTIVES = ['quiet', 'amber', 'lunar', 'swift', 'velvet', 'cosmic', 'brave', 'misty', 'golden', 'electric', 'gentle', 'wild', 'neon', 'silver', 'sunny', 'hidden'];
const NOUNS = ['otter', 'spark', 'harbor', 'falcon', 'meadow', 'lantern', 'orbit', 'maple', 'tiger', 'river', 'pixel', 'cloud', 'ember', 'canyon', 'koala', 'nova'];

const SEED = [
  { id: 'lobby', name: 'The Lobby', topic: 'Say hi. Everyone passes through here.' },
  { id: 'late-night', name: 'Late Night Thoughts', topic: 'For the 2am ideas that can’t wait.' },
  { id: 'design-crit', name: 'Design Crit', topic: 'Show your work, get honest feedback.' },
  { id: 'code-and-coffee', name: 'Code & Coffee', topic: 'Bugs, builds and brews.' },
  { id: 'now-playing', name: 'Now Playing', topic: 'What’s in your headphones right now?' },
];

const pick = (list) => list[randomBytes(1)[0] % list.length];
const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export const isValidRoomId = (id) => typeof id === 'string' && ID_RE.test(id);

export function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, LIMITS.text);
}

export function cleanMember(input = {}) {
  return {
    name: clean(input.name, LIMITS.name) || 'Anonymous',
    color: COLOR_RE.test(input.color) ? input.color.toLowerCase() : '#ff3932',
  };
}

export class RoomStore {
  constructor({ seed = true, now = Date.now } = {}) {
    this.rooms = new Map();
    this.now = now;
    if (seed) for (const room of SEED) this.create({ ...room, isPublic: true, permanent: true });
  }

  slug() {
    for (let i = 0; i < 20; i++) {
      const id = `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(2).toString('hex').slice(0, 3)}`;
      if (!this.rooms.has(id)) return id;
    }
    return randomBytes(6).toString('hex');
  }

  create({ id, name, topic, isPublic = true, permanent = false } = {}) {
    if (this.rooms.size >= LIMITS.rooms) throw new RoomError('capacity', 'Too many rooms are open right now.');
    if (id !== undefined && !isValidRoomId(id)) throw new RoomError('bad_id', 'Room links can only use a–z, 0–9 and dashes.');
    if (id && this.rooms.has(id)) throw new RoomError('exists', 'That room already exists.');
    const room = {
      id: id || this.slug(),
      name: clean(name, LIMITS.roomName) || 'Untitled room',
      topic: clean(topic, LIMITS.topic),
      isPublic: Boolean(isPublic),
      permanent,
      createdAt: this.now(),
      lastActivity: this.now(),
      emptySince: this.now(),
      members: new Map(),
      lines: [],
    };
    this.rooms.set(room.id, room);
    return room;
  }

  get(id) {
    return this.rooms.get(id);
  }

  join(room, id, profile) {
    const existing = room.members.get(id);
    if (!existing && room.members.size >= LIMITS.membersPerRoom) {
      throw new RoomError('full', 'This room is full.');
    }
    const member = existing || { id, text: '', caret: 0, away: false, joinedAt: this.now() };
    Object.assign(member, cleanMember(profile), { typedAt: member.typedAt || 0 });
    room.members.set(id, member);
    room.emptySince = null;
    room.lastActivity = this.now();
    return { member, rejoined: Boolean(existing) };
  }

  leave(room, id) {
    const removed = room.members.delete(id);
    if (room.members.size === 0) room.emptySince = this.now();
    return removed;
  }

  type(room, member, text, caret) {
    member.text = cleanText(text);
    member.caret = Number.isInteger(caret) ? Math.max(0, Math.min(caret, member.text.length)) : member.text.length;
    member.typedAt = this.now();
    room.lastActivity = this.now();
  }

  commit(room, member, text) {
    const body = cleanText(text).trim();
    member.text = '';
    member.caret = 0;
    if (!body) return null;
    const line = {
      id: randomBytes(6).toString('hex'),
      author: { id: member.id, name: member.name, color: member.color },
      text: body,
      ts: this.now(),
      reactions: {},
    };
    room.lines.push(line);
    if (room.lines.length > LIMITS.lines) room.lines.splice(0, room.lines.length - LIMITS.lines);
    room.lastActivity = this.now();
    return line;
  }

  react(room, memberId, lineId, emoji) {
    if (!REACTIONS.includes(emoji)) return null;
    const line = room.lines.find((l) => l.id === lineId);
    if (!line) return null;
    const who = new Set(line.reactions[emoji] || []);
    who.has(memberId) ? who.delete(memberId) : who.add(memberId);
    if (who.size) line.reactions[emoji] = [...who];
    else delete line.reactions[emoji];
    return line;
  }

  sweep() {
    const cutoff = this.now() - EMPTY_TTL_MS;
    for (const [id, room] of this.rooms) {
      if (room.permanent || room.members.size) continue;
      if (room.emptySince && room.emptySince < cutoff) this.rooms.delete(id);
    }
    // Seeded rooms keep a short memory once everyone is gone.
    for (const room of this.rooms.values()) {
      if (room.permanent && !room.members.size && room.emptySince && room.emptySince < cutoff) room.lines = [];
    }
  }

  stats() {
    let people = 0;
    let live = 0;
    for (const room of this.rooms.values()) {
      people += room.members.size;
      if (room.members.size) live++;
    }
    return { people, liveRooms: live, rooms: this.rooms.size };
  }

  list() {
    return [...this.rooms.values()]
      .filter((room) => room.isPublic)
      .sort((a, b) => b.members.size - a.members.size || b.lastActivity - a.lastActivity)
      .slice(0, 60)
      .map((room) => this.summary(room));
  }

  summary(room) {
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      isPublic: room.isPublic,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity,
      people: room.members.size,
      members: [...room.members.values()].slice(0, 5).map(({ name, color }) => ({ name, color })),
    };
  }

  snapshot(room) {
    return {
      room: this.summary(room),
      members: [...room.members.values()].map(publicMember),
      lines: room.lines,
    };
  }
}

export function publicMember(m) {
  return { id: m.id, name: m.name, color: m.color, text: m.text, caret: m.caret, away: m.away, joinedAt: m.joinedAt, typedAt: m.typedAt };
}

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
