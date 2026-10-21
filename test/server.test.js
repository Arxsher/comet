import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createAppServer } from '../server/index.js';
import { RoomStore } from '../server/rooms.js';

let base;
let wsBase;
let app;

before(async () => {
  app = createAppServer({ store: new RoomStore(), log: () => {} });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});

after(() => {
  for (const ws of app.wss.clients) ws.terminate();
  app.server.close();
});

function client(room, me) {
  const ws = new WebSocket(wsBase);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const next = (match) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 2000);
      waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  const ready = new Promise((r) => ws.on('open', r)).then(() => ws.send(JSON.stringify({ t: 'join', room, me })));
  return { ws, next, ready, send: (m) => ws.send(JSON.stringify(m)) };
}

test('serves the landing page and seeded rooms', async () => {
  const html = await fetch(base + '/').then((r) => r.text());
  assert.match(html, /Midsentence/);
  const { rooms } = await fetch(base + '/api/rooms').then((r) => r.json());
  assert.ok(rooms.some((r) => r.id === 'lobby'));
});

test('blocks path traversal', async () => {
  const res = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(res.status, 200);
});

test('creates rooms and validates ids', async () => {
  const created = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '  Test   room ', topic: 'hello', isPublic: false }),
  }).then((r) => r.json());
  assert.equal(created.room.name, 'Test room');
  assert.equal(created.room.isPublic, false);

  const { rooms } = await fetch(base + '/api/rooms').then((r) => r.json());
  assert.ok(!rooms.some((r) => r.id === created.room.id), 'private rooms are not listed');

  const bad = await fetch(base + '/api/rooms', { method: 'POST', body: JSON.stringify({ id: 'NOPE!' }) });
  assert.equal(bad.status, 400);

  const missing = await fetch(base + '/api/rooms/does-not-exist');
  assert.equal(missing.status, 404);
});

test('streams keystrokes, commits lines and toggles reactions', async () => {
  const a = client('lobby', { id: 'aaaaaaaa', name: 'Ada', color: '#ff3932' });
  await a.ready;
  const welcomeA = await a.next((m) => m.t === 'welcome');
  assert.equal(welcomeA.you, 'aaaaaaaa');

  const b = client('lobby', { id: 'bbbbbbbb', name: 'Bo', color: '#34d399' });
  await b.ready;
  const welcomeB = await b.next((m) => m.t === 'welcome');
  assert.deepEqual(welcomeB.members.map((m) => m.name).sort(), ['Ada', 'Bo']);
  const joined = await a.next((m) => m.t === 'join');
  assert.equal(joined.member.name, 'Bo');

  a.send({ t: 'type', text: 'hel', caret: 3 });
  const typed = await b.next((m) => m.t === 'type');
  assert.deepEqual([typed.id, typed.text, typed.caret], ['aaaaaaaa', 'hel', 3]);

  a.send({ t: 'commit', text: 'hello world', nonce: 'n1' });
  const lineB = await b.next((m) => m.t === 'line');
  const lineA = await a.next((m) => m.t === 'line');
  assert.equal(lineB.line.text, 'hello world');
  assert.equal(lineA.nonce, 'n1');

  b.send({ t: 'react', line: lineB.line.id, emoji: '🔥' });
  const reacted = await a.next((m) => m.t === 'react');
  assert.deepEqual(reacted.reactions, { '🔥': ['bbbbbbbb'] });

  b.ws.close();
  const left = await a.next((m) => m.t === 'leave');
  assert.equal(left.id, 'bbbbbbbb');
  a.ws.close();
});

test('rejects unknown rooms over the socket', async () => {
  const c = client('ghost-room', { id: 'cccccccc', name: 'Cy' });
  await c.ready;
  const err = await c.next((m) => m.t === 'error');
  assert.equal(err.code, 'not_found');
  c.ws.close();
});

test('a reconnecting tab keeps its seat without a leave/join flicker', async () => {
  const watcher = client('design-crit', { id: 'wwwwwwww', name: 'Wes' });
  await watcher.ready;
  await watcher.next((m) => m.t === 'welcome');

  const first = client('design-crit', { id: 'dddddddd', name: 'Di' });
  await first.ready;
  await first.next((m) => m.t === 'welcome');
  await watcher.next((m) => m.t === 'join');

  const second = client('design-crit', { id: 'dddddddd', name: 'Di' });
  await second.ready;
  await second.next((m) => m.t === 'welcome');
  const update = await watcher.next((m) => m.t === 'profile' || m.t === 'leave');
  assert.equal(update.t, 'profile');

  second.ws.close();
  watcher.ws.close();
});
