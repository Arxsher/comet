// A minimal MQTT 3.1.1 client over WebSocket — just what relay mode needs:
// QoS 0 publish/subscribe, retained messages, a last will and keepalive.
// No dependencies; runs in browsers and in Node 22+ (global WebSocket).

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const PUBREC = 5;
const PUBREL = 6;
const PUBCOMP = 7;
const SUBSCRIBE = 8;
const SUBACK = 9;
const UNSUBSCRIBE = 10;
const UNSUBACK = 11;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

const MAX_LENGTH = 268_435_455; // the most four length bytes can express

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const bytes = (value) => (typeof value === 'string' ? encoder.encode(value) : value instanceof Uint8Array ? value : new Uint8Array(0));
const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);

/** A length-prefixed field (strings and binary data use the same encoding). */
function field(value) {
  const data = bytes(value);
  if (data.length > 0xffff) throw new RangeError('MQTT field longer than 65535 bytes');
  return concat([u16(data.length), data]);
}

/** "Remaining length": 7 bits per byte, high bit means another byte follows (1–4 bytes). */
export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_LENGTH) throw new RangeError('MQTT packet too large');
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

function packet(type, flags, ...parts) {
  const body = concat(parts);
  return concat([Uint8Array.of((type << 4) | flags), encodeLength(body.length), body]);
}

/**
 * Turns a stream of WebSocket frames into MQTT packets. A frame may hold
 * several packets, and a packet may be split across frames.
 */
export class PacketReader {
  constructor(maxPacketSize = 1024 * 1024) {
    this.max = maxPacketSize;
    this.buf = new Uint8Array(0);
    this.skip = 0;
  }

  /** Returns the complete packets now available: [{ type, flags, body }]. Throws on a malformed length. */
  push(chunk) {
    let data = chunk;
    if (this.skip) {
      const n = Math.min(this.skip, data.length);
      this.skip -= n;
      data = data.subarray(n);
    }
    this.buf = this.buf.length ? concat([this.buf, data]) : data;

    const packets = [];
    while (this.buf.length >= 2) {
      let length = 0;
      let multiplier = 1;
      let i = 1;
      for (;;) {
        if (i > 4) throw new Error('Malformed MQTT remaining length');
        if (i >= this.buf.length) return packets; // the length itself isn't complete yet
        const byte = this.buf[i++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if (!(byte & 0x80)) break;
      }

      if (length > this.max) {
        // Too big to buffer: let it stream past instead of holding it in memory.
        const available = this.buf.length - i;
        if (available >= length) {
          this.buf = this.buf.subarray(i + length);
          continue;
        }
        this.skip = length - available;
        this.buf = new Uint8Array(0);
        return packets;
      }

      if (this.buf.length < i + length) return packets;
      packets.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.subarray(i, i + length) });
      this.buf = this.buf.subarray(i + length);
    }
    return packets;
  }
}

function randomClientId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // 20 chars + prefix stays under the 23-char limit some brokers still enforce.
  return 'ms' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => alphabet[b % 36]).join('');
}

/**
 * const client = new MqttClient('wss://broker.example/mqtt', { will: { topic, payload } });
 * client.onmessage = (topic, payload, { retain }) => {};
 * client.onclose = (error) => {};   // only for unexpected drops, not end()/destroy()
 * await client.connect();
 */
export class MqttClient {
  constructor(url, { clientId, username, password, keepalive = 30, will = null, connectTimeout = 5000, maxPacketSize, WebSocket } = {}) {
    this.url = url;
    this.clientId = clientId || randomClientId();
    this.options = { username, password, keepalive, will, connectTimeout, WebSocket };
    this.reader = new PacketReader(maxPacketSize);
    this.connected = false;
    this.dead = false;
    this.acks = new Map();
    this.lastId = 0;
    this.onmessage = null;
    this.onclose = null;
  }

  /** Opens the socket and resolves once the broker accepts the CONNECT. */
  connect() {
    this.ready ||= new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.teardown(new Error('MQTT connect timed out')), this.options.connectTimeout);
      this.pendingConnect = {
        resolve: () => (clearTimeout(timer), resolve(this)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      };
      try {
        const WS = this.options.WebSocket || globalThis.WebSocket;
        this.ws = new WS(this.url, 'mqtt');
      } catch (err) {
        return this.teardown(err);
      }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => this.send(this.connectPacket());
      this.ws.onmessage = (event) => this.receive(event.data);
      this.ws.onerror = () => {}; // a close event always follows
      this.ws.onclose = () => this.teardown(new Error('MQTT connection closed'));
    });
    return this.ready;
  }

  connectPacket() {
    const { username, password, will, keepalive } = this.options;
    let flags = 0x02; // clean session: the broker keeps nothing for us between connections
    const payload = [field(this.clientId)];
    if (will) {
      flags |= 0x04 | (will.retain ? 0x20 : 0); // will flag (+ retain), will QoS 0
      payload.push(field(will.topic), field(bytes(will.payload)));
    }
    if (username != null) {
      flags |= 0x80;
      payload.push(field(username));
      if (password != null) {
        flags |= 0x40; // 3.1.1 only allows a password together with a username
        payload.push(field(password));
      }
    }
    return packet(CONNECT, 0, field('MQTT'), Uint8Array.of(4, flags), u16(keepalive), ...payload);
  }

  /** QoS 0 publish. Returns false (and sends nothing) when not connected. */
  publish(topic, payload, { retain = false } = {}) {
    if (!this.connected) return false;
    return this.send(packet(PUBLISH, retain ? 1 : 0, field(topic), bytes(payload)));
  }

  /** Subscribes at QoS 0; resolves with the SUBACK return codes. */
  subscribe(topics) {
    const list = [].concat(topics);
    return this.request(SUBSCRIBE, list.map((t) => concat([field(t), Uint8Array.of(0)]))).then((codes) => {
      if (codes.some((c) => c === 0x80)) throw new Error('MQTT subscription refused');
      return codes;
    });
  }

  unsubscribe(topics) {
    return this.request(UNSUBSCRIBE, [].concat(topics).map(field)).then(() => {});
  }

  /** Sends a PINGREQ now and drops the connection if nothing comes back within `timeout`. */
  checkAlive(timeout = 4000) {
    if (!this.connected) return;
    this.ping();
    clearTimeout(this.probe);
    this.probe = setTimeout(() => this.awaitingPong && this.teardown(new Error('MQTT keepalive timed out')), timeout);
  }

  /** Graceful goodbye: DISCONNECT tells the broker to discard our last will. */
  end() {
    if (this.connected) this.send(Uint8Array.of(DISCONNECT << 4, 0));
    this.onclose = null;
    this.teardown(new Error('MQTT client ended'));
  }

  /** Drops the socket without DISCONNECT, so the broker publishes our last will. */
  destroy() {
    this.onclose = null;
    this.teardown(new Error('MQTT client destroyed'));
  }

  // ---------------------------------------------------------------- internals

  request(type, parts) {
    if (!this.connected) return Promise.reject(new Error('MQTT not connected'));
    this.lastId = (this.lastId % 0xffff) + 1;
    const id = this.lastId;
    return new Promise((resolve, reject) => {
      this.acks.set(id, { resolve, reject });
      this.send(packet(type, 0x02, u16(id), ...parts));
    });
  }

  send(data) {
    if (this.dead || this.ws?.readyState !== 1) return false;
    try {
      this.ws.send(data);
      this.lastSent = Date.now();
      return true;
    } catch (err) {
      this.teardown(err);
      return false;
    }
  }

  ping() {
    this.awaitingPong = true;
    this.send(Uint8Array.of(PINGREQ << 4, 0));
  }

  startKeepalive() {
    const period = this.options.keepalive * 1000;
    if (!period) return;
    // Ping twice per keepalive period; if a whole half-period passes without
    // hearing anything back, the connection is dead even if the socket isn't.
    this.pinger = setInterval(() => {
      if (this.awaitingPong) return this.teardown(new Error('MQTT keepalive timed out'));
      this.ping();
    }, period / 2);
  }

  receive(data) {
    if (this.dead) return;
    let chunk;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return; // text frames aren't MQTT

    let packets;
    try {
      packets = this.reader.push(chunk);
    } catch (err) {
      return this.teardown(err);
    }
    this.awaitingPong = false; // any traffic proves the connection is alive
    for (const p of packets) {
      if (this.dead) return;
      this.handle(p);
    }
    // Background tabs may run our keepalive timer only once a minute, but
    // incoming messages are still delivered: use them to ping when overdue,
    // so the broker doesn't time us out while the room is busy.
    const period = this.options.keepalive * 500;
    if (this.connected && period && Date.now() - this.lastSent > period) this.ping();
  }

  handle({ type, flags, body }) {
    switch (type) {
      case CONNACK: {
        if (!this.pendingConnect) return;
        if (body.length < 2 || body[1] !== 0) return this.teardown(new Error(`MQTT connection refused (code ${body[1]})`));
        this.connected = true;
        this.startKeepalive();
        const { resolve } = this.pendingConnect;
        this.pendingConnect = null;
        resolve();
        return;
      }
      case PUBLISH: {
        const qos = (flags >> 1) & 3;
        if (body.length < 2) return;
        let offset = 2 + ((body[0] << 8) | body[1]);
        if (offset > body.length) return;
        const topic = decoder.decode(body.subarray(2, offset));
        if (qos > 0) {
          if (offset + 2 > body.length) return;
          const id = body.subarray(offset, offset + 2);
          offset += 2;
          // We only subscribe at QoS 0, but acknowledge anything higher so a broker never stalls on us.
          this.send(packet(qos === 1 ? PUBACK : PUBREC, 0, id));
        }
        this.onmessage?.(topic, body.slice(offset), { retain: Boolean(flags & 1) });
        return;
      }
      case PUBREL:
        if (body.length >= 2) this.send(packet(PUBCOMP, 0, body.subarray(0, 2)));
        return;
      case SUBACK:
      case UNSUBACK: {
        if (body.length < 2) return;
        const id = (body[0] << 8) | body[1];
        const pending = this.acks.get(id);
        if (!pending) return;
        this.acks.delete(id);
        pending.resolve([...body.subarray(2)]);
        return;
      }
      case PINGRESP:
        return;
    }
  }

  teardown(err) {
    if (this.dead) return;
    this.dead = true;
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this.pinger);
    clearTimeout(this.probe);
    for (const { reject } of this.acks.values()) reject(err);
    this.acks.clear();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
    }
    if (this.pendingConnect) {
      this.pendingConnect.reject(err);
      this.pendingConnect = null;
    }
    if (wasConnected) this.onclose?.(err);
  }
}
