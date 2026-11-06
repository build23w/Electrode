// The game's connections end here, in the page, and are passed on to wherever the world runs.
//
// A world moves from one player's browser to another's while people are in it (lib/p2p.js). The
// game client knows nothing of that: it signs in once, to this module, and keeps that connection
// for as long as it runs. This module signs in to the world's current host on the game's behalf
// and passes the packets through. When the world moves, it signs in to the new host, enters the
// world there with the same character, and tells the game what a world server tells it when it
// moves a player to another map: load the world at this place (SMSG_TRANSFER_PENDING, then
// SMSG_NEW_WORLD). The game shows its loading screen and carries on where the character stood.
// It never sees its login or character screen. A player who walked on while the world was
// between hosts stays where they walked to: the game is put there after it has loaded, and the
// new host is told where the character stands.
//
// Both sides of the 1.12.1 (build 5875) protocols are spoken here:
//   to the game     the login server (SRP6 as realmd does it) and the world server's handshake
//   to the world    the client's side of both
// Packet bodies pass through untouched; only the headers, which are encrypted with the session
// key of each side, are re-encrypted.

const te = new TextEncoder();
const td = new TextDecoder();
const EMPTY = new Uint8Array(0);

// ---- bytes, SHA-1, big numbers -------------------------------------------------------------------

function concat(...parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const u32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const upper = (s) => String(s).toUpperCase();

/** SHA-1 of the parts in a row (synchronous: the handshakes hash a few hundred bytes). */
export function sha1(...parts) {
  const data = concat(...parts);
  const total = (((data.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(total - 4, (data.length << 3) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  const w = new Int32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h));
  return out;
}

// Every number on the wire is little endian.
function fromLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function toLE(n, size = 32) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}
function modpow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}
// A number as the world server hashes it: without its high-order zero bytes.
function short(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

// ---- SRP6 as the 1.12 login protocol uses it -----------------------------------------------------

const N_LE = Uint8Array.of(
  0xb7, 0x9b, 0x3e, 0x2a, 0x87, 0x82, 0x3c, 0xab, 0x8f, 0x5e, 0xbf, 0xbf, 0x8e, 0xb1, 0x01, 0x08,
  0x53, 0x50, 0x06, 0x29, 0x8b, 0x5b, 0xad, 0xbd, 0x5b, 0x53, 0xe1, 0x89, 0x5e, 0x64, 0x4b, 0x89
);
const N = fromLE(N_LE);
const G = 7n;
const K_MULT = 3n;
// The login server's version challenge (a constant in the mangos family) and the 1.12.1 Windows
// client's answer to it, which a strict login server checks.
const VERSION_CHALLENGE = Uint8Array.of(0xba, 0xa3, 0x1e, 0x99, 0xa0, 0x0b, 0x21, 0x57, 0xfc, 0x37, 0x3f, 0xb3, 0x69, 0xcd, 0xd2, 0xf1);
const CLIENT_INTEGRITY = Uint8Array.of(0x95, 0xed, 0xb2, 0x7c, 0x78, 0x23, 0xb3, 0x63, 0xcb, 0xdd, 0xab, 0x56, 0xa3, 0x92, 0xe7, 0xcb, 0x73, 0xfc, 0xca, 0x20);
const NG_HASH = (() => {
  const n = sha1(N_LE);
  const g = sha1(Uint8Array.of(7));
  return n.map((v, i) => v ^ g[i]);
})();

const passwordHash = (user, pass) => sha1(te.encode(`${upper(user)}:${upper(pass)}`));

// SHA1_Interleave: the even and the odd bytes of S hashed apart, the digests woven together.
function interleave(s) {
  const even = new Uint8Array(16);
  const odd = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    even[i] = s[i * 2];
    odd[i] = s[i * 2 + 1];
  }
  const a = sha1(even);
  const b = sha1(odd);
  const out = new Uint8Array(40);
  for (let i = 0; i < 20; i++) {
    out[i * 2] = a[i];
    out[i * 2 + 1] = b[i];
  }
  return out;
}

// The login server's side, for the game. The game hashes every number at its full width; B and
// the salt are drawn so that they have no high-order zero byte, which reads the same both ways.
function serverChallenge(user, pass) {
  let salt;
  do salt = random(32); while (salt[31] === 0);
  const v = modpow(G, fromLE(sha1(salt, passwordHash(user, pass))), N);
  for (;;) {
    const b = fromLE(random(32)) % N;
    const B = toLE((K_MULT * v + modpow(G, b, N)) % N);
    if (b > 1n && B[31] !== 0) return { user: upper(user), salt, v, b, B };
  }
}
function serverProof({ user, salt, v, b, B }, A, M1) {
  const a = fromLE(A);
  if (a % N === 0n) return null;
  const u = fromLE(sha1(A, B));
  const K = interleave(toLE(modpow((a * modpow(v, u, N)) % N, b, N)));
  if (!equal(M1, sha1(NG_HASH, sha1(te.encode(user)), salt, A, B, K))) return null;
  return { K, M2: sha1(A, M1, K) };
}

// The client's side, for the world. `exact`: hash numbers at full width, as the game does (used
// by the tests, which play the game's part); otherwise as the world server does, short.
function clientProof(user, pass, salt, B, exact = false) {
  const cut = exact ? (x) => x : short;
  const x = fromLE(sha1(cut(salt), passwordHash(user, pass)));
  const base = (((fromLE(B) - K_MULT * modpow(G, x, N)) % N) + N) % N;
  for (let draw = 1; ; draw++) {
    // Values the two sides would hash differently are drawn again (about one draw in forty).
    const last = draw >= 512;
    const a = fromLE(random(32));
    const A = toLE(modpow(G, a, N));
    if (A[31] === 0 && !last) continue;
    const u = fromLE(sha1(A, cut(B)));
    const S = toLE(modpow(base, a + u * x, N));
    if (S[0] === 0 && !last) continue;
    const K = interleave(S);
    if (K[39] === 0 && !last) continue;
    const M1 = sha1(NG_HASH, sha1(te.encode(upper(user))), cut(salt), A, cut(B), K);
    if (M1[19] === 0 && !last) continue;
    return { A, M1, K, M2: sha1(A, M1, K) };
  }
}

// ---- the world protocol's packets ----------------------------------------------------------------

export const OP = {
  CMSG_CHAR_CREATE: 0x036, CMSG_CHAR_ENUM: 0x037, SMSG_CHAR_CREATE: 0x03a, SMSG_CHAR_ENUM: 0x03b,
  CMSG_PLAYER_LOGIN: 0x03d, SMSG_NEW_WORLD: 0x03e, SMSG_TRANSFER_PENDING: 0x03f, SMSG_CHARACTER_LOGIN_FAILED: 0x041,
  SMSG_LOGOUT_COMPLETE: 0x04d, CMSG_JOIN_CHANNEL: 0x097, CMSG_LEAVE_CHANNEL: 0x098, SMSG_CHANNEL_NOTIFY: 0x099,
  MSG_MOVE_TELEPORT_ACK: 0x0c7, MSG_MOVE_WORLDPORT_ACK: 0x0dc, MSG_MOVE_HEARTBEAT: 0x0ee, CMSG_PING: 0x1dc, SMSG_PONG: 0x1dd,
  SMSG_AUTH_CHALLENGE: 0x1ec, CMSG_AUTH_SESSION: 0x1ed, SMSG_AUTH_RESPONSE: 0x1ee,
  SMSG_LOGIN_VERIFY_WORLD: 0x236, SMSG_ADDON_INFO: 0x2ef,
};
// What the game sends as its character moves: each carries flags, the game's clock and the position.
const MOVES = new Set([0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb, 0xda, 0xdb, 0xee]);
const ON_TRANSPORT = 0x02000000;
const u32at = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const f32at = (b, at) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(at, true);
// A guid as update packets carry it: a mask of its non-zero bytes, then those bytes.
function packGuid(guid) {
  const out = [0];
  for (let i = 0; i < 8; i++) {
    if (guid[i]) {
      out[0] |= 1 << i;
      out.push(guid[i]);
    }
  }
  return Uint8Array.from(out);
}
const AUTH_OK = 0x0c;
const AUTH_FAILED = 0x0d;
const AUTH_WAIT_QUEUE = 0x1b;
const YOU_JOINED = 0x02;
const BUILD = 5875;

// One direction of a session's header encryption.
export class Half {
  constructor(key) {
    this.key = key;
    this.i = 0;
    this.prev = 0;
  }
  encrypt(data) {
    for (let t = 0; t < data.length; t++) {
      const x = ((data[t] ^ this.key[this.i]) + this.prev) & 255;
      this.i = (this.i + 1) % this.key.length;
      data[t] = this.prev = x;
    }
    return data;
  }
  decrypt(data) {
    for (let t = 0; t < data.length; t++) {
      const x = data[t];
      data[t] = ((x - this.prev) & 255) ^ this.key[this.i];
      this.i = (this.i + 1) % this.key.length;
      this.prev = x;
    }
    return data;
  }
}

// A packet as the world server sends it: size (big endian, opcode included), opcode (16 bits).
export function serverPacket(opcode, body, half) {
  const out = new Uint8Array(4 + body.length);
  const size = body.length + 2;
  out[0] = size >> 8;
  out[1] = size & 255;
  out[2] = opcode & 255;
  out[3] = opcode >> 8;
  if (half) half.encrypt(out.subarray(0, 4));
  out.set(body, 4);
  return out;
}
// A packet as the game sends it: size, opcode (32 bits).
export function clientPacket(opcode, body, half) {
  const out = new Uint8Array(6 + body.length);
  const size = body.length + 4;
  out[0] = size >> 8;
  out[1] = size & 255;
  out[2] = opcode & 255;
  out[3] = (opcode >> 8) & 255;
  if (half) half.encrypt(out.subarray(0, 6));
  out.set(body, 6);
  return out;
}

// The proof a world connection opens with: SHA1(account, 0, client seed, server seed, session key).
const worldProof = (user, clientSeed, serverSeed, key) => sha1(te.encode(upper(user)), new Uint8Array(4), clientSeed, serverSeed, key);

// The bytes of a connection: read a piece at a time during a handshake, then handed on as they come.
export class Inbox {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.ended = false;
    this.waiter = null;
    this.sink = null;
    this.onend = null;
  }
  push(bytes) {
    if (this.ended || !bytes.length) return;
    if (this.sink) return this.sink(bytes);
    this.chunks.push(bytes);
    this.size += bytes.length;
    this.waiter?.();
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.waiter?.();
    this.onend?.();
  }
  async read(n) {
    while (this.size < n) {
      if (this.ended) throw new Error('the connection closed');
      await new Promise((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - at);
      out.set(head.subarray(0, take), at);
      at += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.size -= n;
    return out;
  }
  /** From now on every piece goes to `fn` as it arrives (what is waiting goes first). */
  stream(fn) {
    const waiting = this.chunks;
    this.chunks = [];
    this.size = 0;
    this.sink = fn;
    for (const bytes of waiting) fn(bytes);
  }
}

// Cuts a stream into packets: `headerSize` 6 for what the game sends, 4 for what a world sends.
class Frames {
  constructor(headerSize, half, onpacket) {
    this.headerSize = headerSize;
    this.half = half;
    this.onpacket = onpacket;
    this.pending = EMPTY;
    this.header = null;
    this.need = 0;
  }
  push(bytes) {
    const p = this.pending.length ? concat(this.pending, bytes) : bytes;
    const H = this.headerSize;
    let at = 0;
    for (;;) {
      if (!this.header) {
        if (p.length - at < H) break;
        this.header = this.half.decrypt(p.slice(at, at + H));
        at += H;
        this.need = ((this.header[0] << 8) | this.header[1]) - (H - 2);
        if (this.need < 0) throw new Error('a packet with an impossible size');
      }
      if (p.length - at < this.need) break;
      const h = this.header;
      this.header = null;
      const opcode = H === 6 ? (h[2] | (h[3] << 8) | (h[4] << 16) | (h[5] << 24)) >>> 0 : h[2] | (h[3] << 8);
      this.onpacket(opcode, p.subarray(at, at + this.need));
      at += this.need;
    }
    this.pending = at < p.length ? p.slice(at) : EMPTY;
  }
}

// A step of a handshake that gets no answer is given up on (and tried again), not waited for.
const within = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error(`no answer from the world (${what})`), { timedOut: true })), ms);
  promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  }, (e) => {
    clearTimeout(timer);
    reject(e);
  });
});

// A connection to a world ({ connect(port) }: the server in this tab, or its host through lib/p2p.js).
function dial(world, port) {
  const conn = world.connect(port);
  const inbox = new Inbox();
  conn.ondata = (bytes) => inbox.push(bytes);
  conn.onclose = () => inbox.end();
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('no answer from the world (connecting)'), { timedOut: true })), 8000);
    conn.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    inbox.onend = () => {
      clearTimeout(timer);
      reject(new Error('the world did not take the connection'));
    };
  });
  return { conn, inbox, opened };
}

// The client's side of a login: resolves with the session key and the realm list as the login server sent it.
async function signIn(world, user, pass, exact = false) {
  for (let attempt = 1; ; attempt++) {
    const { conn, inbox, opened } = dial(world, 3724);
    // A login server that stops answering half way: the connection is closed, which ends the wait.
    const patience = setTimeout(() => conn.close(), 8000);
    try {
      await opened;
      const name = te.encode(upper(user));
      const body = concat(
        te.encode('WoW\0'), Uint8Array.of(1, 12, 1), Uint8Array.of(BUILD & 255, BUILD >> 8),
        te.encode('68x\0'), te.encode('niW\0'), te.encode('SUne'),
        new Uint8Array(4), Uint8Array.of(127, 0, 0, 1), Uint8Array.of(name.length), name
      );
      conn.send(concat(Uint8Array.of(0, 3, body.length & 255, body.length >> 8), body));
      const head = await inbox.read(3);
      if (head[0] !== 0) throw new Error('the login server sent something unexpected');
      if (head[2] !== 0) throw new Error(`the world does not know this account (code ${head[2]})`);
      const B = await inbox.read(32);
      const g = await inbox.read((await inbox.read(1))[0]);
      const prime = await inbox.read((await inbox.read(1))[0]);
      const salt = await inbox.read(32);
      await inbox.read(16);
      const security = (await inbox.read(1))[0];
      if (security !== 0 || g.length !== 1 || g[0] !== 7 || !equal(prime, N_LE)) throw new Error('the login server asks for something this page does not do');
      const proof = clientProof(user, pass, salt, B, exact);
      conn.send(concat(Uint8Array.of(1), proof.A, proof.M1, sha1(proof.A, CLIENT_INTEGRITY), Uint8Array.of(0, 0)));
      const answer = await inbox.read(2);
      if (answer[0] !== 1) throw new Error('the login server sent something unexpected');
      if (answer[1] !== 0) {
        // A right password can be refused for a moment (the two sides read a number differently,
        // which another draw mends): a few more tries, a little apart.
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
          continue;
        }
        throw new Error(`the world refused the sign-in (code ${answer[1]})`);
      }
      const M2 = await inbox.read(20);
      await inbox.read(4);
      if (!equal(M2, proof.M2) && !equal(M2, sha1(short(proof.A), short(proof.M1), short(proof.K)))) throw new Error('the login server could not prove it knows the account');
      conn.send(Uint8Array.of(0x10, 0, 0, 0, 0));
      const listHead = await inbox.read(3);
      const list = await inbox.read(listHead[1] | (listHead[2] << 8));
      return { key: proof.K, realms: concat(listHead, list) };
    } finally {
      clearTimeout(patience);
      conn.close();
    }
  }
}

// A realm list with one realm, for when the world's own has not been read yet.
function realmListOf(name) {
  const body = concat(
    u32(0), Uint8Array.of(1),
    u32(1), Uint8Array.of(0), te.encode(name + '\0'), te.encode('127.0.0.1:8085\0'), u32(0), Uint8Array.of(0, 1, 0),
    Uint8Array.of(2, 0)
  );
  return concat(Uint8Array.of(0x10, body.length & 255, body.length >> 8), body);
}

const channelOf = (body) => {
  let end = 0;
  while (end < body.length && body[end] !== 0) end++;
  return td.decode(body.subarray(0, end)).toLowerCase();
};

// ---- the bridge ---------------------------------------------------------------------------------

/**
 * const session = new SessionBridge({ user, pass, realm })   what the game is told to sign in with
 * session.connect(port)             for the game's sockets (lib/ws-shim.js): 3724 login, 8085 world
 * await session.attach(world, account)   the world is run there now: { connect(port) }, { user, pass } on it.
 *                                   With the game in the world, resolves once the game has been told
 *                                   to load it there; rejects if the character cannot enter it.
 * session.detach()                  the world's host is gone: the game's connection is held open
 * session.drop()                    close the game's connections (it returns to its login screen)
 * session.onstate = (state) => …    'attached' | 'detached' | 'moving'
 * session.inWorld                   a character is in the world
 */
export class SessionBridge {
  constructor({ user, pass, realm = 'Electrode', log = null }) {
    this.user = upper(user);
    this.pass = pass;
    this.realm = realm;
    this.log = log || (() => {});
    this.world = null;
    this.account = null;
    this.held = false; // the page said the world's host is gone
    this.key = null; // the session key of the game's latest sign-in here
    this.realms = null; // the world's realm list as last read
    this.front = null; // the game's world connection
    this.back = null; // its counterpart on the world
    this.linking = null; // a connection to the world that is still shaking hands
    this.fronts = new Set(); // every open connection of the game
    this.inWorld = false;
    this.guid = null; // the character the game entered the world with
    this.channels = new Map(); // chat channels the game joined: name -> its join packet
    this.map = null; // the map the world last put the character on
    this.moved = null; // the game's latest word on where its character is: { at, bytes: flags, clock, x, y, z, facing }
    this.queue = []; // what the game asked while no world was attached (character screen only)
    this.turn = Promise.resolve(); // sign-ins to the world, one after the other
    this.state = 'attached';
    this.onstate = null;
  }

  #state(state) {
    if (this.state === state) return;
    this.state = state;
    this.onstate?.(state);
  }

  /** A connection of the game. Shaped like a connection to the server in this tab. */
  connect(port) {
    const conn = { onopen: null, ondata: null, onclose: null, open: false, closed: false };
    const inbox = new Inbox();
    const end = { send: (bytes) => !conn.closed && conn.ondata?.(bytes) };
    end.close = () => {
      if (conn.closed) return;
      conn.closed = true;
      this.fronts.delete(end);
      inbox.end();
      conn.onclose?.(true);
    };
    conn.send = (bytes) => !conn.closed && inbox.push(bytes.slice());
    conn.close = () => {
      if (conn.closed) return;
      conn.closed = true;
      this.fronts.delete(end);
      inbox.end();
    };
    this.fronts.add(end);
    setTimeout(() => {
      if (conn.closed) return;
      conn.open = true;
      conn.onopen?.();
      (port === 3724 ? this.#login(inbox, end) : this.#game(inbox, end)).catch((e) => {
        // The game closing its own connection ends the reading here: that is not worth a line.
        if (!conn.closed || port !== 3724) this.log(`game connection (${port}): ${(e && e.message) || e}`);
        end.close();
      });
    }, 0);
    return conn;
  }

  // The login server, for the game.
  async #login(inbox, end) {
    let challenge = null;
    for (;;) {
      const cmd = (await inbox.read(1))[0];
      if (cmd === 0x00) {
        const head = await inbox.read(3);
        const body = await inbox.read(head[1] | (head[2] << 8));
        if (upper(td.decode(body.subarray(30, 30 + body[29]))) !== this.user) {
          end.send(Uint8Array.of(0, 0, 4)); // no such account
          continue;
        }
        challenge = serverChallenge(this.user, this.pass);
        end.send(concat(Uint8Array.of(0, 0, 0), challenge.B, Uint8Array.of(1, 7, 32), N_LE, challenge.salt, VERSION_CHALLENGE, Uint8Array.of(0)));
      } else if (cmd === 0x01) {
        const A = await inbox.read(32);
        const M1 = await inbox.read(20);
        await inbox.read(22);
        const proof = challenge && serverProof(challenge, A, M1);
        challenge = null;
        if (!proof) {
          end.send(Uint8Array.of(1, 4));
          continue;
        }
        this.key = proof.K;
        end.send(concat(Uint8Array.of(1, 0), proof.M2, new Uint8Array(4)));
      } else if (cmd === 0x10) {
        await inbox.read(4);
        end.send(await this.#realmList());
      } else throw new Error(`unexpected login command ${cmd}`);
    }
  }

  // The world keeps one session key for an account: that of its latest sign-in. So the bridge's
  // sign-ins, and the world connection that uses one, go one after the other.
  #inTurn(fn) {
    const run = this.turn.catch(() => {}).then(fn);
    this.turn = run;
    return run;
  }

  async #realmList() {
    if (!this.realms && this.world) {
      await this.#inTurn(async () => {
        const { world, account } = this;
        if (this.realms || !world) return;
        this.realms = (await signIn(world, account.user, account.pass)).realms;
      }).catch(() => {});
    }
    return this.realms || realmListOf(this.realm);
  }

  // The world server's handshake, for the game; then its packets go to the world and back.
  async #game(inbox, end) {
    const seed = random(4);
    end.send(serverPacket(OP.SMSG_AUTH_CHALLENGE, seed, null));
    const head = await inbox.read(6);
    const body = await inbox.read(((head[0] << 8) | head[1]) - 4);
    if ((head[2] | (head[3] << 8)) !== OP.CMSG_AUTH_SESSION) throw new Error('the game did not open with its proof');
    // build, server id, account name, seed, proof, the addon list
    let at = 8;
    while (at < body.length && body[at] !== 0) at++;
    const name = upper(td.decode(body.subarray(8, at)));
    const key = this.key;
    if (!key || name !== this.user || !equal(body.subarray(at + 5, at + 25), worldProof(name, body.subarray(at + 1, at + 5), seed, key))) {
      end.send(serverPacket(OP.SMSG_AUTH_RESPONSE, Uint8Array.of(AUTH_FAILED), null));
      return end.close();
    }
    // `answered`: the game has been let in; `addonsAnswered`: it has had its answer about addons.
    const front = { end, toGame: new Half(key), addons: body.slice(at + 25), loading: null, answered: false, addonsAnswered: false };
    // One game, one world connection: a new one takes the place of the old.
    this.front?.end.close();
    this.#unlink();
    this.front = front;
    this.inWorld = false;
    this.guid = null;
    this.channels.clear();
    this.queue = [];
    const frames = new Frames(6, new Half(key), (opcode, packet) => this.#fromGame(front, opcode, packet));
    inbox.onend = () => {
      if (this.front !== front) return;
      this.front = null;
      this.inWorld = false;
      this.#unlink();
    };
    inbox.stream((bytes) => frames.push(bytes));
    if (this.world && !this.held) await this.#link(front, false);
  }

  #toGame(front, opcode, body) {
    front.end.send(serverPacket(opcode, body, front.toGame));
  }

  #fromGame(front, opcode, body) {
    if (this.front !== front) return;
    if (opcode === OP.CMSG_PLAYER_LOGIN) this.guid = body.slice(0, 8);
    else if (opcode === OP.CMSG_JOIN_CHANNEL) this.channels.set(channelOf(body), body.slice());
    else if (opcode === OP.CMSG_LEAVE_CHANNEL) this.channels.delete(channelOf(body));
    else if (MOVES.has(opcode) && body.length >= 28) this.moved = { at: Date.now(), bytes: body.slice(0, 24) };
    else if (opcode === OP.MSG_MOVE_TELEPORT_ACK && front.placed) {
      front.placed = false; // its answer to being put where it had walked to: the world did not ask
      return;
    }
    const back = this.back;
    if (front.loading) {
      // The game is loading the world at its new host: what it says before it has is for the old one.
      if (opcode === OP.CMSG_PING) return this.#toGame(front, OP.SMSG_PONG, body.slice(0, 4));
      if (opcode === OP.MSG_MOVE_WORLDPORT_ACK) this.#loaded(front);
      return;
    }
    if (!back) {
      // No world to pass it to right now. The game's pings are answered here; from the character
      // screen its requests wait for the next world; from inside the world they mean nothing to it.
      if (opcode === OP.CMSG_PING) return this.#toGame(front, OP.SMSG_PONG, body.slice(0, 4));
      if (!this.inWorld && this.queue.length < 32) this.queue.push([opcode, body.slice()]);
      return;
    }
    back.conn.send(clientPacket(opcode, body, back.toWorld));
  }

  // The game has loaded the world: it gets what the new host sent meanwhile, and its chat channels back.
  #loaded(front) {
    const loading = front.loading;
    if (!loading) return;
    front.loading = null;
    clearTimeout(loading.timer);
    for (const [opcode, body] of loading.packets) this.#toGame(front, opcode, body);
    const back = this.back;
    if (back && loading.stayed && this.guid) {
      // The player walked on while the world was between hosts. The new host has the character
      // where it was last saved: the game is put back where the player is (as a world server
      // moves a player a short way), and the host is told that the character stands there.
      const m = loading.stayed;
      const info = concat(u32(0), u32(u32at(m.bytes, 4) + (Date.now() - m.at)), m.bytes.subarray(8, 24), u32(0));
      front.placed = true;
      this.#toGame(front, OP.MSG_MOVE_TELEPORT_ACK, concat(packGuid(this.guid), u32(0), info));
      back.conn.send(clientPacket(OP.MSG_MOVE_HEARTBEAT, info, back.toWorld));
    }
    if (back) {
      for (const join of this.channels.values()) {
        back.rejoining++;
        back.conn.send(clientPacket(OP.CMSG_JOIN_CHANNEL, join, back.toWorld));
      }
    }
    this.#state('attached');
  }

  #fromWorld(front, back, opcode, body) {
    if (this.back !== back || this.front !== front) return;
    if (opcode === OP.SMSG_LOGIN_VERIFY_WORLD || opcode === OP.SMSG_NEW_WORLD) {
      this.inWorld = true;
      this.map = u32at(body, 0);
      this.moved = null;
    } else if (opcode === OP.SMSG_LOGOUT_COMPLETE) {
      this.inWorld = false;
      this.guid = null;
      this.channels.clear();
    } else if (opcode === OP.SMSG_CHARACTER_LOGIN_FAILED) this.guid = null;
    else if (opcode === OP.SMSG_CHANNEL_NOTIFY && back.rejoining > 0 && body[0] === YOU_JOINED) {
      back.rejoining--; // the game is in this channel as far as it knows
      return;
    } else if (opcode === OP.SMSG_ADDON_INFO) {
      if (front.addonsAnswered) return; // the game had its answer about addons from an earlier host
      front.addonsAnswered = true;
    }
    if (front.loading) front.loading.packets.push([opcode, body.slice()]);
    else this.#toGame(front, opcode, body);
  }

  // Where the game has its character, when that is not where the new host has it: the player
  // moved in the last minute, on the same map, on foot, and not far.
  #stayed(place) {
    const m = this.moved;
    if (!m || this.map !== u32at(place, 0) || Date.now() - m.at > 60000 || u32at(m.bytes, 0) & ON_TRANSPORT) return null;
    const far = Math.hypot(f32at(m.bytes, 8) - f32at(place, 4), f32at(m.bytes, 12) - f32at(place, 8), f32at(m.bytes, 16) - f32at(place, 12));
    return far > 1 && far < 300 ? m : null;
  }

  #unlink() {
    const back = this.back;
    this.back = null;
    back?.conn.close();
    this.linking?.close(); // ends the handshake in flight
    this.linking = null;
  }

  // Signs in to the world and opens the world connection that goes with the game's.
  // `resume`: the game is already past its own sign-in, and maybe in the world.
  #link(front, resume) {
    return this.#inTurn(() => this.#linkNow(front, resume));
  }

  async #linkNow(front, resume) {
    const { world, account } = this;
    const stale = () => this.front !== front || this.world !== world || this.held;
    let link = null;
    for (let attempt = 1; !link; attempt++) {
      if (stale()) throw new Error('the game closed its connection');
      const signed = await signIn(world, account.user, account.pass);
      this.realms = signed.realms;
      const { conn, inbox, opened } = dial(world, 8085);
      this.linking = conn;
      try {
        await opened;
        const hello = await within(inbox.read(8), 5000, 'its greeting');
        const seed = random(4);
        const name = te.encode(upper(account.user));
        conn.send(clientPacket(OP.CMSG_AUTH_SESSION, concat(u32(BUILD), u32(0), name, Uint8Array.of(0), seed, worldProof(account.user, seed, hello.subarray(4, 8), signed.key), front.addons), null));
        const back = { conn, inbox, toWorld: new Half(signed.key), fromWorld: new Half(signed.key), rejoining: 0 };
        back.read = async () => {
          const h = back.fromWorld.decrypt(await inbox.read(4));
          return { opcode: h[2] | (h[3] << 8), body: await inbox.read(((h[0] << 8) | h[1]) - 2) };
        };
        // The world lets the account in (or keeps it waiting in its queue first). A refusal comes
        // before the world has turned its encryption on: a plain packet of one byte.
        for (let first = true; ; first = false) {
          if (first) {
            const raw = await within(inbox.read(4), 4000, 'letting the account in');
            if (raw[0] === 0 && raw[1] === 3 && raw[2] === (OP.SMSG_AUTH_RESPONSE & 255) && raw[3] === OP.SMSG_AUTH_RESPONSE >> 8) {
              const code = (await inbox.read(1))[0];
              throw Object.assign(new Error(`the world refused the session (code ${code})`), { refused: true });
            }
            inbox.chunks.unshift(raw);
            inbox.size += 4;
          }
          const p = await back.read();
          if (p.opcode === OP.SMSG_ADDON_INFO) {
            // The answer about addons can come ahead of the one that lets the account in.
            if (!front.addonsAnswered) this.#toGame(front, p.opcode, p.body);
            front.addonsAnswered = true;
            continue;
          }
          if (p.opcode !== OP.SMSG_AUTH_RESPONSE) throw new Error(`the world did not answer the sign-in (it sent 0x${p.opcode.toString(16)})`);
          if (p.body[0] !== AUTH_OK && p.body[0] !== AUTH_WAIT_QUEUE) throw Object.assign(new Error(`the world refused the session (code ${p.body[0]})`), { refused: true });
          // The game hears this once: at a later host it is already in.
          if (!front.answered) this.#toGame(front, p.opcode, p.body);
          if (p.body[0] === AUTH_OK) break;
        }
        front.answered = true;
        link = back;
        this.linking = null;
      } catch (e) {
        if (this.linking === conn) this.linking = null;
        conn.close();
        // A refusal right after a sign-in can be a matter of a moment (the world has the
        // account's last session still open), and a world that refuses hangs up, sometimes
        // before its answer is out: the same again shortly after is let in.
        this.log(`world sign-in, try ${attempt}: ${(e && e.message) || e}`);
        const again = e && (e.refused || e.timedOut || /connection closed/.test(e.message || ''));
        if (!again || attempt >= 6 || stale()) throw e;
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
    const back = link;
    if (stale()) {
      back.conn.close();
      throw new Error('the world changed again');
    }

    if (resume && this.inWorld && this.guid) {
      // The character enters the world at its new host; the game is told to load the world there.
      back.conn.send(clientPacket(OP.CMSG_PLAYER_LOGIN, this.guid, back.toWorld));
      const early = [];
      let place = null;
      while (!place) {
        const p = await back.read();
        if (p.opcode === OP.SMSG_ADDON_INFO) continue;
        if (p.opcode === OP.SMSG_CHARACTER_LOGIN_FAILED) {
          back.conn.close();
          throw new Error('this character is not in the world as its new host has it');
        }
        if (p.opcode === OP.SMSG_LOGIN_VERIFY_WORLD) place = p.body;
        else early.push([p.opcode, p.body]);
      }
      if (stale()) {
        back.conn.close();
        throw new Error('the world changed again');
      }
      front.loading = { packets: early, timer: setTimeout(() => this.#loaded(front), 120000), stayed: this.#stayed(place) };
      this.#toGame(front, OP.SMSG_TRANSFER_PENDING, place.subarray(0, 4));
      this.#toGame(front, OP.SMSG_NEW_WORLD, place);
    }

    this.back = back;
    const frames = new Frames(4, back.fromWorld, (opcode, body) => this.#fromWorld(front, back, opcode, body));
    back.inbox.onend = () => this.#lost(back);
    back.inbox.stream((bytes) => frames.push(bytes));
    if (back.inbox.ended) return this.#lost(back);
    if (resume && !front.loading) {
      // At the character screen: what the game asked meanwhile is asked of the new host.
      for (const [opcode, body] of this.queue.splice(0)) back.conn.send(clientPacket(opcode, body, back.toWorld));
      this.#state('attached');
    } else if (!resume) this.#state('attached');
  }

  // The world's side of the connection closed.
  #lost(back) {
    if (this.back !== back) return;
    this.back = null;
    const front = this.front;
    if (!front) return;
    if (front.loading) {
      clearTimeout(front.loading.timer);
      front.loading = null;
    }
    if (this.held) return this.#state('detached');
    // The host may be gone (the page says so a moment later), or the world closed this one
    // connection on purpose (the account signed in somewhere else): then the game is told.
    setTimeout(() => {
      if (this.front !== front || this.back || this.held) return;
      front.end.close();
    }, 5000);
  }

  /** The world's host is gone: the game's connection stays open until the world is somewhere again. */
  detach() {
    this.held = true;
    this.world = null;
    this.#unlink();
    if (this.front) {
      if (this.front.loading) {
        clearTimeout(this.front.loading.timer);
        this.front.loading = null;
      }
      this.#state('detached');
    }
  }

  /** The world runs there now. */
  async attach(world, account) {
    this.world = world;
    this.account = account;
    this.held = false;
    this.realms = null;
    const front = this.front;
    if (!front) return this.#state('attached'); // the game is at its login screen: it connects when it signs in
    this.#unlink();
    this.#state('moving');
    await this.#link(front, true);
  }

  /** Closes the game's connections: it goes back to its login screen. */
  drop() {
    this.#unlink();
    this.front = null;
    this.inWorld = false;
    for (const end of [...this.fronts]) end.close();
  }
}

// For the tests, which play the game's part against the bridge.
export const internals = { signIn, clientProof, serverChallenge, serverProof, worldProof, dial, Frames, concat, u32 };
