// Midsentence server: serves the static client from /public, a tiny JSON API for
// rooms, and a WebSocket endpoint (/ws) that streams every keystroke.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join as joinPath, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomStore, RoomError, isValidRoomId, publicMember, LIMITS } from './rooms.js';

const ROOT = resolve(fileURLToPath(new URL('../public', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function createAppServer({ store = new RoomStore(), log = console.log } = {}) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('request failed', err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return api(req, res, url);

    // Pretty share links: /r/<id> → /room.html?r=<id>
    const pretty = url.pathname.match(/^\/r\/([a-z0-9-]+)\/?$/);
    if (pretty) {
      res.writeHead(302, { Location: `/room.html?r=${pretty[1]}` });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  }

  async function api(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

    if (req.method === 'GET' && parts[1] === 'health') return send(res, 200, { ok: true, mode: 'server' });
    if (req.method === 'GET' && parts[1] === 'stats') return send(res, 200, store.stats());

    if (parts[1] === 'rooms' && parts.length === 2) {
      if (req.method === 'GET') return send(res, 200, { rooms: store.list() });
      if (req.method === 'POST') {
        const body = await readJson(req);
        try {
          const room = store.create({ id: body.id, name: body.name, topic: body.topic, isPublic: body.isPublic !== false });
          return send(res, 201, { room: store.summary(room) });
        } catch (err) {
          if (err instanceof RoomError) return send(res, err.code === 'exists' ? 409 : 400, { error: err.message, code: err.code });
          throw err;
        }
      }
    }

    if (req.method === 'GET' && parts[1] === 'rooms' && parts.length === 3) {
      const room = isValidRoomId(parts[2]) && store.get(parts[2]);
      if (!room) return send(res, 404, { error: 'Room not found.', code: 'not_found' });
      return send(res, 200, { room: store.summary(room) });
    }

    return send(res, 404, { error: 'Not found.' });
  }

  // ---------------------------------------------------------------- sockets
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.bucket = { tokens: 120, at: Date.now() };
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      if (!allow(ws)) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') onMessage(ws, msg);
    });
    ws.on('close', () => detach(ws));
  });

  function onMessage(ws, msg) {
    if (msg.t === 'join') return joinRoom(ws, msg);
    const room = ws.room && store.get(ws.room);
    const member = room?.members.get(ws.memberId);
    if (!member || member.socket !== ws) return;

    switch (msg.t) {
      case 'type': {
        store.type(room, member, msg.text, msg.caret);
        broadcast(room, { t: 'type', id: member.id, text: member.text, caret: member.caret }, ws);
        break;
      }
      case 'commit': {
        const line = store.commit(room, member, msg.text);
        broadcast(room, { t: 'type', id: member.id, text: '', caret: 0 }, ws);
        if (line) broadcast(room, { t: 'line', line, nonce: typeof msg.nonce === 'string' ? msg.nonce.slice(0, 40) : undefined });
        break;
      }
      case 'react': {
        const line = store.react(room, member.id, msg.line, msg.emoji);
        if (line) broadcast(room, { t: 'react', line: line.id, reactions: line.reactions });
        break;
      }
      case 'profile': {
        Object.assign(member, cleanProfile(msg, member));
        broadcast(room, { t: 'profile', member: publicMember(member) });
        break;
      }
      case 'away': {
        member.away = Boolean(msg.away);
        broadcast(room, { t: 'profile', member: publicMember(member) }, ws);
        break;
      }
      case 'leave': {
        detach(ws);
        break;
      }
    }
  }

  function cleanProfile(msg, member) {
    const name = typeof msg.name === 'string' ? msg.name.replace(/\s+/g, ' ').trim().slice(0, LIMITS.name) : '';
    const color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color.toLowerCase() : member.color;
    return { name: name || member.name, color };
  }

  function joinRoom(ws, msg) {
    const room = isValidRoomId(msg.room) && store.get(msg.room);
    if (!room) return sendWs(ws, { t: 'error', code: 'not_found', message: 'This room has ended or never existed.' });
    const id = typeof msg.me?.id === 'string' && /^[a-z0-9]{6,32}$/i.test(msg.me.id) ? msg.me.id : null;
    if (!id) return sendWs(ws, { t: 'error', code: 'bad_member', message: 'Missing member id.' });

    if (ws.room && (ws.room !== room.id || ws.memberId !== id)) detach(ws);

    let result;
    try {
      result = store.join(room, id, msg.me);
    } catch (err) {
      if (err instanceof RoomError) return sendWs(ws, { t: 'error', code: err.code, message: err.message });
      throw err;
    }
    const { member, rejoined } = result;
    // Same tab reconnecting: quietly hand the seat over to the new socket.
    const previous = member.socket;
    if (previous && previous !== ws) {
      previous.room = null;
      previous.close(4000, 'replaced');
    }
    member.socket = ws;
    member.away = false;
    ws.room = room.id;
    ws.memberId = id;

    sendWs(ws, { t: 'welcome', you: id, ...store.snapshot(room) });
    broadcast(room, { t: rejoined ? 'profile' : 'join', member: publicMember(member) }, ws);
  }

  function detach(ws) {
    const room = ws.room && store.get(ws.room);
    ws.room = null;
    if (!room) return;
    const member = room.members.get(ws.memberId);
    if (!member || member.socket !== ws) return;
    store.leave(room, member.id);
    broadcast(room, { t: 'leave', id: member.id });
  }

  function broadcast(room, payload, except) {
    const data = JSON.stringify(payload);
    for (const m of room.members.values()) {
      if (m.socket && m.socket !== except && m.socket.readyState === 1) m.socket.send(data);
    }
  }

  // Token bucket: ~60 messages/second sustained, bursts up to 120.
  function allow(ws) {
    const now = Date.now();
    const b = ws.bucket;
    b.tokens = Math.min(120, b.tokens + ((now - b.at) / 1000) * 60);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    store.sweep();
  }, 25_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  // ----------------------------------------------------------------- static
  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, { error: 'Bad path.' });
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(joinPath(ROOT, rel));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, { error: 'Forbidden.' });

    let target = file;
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = joinPath(target, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info && !extname(target)) {
      target += '.html';
      info = await stat(target).catch(() => null);
    }
    if (!info) {
      target = joinPath(ROOT, '404.html');
      info = await stat(target).catch(() => null);
      if (!info) return send(res, 404, { error: 'Not found.' });
      res.statusCode = 404;
    }

    const type = MIME[extname(target)] || 'application/octet-stream';
    const body = await readFile(target);
    res.writeHead(res.statusCode || 200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return { server, wss, store };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendWs(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolveBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolveBody({});
      }
    });
    req.on('error', () => resolveBody({}));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createAppServer();
  server.listen(port, () => console.log(`Midsentence is live on http://localhost:${port}`));
}
