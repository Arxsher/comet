// Relay mode against two local MQTT brokers (aedes over WebSockets), using
// Node's global WebSocket and WebCrypto — the same code the browser runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { Aedes } from 'aedes';
import { MqttClient, PacketReader, encodeLength } from '../public/js/lib/mqtt.js';
import {
  RELAY_PREFIX,
  RelayDirectory,
  RelayHub,
  RelayRoom,
  createRelayRoom,
  getRelayRoom,
  isValidRoomId,
  roomCrypto,
  roomTopics,
} from '../public/js/lib/relay.js';

const SEEDS = [
  { id: 'lobby', name: 'The Lobby', topic: 'Say hi.' },
  { id: 'late-night', name: 'Late Night Thoughts', topic: '2am ideas.' },
];
const FAST = { debounce: 150 };

let one;
let two;
const cleanup = [];

async function startBroker() {
  const broker = await Aedes.createBroker();
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    const stream = createWebSocketStream(socket);
    stream.on('error', () => {});
    broker.handle(stream);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => broker.close(resolve));
    },
  };
}

before(async () => {
  [one, two] = await Promise.all([startBroker(), startBroker()]);
});

after(async () => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  await Promise.all([one.close(), two.close()]);
});

/** Resolves once check() is truthy (polling), or rejects after `ms`. */
async function until(check, ms = 5000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function hub(urls) {
  const h = new RelayHub({ urls });
  cleanup.push(() => h.close());
  return h;
}

async function mqtt(url, options) {
  const client = new MqttClient(url, options);
  const inbox = [];
  client.onmessage = (topic, payload, info) => inbox.push({ topic, payload, retain: info.retain, text: new TextDecoder().decode(payload) });
  await client.connect();
  cleanup.push(() => client.end());
  const message = (match) => until(() => inbox.find(match), 5000, 'mqtt message');
  return { client, inbox, message };
}

const EVENTS = ['status', 'welcome', 'join', 'leave', 'profile', 'type', 'line', 'react', 'error', 'replaced'];

/** A RelayRoom on its own hub (one per simulated browser), recording every event. */
function person(urls, roomId, me, options = {}) {
  const log = [];
  const on = Object.fromEntries(EVENTS.map((type) => [type, (payload) => log.push({ type, payload })]));
  const h = new RelayHub({ urls });
  const room = new RelayRoom({ roomId, me, on, hub: h, seeds: SEEDS, timing: FAST, ...options });
  cleanup.push(() => {
    room.close();
    h.close();
  });
  const find = (type, match = () => true) => log.find((e) => e.type === type && match(e.payload))?.payload;
  return {
    hub: h,
    room,
    log,
    wait: (type, match, ms = 5000) => until(() => find(type, match), ms, `${me.name}: ${type}`),
    count: (type, match = () => true) => log.filter((e) => e.type === type && match(e.payload)).length,
    async leave() {
      await room.close();
      h.close();
    },
  };
}

// ---------------------------------------------------------------- mqtt.js

test('mqtt: remaining length encoding and packet framing', () => {
  const cases = [
    [0, [0]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [2_097_152, [0x80, 0x80, 0x80, 0x01]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [n, bytes] of cases) assert.deepEqual([...encodeLength(n)], bytes, `length ${n}`);
  assert.throws(() => encodeLength(268_435_456));

  // Two packets, the second one big enough for a two-byte length.
  const payload = new Uint8Array(300).fill(9);
  const publish = [0x30, ...encodeLength(4 + payload.length), 0, 2, 0x61, 0x2f, ...payload];
  const stream = Uint8Array.from([0xd0, 0x00, ...publish]);

  const whole = new PacketReader().push(stream);
  assert.deepEqual(whole.map((p) => p.type), [13, 3]);
  assert.equal(whole[1].body.length, 304);

  // Same bytes split at awkward places, including inside the length field.
  const reader = new PacketReader();
  const got = [];
  for (const [from, to] of [[0, 1], [1, 3], [3, 4], [4, 100], [100, stream.length]]) got.push(...reader.push(stream.subarray(from, to)));
  assert.deepEqual(got.map((p) => [p.type, p.body.length]), [[13, 0], [3, 304]]);

  // Oversized packets are skipped without buffering them.
  const small = new PacketReader(100);
  assert.deepEqual(small.push(stream.subarray(0, 50)).map((p) => p.type), [13]);
  assert.deepEqual(small.push(Uint8Array.from([...stream.subarray(50), 0xd0, 0x00])).map((p) => p.type), [13]);

  assert.throws(() => new PacketReader().push(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01)), /Malformed/);
});

test('mqtt: publish, subscribe, retained messages and last will', async () => {
  const watcher = await mqtt(one.url);
  await watcher.client.subscribe('t/#');

  const speaker = await mqtt(one.url, { will: { topic: 't/will', payload: 'gone' } });
  speaker.client.publish('t/hello', 'hi there');
  const hello = await watcher.message((m) => m.topic === 't/hello');
  assert.equal(hello.text, 'hi there');
  assert.equal(hello.retain, false);

  // A payload big enough for a three-byte remaining length.
  speaker.client.publish('t/big', new Uint8Array(200_000).fill(7));
  const big = await watcher.message((m) => m.topic === 't/big');
  assert.equal(big.payload.length, 200_000);
  assert.ok(big.payload.every((b) => b === 7));

  speaker.client.publish('t/kept', Uint8Array.of(1, 2, 3), { retain: true });
  await watcher.message((m) => m.topic === 't/kept');
  const late = await mqtt(one.url);
  await late.client.subscribe('t/kept');
  const kept = await late.message((m) => m.topic === 't/kept');
  assert.deepEqual([...kept.payload], [1, 2, 3]);
  assert.equal(kept.retain, true);

  await late.client.unsubscribe('t/kept');
  speaker.client.publish('t/kept', new Uint8Array(0), { retain: true }); // clears it
  await watcher.message((m) => m.topic === 't/kept' && m.payload.length === 0);

  // Dropping the socket without DISCONNECT makes the broker publish the will…
  speaker.client.destroy();
  const will = await watcher.message((m) => m.topic === 't/will');
  assert.equal(will.text, 'gone');

  // …and a graceful end() doesn't.
  const polite = await mqtt(one.url, { will: { topic: 't/will2', payload: 'x' } });
  polite.client.end();
  watcher.client.publish('t/after', 'marker');
  await watcher.message((m) => m.topic === 't/after');
  assert.ok(!watcher.inbox.some((m) => m.topic === 't/will2'));

  await assert.rejects(new MqttClient('ws://127.0.0.1:1', { connectTimeout: 1000 }).connect());
});

// --------------------------------------------------------------- relay.js

test('relay: two people live in one room, across two brokers', async () => {
  const urls = [one.url, two.url];
  const creator = hub(urls);
  const created = await createRelayRoom(creator, { name: 'Test  Room', topic: 'testing', isPublic: true, seeds: SEEDS });
  assert.ok(isValidRoomId(created.id));
  assert.match(created.id, /^[a-z]+-[a-z]+-[a-z0-9]{3}$/, 'public rooms keep short slugs');
  assert.equal(created.name, 'Test Room');

  const directory = new RelayDirectory(hub(urls), { seeds: SEEDS });
  cleanup.push(() => directory.close());
  await directory.ready();
  assert.equal(directory.lookup(created.id)?.name, 'Test Room', 'public rooms are listed');

  const ada = person(urls, created.id, { id: 'aaaaaaaa', name: 'Ada', color: '#ff7a59' });
  const welcomeA = await ada.wait('welcome');
  assert.equal(welcomeA.you, 'aaaaaaaa');
  assert.equal(welcomeA.room.name, 'Test Room');
  assert.deepEqual(welcomeA.members.map((m) => m.name), ['Ada']);
  assert.deepEqual(welcomeA.lines, []);
  assert.equal(ada.log.find((e) => e.type === 'status').payload, 'connecting');
  await ada.wait('status', (s) => s === 'live');

  const bo = person(urls, created.id, { id: 'bbbbbbbb', name: 'Bo', color: '#3dd68c' });
  const welcomeB = await bo.wait('welcome');
  assert.deepEqual(welcomeB.members.map((m) => m.name).sort(), ['Ada', 'Bo']);
  assert.equal(welcomeB.room.people, 2);
  const joined = await ada.wait('join', (p) => p.member.id === 'bbbbbbbb');
  assert.equal(joined.member.name, 'Bo');
  assert.equal(joined.quiet, false, 'a new arrival is announced');

  // Keystrokes: throttled, but the latest value always arrives, with the caret.
  ada.room.type('h', 1);
  ada.room.type('he', 2);
  ada.room.type('hel', 3);
  const typed = await bo.wait('type', (p) => p.text === 'hel');
  assert.deepEqual(typed, { id: 'aaaaaaaa', text: 'hel', caret: 3 });

  // Committing: the author gets the nonce back, everyone gets the line, and the draft clears.
  ada.room.commit('hello world', 'n1');
  const mine = await ada.wait('line', (p) => p.nonce === 'n1');
  const theirs = await bo.wait('line', (p) => p.line.text === 'hello world');
  assert.equal(mine.line.id, theirs.line.id);
  assert.deepEqual(theirs.line.author, { id: 'aaaaaaaa', name: 'Ada', color: '#ff7a59' });
  await bo.wait('type', (p) => p.id === 'aaaaaaaa' && p.text === '');

  // Reactions toggle, and both sides agree on the full map.
  bo.room.react(theirs.line.id, '🔥');
  await ada.wait('react', (p) => p.line === mine.line.id && p.reactions['🔥']?.[0] === 'bbbbbbbb');
  bo.room.react(theirs.line.id, '🔥');
  await ada.wait('react', (p) => p.line === mine.line.id && !p.reactions['🔥']);
  ada.room.react(mine.line.id, '✨');
  await bo.wait('react', (p) => p.reactions['✨']?.[0] === 'aaaaaaaa');

  // Every message reached each side via both brokers; none shows up twice.
  bo.room.commit('marker', 'n2');
  await ada.wait('line', (p) => p.line.text === 'marker');
  assert.equal(bo.count('line', (p) => p.line.text === 'hello world'), 1);
  assert.equal(ada.count('join'), 1);
  assert.equal(bo.count('join'), 0, 'members already here come in the welcome, not as joins');
  assert.equal(ada.count('type', (p) => p.id === 'aaaaaaaa'), 0, 'your own keystrokes are not echoed back');

  // A late joiner who shares only one broker with them gets the transcript and everyone in it.
  const cy = person([two.url], created.id, { id: 'cccccccc', name: 'Cy', color: '#4cb2ff' });
  const welcomeC = await cy.wait('welcome');
  assert.deepEqual(welcomeC.members.map((m) => m.name).sort(), ['Ada', 'Bo', 'Cy']);
  assert.deepEqual(welcomeC.lines.map((l) => l.text), ['hello world', 'marker']);
  assert.deepEqual(welcomeC.lines[0].reactions, { '✨': ['aaaaaaaa'] });
  await ada.wait('join', (p) => p.member.id === 'cccccccc');
  await bo.wait('join', (p) => p.member.id === 'cccccccc');

  bo.room.profile({ name: 'Bobby' });
  await ada.wait('profile', (p) => p.member.id === 'bbbbbbbb' && p.member.name === 'Bobby');
  await cy.wait('profile', (p) => p.member.name === 'Bobby');
  cy.room.away(true);
  await ada.wait('profile', (p) => p.member.id === 'cccccccc' && p.member.away === true);

  // The host keeps the public directory entry current.
  const current = () => directory.lookup(created.id);
  await until(() => current()?.people === 3 && current().members.some((m) => m.name === 'Bobby'), 5000, 'directory: 3 people');
  assert.deepEqual(directory.lookup(created.id).members.map((m) => m.name).sort(), ['Ada', 'Bobby', 'Cy']);
  assert.equal(directory.stats().people >= 3, true);

  // Leaving politely says bye…
  await bo.leave();
  await ada.wait('leave', (p) => p.id === 'bbbbbbbb');
  await cy.wait('leave', (p) => p.id === 'bbbbbbbb');

  // …and a crash (no DISCONNECT) is announced by the last will.
  cy.hub.close({ graceful: false });
  await ada.wait('leave', (p) => p.id === 'cccccccc');
  await cy.room.close();

  // The last one out leaves the history behind (for ten minutes) and marks the room empty.
  ada.room.commit('anyone there?', 'n3');
  await ada.wait('line', (p) => p.nonce === 'n3');
  await ada.leave();
  await until(() => directory.lookup(created.id)?.people === 0, 5000, 'directory: empty');

  const dee = person([one.url], created.id, { id: 'dddddddd', name: 'Dee', color: '#9a8cff' });
  const welcomeD = await dee.wait('welcome');
  assert.deepEqual(welcomeD.members.map((m) => m.name), ['Dee']);
  assert.deepEqual(welcomeD.lines.map((l) => l.text), ['hello world', 'marker', 'anyone there?']);
  await dee.leave();

  // Once a room has sat empty long enough it dissolves: history is gone, for good.
  const eve = person([one.url, two.url], created.id, { id: 'eeeeeeee', name: 'Eve', color: '#9a8cff' }, { timing: { ...FAST, dissolve: 1 } });
  assert.deepEqual((await eve.wait('welcome')).lines, []);
  await eve.leave();
  const fay = person([two.url], created.id, { id: 'ffffffff', name: 'Fay', color: '#9a8cff' });
  assert.deepEqual((await fay.wait('welcome')).lines, []);
  await fay.leave();
});

test('relay: link-only rooms are unlisted and unreadable without the id', async () => {
  const owner = hub([one.url]);
  const created = await createRelayRoom(owner, { name: 'Secret plans', topic: 'shh', isPublic: false, seeds: SEEDS });
  assert.ok(isValidRoomId(created.id));
  assert.match(created.id, /^[a-z]+-[a-z]+-[a-z0-9]{16}$/, 'a long random id: it is the key');
  assert.equal(created.isPublic, false);

  // Another browser finds it by id (no shared cache), but not by a near miss.
  const visitor = hub([two.url, one.url]);
  const found = await getRelayRoom(visitor, created.id, { seeds: SEEDS });
  assert.equal(found.name, 'Secret plans');
  assert.equal(found.people, 0);
  const wrongId = created.id.slice(0, -1) + (created.id.endsWith('a') ? 'b' : 'a');
  assert.equal(await getRelayRoom(visitor, wrongId, { seeds: SEEDS }), null);
  await assert.rejects(createRelayRoom(visitor, { id: created.id, name: 'Again' }), { code: 'exists' });

  const directory = new RelayDirectory(visitor, { seeds: SEEDS });
  cleanup.push(() => directory.close());
  await directory.ready();
  assert.equal(directory.lookup(created.id), null, 'link-only rooms are not listed');

  // What the broker holds is ciphertext: only the right room id opens it.
  const right = await roomCrypto(created.id);
  const raw = await mqtt(one.url);
  await raw.client.subscribe(roomTopics(right.topicKey).meta);
  const stored = await raw.message(() => true);
  assert.ok(!stored.text.includes('Secret plans'));
  assert.equal((await right.open(stored.payload, 'm')).name, 'Secret plans');
  assert.equal(await (await roomCrypto(wrongId)).open(stored.payload, 'm'), null);
  assert.equal(await right.open(stored.payload, 'r'), null, 'a payload is bound to its channel');
  assert.notEqual((await roomCrypto(wrongId)).topicKey, right.topicKey);

  // People in the room show up to a lobby visitor's peek.
  const pat = person([one.url], created.id, { id: 'pppppppp', name: 'Pat', color: '#ffbe3d' });
  await pat.wait('welcome');
  const peeked = await getRelayRoom(visitor, created.id, { seeds: SEEDS });
  assert.equal(peeked.people, 1);
  assert.deepEqual(peeked.members, [{ name: 'Pat', color: '#ffbe3d' }]);

  // An eavesdropper on the room channel sees nothing it can read.
  const tap = await mqtt(one.url);
  await tap.client.subscribe(roomTopics(right.topicKey).room);
  pat.room.type('top secret', 10);
  const sniffed = await until(async () => {
    for (const m of tap.inbox) if ((await right.open(m.payload, 'r'))?.text === 'top secret') return m;
  }, 5000, 'sniffed keystroke');
  assert.ok(!sniffed.text.includes('top secret'));
  assert.equal(await (await roomCrypto(wrongId)).open(sniffed.payload, 'r'), null);
  await pat.leave();
});

test('relay: unknown rooms, seeded rooms and an unreachable relay', async () => {
  const urls = [one.url, two.url];
  const ghost = person(urls, 'no-such-room-here', { id: 'gggggggg', name: 'Gus', color: '#ff7eb6' });
  const err = await ghost.wait('error');
  assert.equal(err.code, 'not_found');
  assert.equal(ghost.count('welcome'), 0);
  await ghost.leave();

  // Seeded rooms always exist, even before anyone has been in them.
  const lobby = person(urls, 'lobby', { id: 'llllllll', name: 'Lou', color: '#2ec4c6' });
  const welcome = await lobby.wait('welcome');
  assert.equal(welcome.room.name, 'The Lobby');
  await lobby.leave();

  const offline = hub(['ws://127.0.0.1:1']);
  const seed = await getRelayRoom(offline, 'late-night', { seeds: SEEDS });
  assert.equal(seed.name, 'Late Night Thoughts');
  await assert.rejects(getRelayRoom(offline, 'quiet-otter-abc', { seeds: SEEDS, timeout: 300 }), { code: 'offline' });
  assert.equal(offline.status, 'connecting');
  offline.close();
});

test('relay: the directory keeps only sane, fresh entries', async () => {
  const urls = [one.url];
  const writer = await mqtt(one.url);
  const now = Date.now();
  const put = (id, entry) => writer.client.publish(`${RELAY_PREFIX}d/${id}`, typeof entry === 'string' ? entry : JSON.stringify(entry), { retain: true });
  const base = { name: 'Room', topic: '', createdAt: now, lastActivity: now, people: 2, members: [{ name: 'A', color: '#3dd68c' }, { name: 'B', color: 'red' }], seenAt: now };

  put('dir-fresh', { ...base, id: 'dir-fresh', name: 'Fresh\u0000‮ room' + 'x'.repeat(100) });
  put('dir-stale', { ...base, id: 'dir-stale', people: 5, seenAt: now - 120_000, lastActivity: now - 120_000 });
  put('dir-ancient', { ...base, id: 'dir-ancient', seenAt: now - 8 * 86_400_000, lastActivity: now - 8 * 86_400_000 });
  put('dir-junk', 'not json');
  put('dir-mismatch', { ...base, id: 'something-else' });
  put('dir-future', { ...base, id: 'dir-future', seenAt: now + 3_600_000 });
  put('lobby', { ...base, id: 'lobby', name: 'Spoofed lobby', people: 3, members: [] });

  const directory = new RelayDirectory(hub(urls), { seeds: SEEDS });
  cleanup.push(() => directory.close());
  const seen = [];
  const stop = directory.watch((rooms) => seen.push(rooms));
  await until(() => seen.length, 5000, 'directory watch');
  await until(() => directory.lookup('dir-fresh'), 5000, 'fresh entry');

  const rooms = directory.rooms();
  const ids = rooms.map((r) => r.id);
  assert.ok(ids.includes('lobby') && ids.includes('late-night'), 'seeded rooms are always listed');
  assert.ok(!ids.includes('dir-ancient') && !ids.includes('dir-junk') && !ids.includes('dir-mismatch') && !ids.includes('dir-future'));

  const fresh = directory.lookup('dir-fresh');
  assert.equal(fresh.people, 2);
  assert.equal(fresh.name.length, 48);
  assert.ok(!/[\u0000‮]/.test(fresh.name));
  assert.deepEqual(fresh.members, [{ name: 'A', color: '#3dd68c' }, { name: 'B', color: '#ff7a59' }]);
  assert.deepEqual(Object.keys(fresh).sort(), ['createdAt', 'id', 'isPublic', 'lastActivity', 'members', 'name', 'people', 'topic']);

  const stale = directory.lookup('dir-stale');
  assert.equal(stale.people, 0, 'nobody has vouched for it lately');
  assert.deepEqual(stale.members, []);

  const lobby = directory.lookup('lobby');
  assert.equal(lobby.name, 'The Lobby', 'seed names cannot be overwritten');
  assert.equal(lobby.people, 3);
  assert.equal(rooms[0].id, 'lobby', 'busiest first');

  // Pushes changes to watchers.
  put('dir-fresh', { ...base, id: 'dir-fresh', people: 4, seenAt: Date.now() });
  await until(() => seen.at(-1).find((r) => r.id === 'dir-fresh')?.people === 4, 5000, 'pushed update');
  stop();

  for (const id of ['dir-fresh', 'dir-stale', 'dir-ancient', 'dir-junk', 'dir-mismatch', 'dir-future', 'lobby']) put(id, new Uint8Array(0));
});
