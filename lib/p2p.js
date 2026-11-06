// Playing together from browsers. One tab runs the world (the host); the others connect to it
// directly with WebRTC and run only the game client. Players find the host by the world's name:
// its hash is a topic on public WebTorrent trackers (tracker.js), which pass the first offer and
// answer and nothing else.
//
// Each player has a key pair (identity.js). The host gives a player's key its own game account
// and returns the same one whenever that key comes back. A player's browser remembers the key of
// the host it last met under a world name and says so when another one answers.
//
// The host is a browser tab that runs the world, or the WoW Electrode desktop app while it hosts
// one (the app runs this same WorldHost and passes game connections on to its world server), so
// browser players and the app's players are in one world.
//
// A world outlives its host. A browser host sends every player a copy of the world's characters
// and accounts whenever it saves (the two database files, compressed), and each player's browser
// keeps the latest one. When the host goes away, the players look for the world again, and the
// first in line starts it from its copy; the others join it there.
//
// The line is ordered by what each player's browser can carry, as measured: a player's browser
// says whether it may run the world and whether it keeps a server warm for it ("fit"); the host
// measures the round trip to each player and how fast that player can send (a short upload
// probe). Those who can carry the world best come first; the order in which players joined only
// breaks ties. A browser that cannot run the world is never in the line.
//
// Wire, per player: one RTCPeerConnection to the host.
//   data channel "ctl"       JSON: hello -> challenge -> proof -> welcome | refused; info; leaving;
//                            fit (player), place and probe (host)
//   data channel "g<port>"   one per game connection (3724 login, 8085 world): raw bytes
//   data channel "copy"      host to player: a JSON header, then the files' bytes;
//                            player to host: the bytes of an upload probe

import { TrackerSwarm } from './tracker.js';
import { verify, fingerprint, toBase64, toHex } from './identity.js';

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const PORTS = new Set([3724, 8085]);
const CHUNK = 16384; // the largest message every browser's data channel takes
const HIGH_WATER = 1 << 20;

/** NFKC, trimmed, inner whitespace collapsed, lowercased: the same rule as the desktop app's names. */
export function canonName(name) {
  const c = String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (c.length === 0 || c.length > 64) throw new Error('A world name is 1 to 64 characters.');
  return c;
}

/** The 20-byte tracker topic of a world name. */
export async function worldTopic(name) {
  const bytes = new TextEncoder().encode('wow-electrode-web/v1/world/' + canonName(name));
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}

const nonce = () => toBase64(crypto.getRandomValues(new Uint8Array(18)));
const hostMessage = (name, guestNonce) => `wow-electrode-web/host|${canonName(name)}|${guestNonce}`;
const guestMessage = (name, hostNonce) => `wow-electrode-web/guest|${canonName(name)}|${hostNonce}`;

// The whole description in one message: wait until the browser has gathered its addresses.
function gathered(pc, ms = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// A data channel as a byte stream with the same shape as the in-tab server's connections.
function streamOf(channel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
  const queue = [];
  const conn = { onopen: null, ondata: null, ontext: null, onclose: null, open: false, closed: false };
  const pump = () => {
    while (queue.length && channel.readyState === 'open' && channel.bufferedAmount < HIGH_WATER) channel.send(queue.shift());
  };
  channel.onbufferedamountlow = pump;
  const opened = () => {
    if (conn.open || conn.closed) return;
    conn.open = true;
    conn.onopen?.();
    pump();
  };
  channel.onopen = opened;
  channel.onmessage = (e) => {
    // The other side's first message can be delivered ahead of this side's open event (the
    // world server speaks first): the connection is open by then, so say so before passing it on.
    opened();
    if (typeof e.data === 'string') conn.ontext?.(e.data);
    else conn.ondata?.(new Uint8Array(e.data));
  };
  const closed = () => {
    if (conn.closed) return;
    conn.closed = true;
    conn.onclose?.(conn.open);
  };
  channel.onclose = closed;
  channel.onerror = closed;
  conn.send = (bytes) => {
    if (conn.closed) return;
    for (let off = 0; off < bytes.length; off += CHUNK) queue.push(bytes.slice(off, off + CHUNK));
    pump();
  };
  conn.sendText = (text) => {
    if (conn.closed) return;
    queue.push(text);
    pump();
  };
  /** Resolves once everything queued has gone out (or after `ms`). */
  conn.drained = (ms = 4000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (conn.closed || (!queue.length && channel.bufferedAmount === 0) || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 50));
    tick();
  });
  conn.close = () => {
    if (conn.closed) return;
    conn.closed = true;
    try {
      channel.close();
    } catch { /* closed already */ }
  };
  if (channel.readyState === 'open') queueMicrotask(opened);
  return conn;
}

async function pack(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unpack(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- the host ---------------------------------------------------------------------------------

/**
 * Announces a world this tab runs and lets players in.
 *   new WorldHost({ name, server, identity })   server: the WorldServer of this tab
 *   host.onchange = () => …                     host.players changed
 *   host.onjoin = () => …                       a player just got in (a good moment to save and send a copy)
 *   host.sendCopy(copy, { final })              copy: { seq, at, names, files: { characters, realmd } }
 *   host.stop()
 */
export class WorldHost {
  constructor({ name, server, identity, trackers, cap = 100, realm = 'Electrode', kind = 'browser' }) {
    this.realm = realm;
    this.kind = kind; // 'browser': a tab runs the world; 'desktop': the desktop app does
    this.name = canonName(name);
    this.server = server;
    this.identity = identity;
    this.trackers = trackers;
    this.cap = cap;
    this.peers = new Set();
    this.onchange = null;
    this.onjoin = null;
    this.swarm = null;
    this.joined = 0; // players let in so far: the order they came in
    this.watch = 0;
    this.lastCopy = null; // { header, bodies } packed once, sent to each player
  }

  get players() {
    let n = 0;
    for (const p of this.peers) if (p.account) n++;
    return n;
  }

  async start() {
    this.swarm = new TrackerSwarm(await worldTopic(this.name), { trackers: this.trackers });
    this.swarm.onoffer = (o) => this.#answer(o).catch((e) => console.warn('world host: offer failed', e));
    this.swarm.announce([]);
    // How far away each player is, measured on the connection there already is.
    this.watch = setInterval(() => this.#measure().catch(() => {}), 10000);
    return this.swarm.ready();
  }

  async #measure() {
    for (const peer of this.peers) {
      if (!peer.account) continue;
      const stats = await peer.pc.getStats();
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated && typeof report.currentRoundTripTime === 'number') {
          peer.rtt = Math.round(report.currentRoundTripTime * 1000);
        }
      }
    }
    this.#places();
  }

  /** The line of who carries the world on, best first: [{ account, place, ready, rtt, up }]. */
  get line() {
    return [...this.peers].filter((p) => p.account).sort((a, b) => (a.place || 1e9) - (b.place || 1e9))
      .map((p) => ({ account: p.account.user, place: p.place || 0, ready: Boolean(p.fit && p.fit.ready), rtt: p.rtt, up: p.up }));
  }

  /** Tells the players this host is leaving on purpose (they carry the world on at once), then closes. */
  async stop() {
    clearInterval(this.watch);
    this.swarm?.leave();
    for (const p of this.peers) {
      try {
        p.ctl?.send(JSON.stringify({ t: 'leaving' }));
      } catch { /* gone already */ }
    }
    await Promise.all([...this.peers].map((p) => p.copy?.drained(3000)));
    for (const p of this.peers) p.pc.close();
    this.peers.clear();
  }

  /** The world's characters and accounts as of now, to every player (and to each one that joins later). */
  async sendCopy(copy, { final = false } = {}) {
    const bodies = [];
    const parts = [];
    for (const [name, bytes] of Object.entries(copy.files)) {
      const packed = await pack(bytes);
      bodies.push(packed);
      parts.push({ name, bytes: packed.length, size: bytes.length });
    }
    this.lastCopy = { header: { t: 'copy', world: this.name, seq: copy.seq, at: copy.at, names: copy.names || {}, parts, final }, bodies };
    for (const p of this.peers) this.#copyTo(p);
  }

  // Each player's place in the line of who carries the world on. First those whose browsers keep
  // a server warm for it, the best connected first; then those who could start it from their
  // copy; a browser that said it cannot run the world has no place (0).
  #places() {
    const admitted = [...this.peers].filter((p) => p.account);
    // In steps, so that small changes in what is measured do not reshuffle the line.
    const cost = (p) => Math.round((p.rtt ?? 80) / 50) * 50
      + (p.up === null ? 100 : p.up < 1e6 ? 600 : p.up < 3e6 ? 150 : 0)
      + (p.fit.bootMs > 15000 ? 300 : p.fit.bootMs > 9000 ? 100 : 0);
    const warm = admitted.filter((p) => p.fit && p.fit.able && p.fit.ready).sort((a, b) => cost(a) - cost(b) || a.rank - b.rank);
    const cold = admitted.filter((p) => !warm.includes(p) && !(p.fit && !p.fit.able)).sort((a, b) => a.rank - b.rank);
    const line = [...warm, ...cold];
    for (const p of admitted) {
      const at = line.indexOf(p);
      const place = at + 1; // 0: not in the line
      const ahead = at < 0 ? warm.length : Math.min(at, warm.length); // warm servers before this player
      if (p.place === place && p.ahead === ahead) continue;
      p.place = place;
      p.ahead = ahead;
      try {
        p.ctl?.send(JSON.stringify({ t: 'place', place, of: line.length, warm: ahead }));
      } catch { /* gone already */ }
    }
  }

  #copyTo(peer) {
    if (!this.lastCopy || !peer.account || !peer.copy || peer.copy.closed || peer.copySeq === this.lastCopy.header.seq) return;
    peer.copySeq = this.lastCopy.header.seq;
    peer.copy.sendText(JSON.stringify(this.lastCopy.header));
    for (const body of this.lastCopy.bodies) peer.copy.send(body);
  }

  async #answer({ offer, answer }) {
    if (this.peers.size >= 64) return;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    // fit: what the player's browser said it can do; rtt (ms) and up (bits a second): what was measured.
    const peer = { pc, account: null, id: null, rank: 0, place: null, conns: new Set(), ctl: null, copy: null, copySeq: null, fit: null, rtt: null, up: null, probe: null };
    this.peers.add(peer);
    const drop = () => {
      if (!this.peers.delete(peer)) return;
      for (const c of peer.conns) c.close();
      pc.close();
      if (peer.account) this.#places();
      this.onchange?.();
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) drop();
    };
    // An offer that never becomes a connection is forgotten.
    setTimeout(() => {
      if (pc.connectionState !== 'connected') drop();
    }, 30000);
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'ctl') this.#control(peer, channel, drop);
      else if (channel.label === 'copy') {
        peer.copy = streamOf(channel);
        peer.copy.onopen = () => this.#copyTo(peer);
        // What comes back on this channel is the player's upload probe: how fast it arrives is
        // how fast that player's browser could send the world's traffic.
        peer.copy.ontext = (text) => {
          try {
            const m = JSON.parse(text);
            if (m.t === 'probe' && peer.probe && m.id === peer.probe.id) {
              peer.probe.t0 = performance.now();
              peer.probe.got = 0;
            }
          } catch { /* not a probe */ }
        };
        peer.copy.ondata = (bytes) => {
          const probe = peer.probe;
          if (!probe || !probe.t0) return;
          probe.got += bytes.length;
          if (probe.got < probe.bytes) return;
          peer.up = Math.round((probe.bytes * 8000) / Math.max(1, performance.now() - probe.t0));
          peer.probe = null;
          this.#places();
        };
      } else this.#game(peer, channel);
    };
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    answer(pc.localDescription.toJSON());
  }

  #control(peer, channel, drop) {
    let hostNonce = null;
    let key = null;
    peer.ctl = channel;
    const send = (m) => channel.readyState === 'open' && channel.send(JSON.stringify(m));
    channel.onmessage = async (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return drop();
      }
      try {
        if (m.t === 'fit' && peer.account) {
          peer.fit = { able: m.able !== false, ready: m.ready === true, bootMs: Number(m.bootMs) || 0 };
          if (peer.fit.able && peer.up === null && !peer.probe && peer.copy) {
            peer.probe = { id: nonce(), bytes: 262144, got: 0, t0: 0 };
            send({ t: 'probe', id: peer.probe.id, bytes: peer.probe.bytes });
          }
          this.#places();
        } else if (m.t === 'info') {
          // Anyone may ask how full the world is; the host counts itself.
          const online = this.server.online ? await this.server.online() : this.players + 1;
          send({ t: 'info', online, cap: this.cap, kind: this.kind });
        } else if (m.t === 'hello' && !hostNonce && typeof m.key === 'string' && typeof m.nonce === 'string') {
          key = m.key;
          hostNonce = nonce();
          send({ t: 'challenge', nonce: hostNonce, kind: this.kind, hostKey: this.identity.publicKey, sig: await this.identity.sign(hostMessage(this.name, m.nonce)) });
        } else if (m.t === 'proof' && hostNonce && !peer.account) {
          if (!(await verify(key, m.sig, guestMessage(this.name, hostNonce)))) {
            send({ t: 'refused', why: 'The proof of identity did not check out.' });
            return drop();
          }
          if (this.players + 1 >= this.cap) {
            send({ t: 'refused', why: 'The world is full.' });
            return drop();
          }
          peer.id = await fingerprint(key);
          // A world that is still starting here answers once it is up.
          const account = await this.server.member(peer.id);
          peer.rank = ++this.joined;
          peer.account = account;
          send({ t: 'welcome', world: this.name, account, realm: this.realm, players: this.players, rank: peer.rank, copies: this.kind === 'browser' });
          this.#copyTo(peer);
          this.#places();
          this.onchange?.();
          this.onjoin?.();
        }
      } catch (err) {
        send({ t: 'refused', why: String((err && err.message) || err) });
        drop();
      }
    };
  }

  // A game connection of a player who is in: straight through to the server in this tab.
  #game(peer, channel) {
    const port = Number(/^g(\d+)$/.exec(channel.label)?.[1]);
    if (!peer.account || !PORTS.has(port)) return channel.close();
    const remote = streamOf(channel);
    const local = this.server.connect(port);
    peer.conns.add(local);
    const pending = [];
    local.onopen = () => {
      for (const b of pending.splice(0)) local.send(b);
    };
    local.ondata = (bytes) => remote.send(bytes);
    local.onclose = () => {
      peer.conns.delete(local);
      remote.close();
    };
    remote.ondata = (bytes) => (local.open ? local.send(bytes) : pending.push(bytes));
    remote.onclose = () => {
      peer.conns.delete(local);
      local.close();
    };
  }
}

// ---- a player joining ---------------------------------------------------------------------------

const PIN = 'electrode:world-host:';

/**
 * Looks for a world by name and joins it.
 *   const guest = await WorldGuest.find(name, { identity, timeoutMs, onstatus });   null: nobody hosts it
 *   guest.account            { user, pass } on that world
 *   guest.rank               this player's place in the line of who carries the world on (1: first; 0: not in it)
 *   guest.report(fit)        what this browser can do for the world: { able, ready, bootMs }
 *   guest.hostId             the fingerprint of the host's key; guest.kind 'browser' | 'desktop'
 *   guest.connect(port)      a connection to the host's server, shaped like WorldServer.connect
 *   guest.oncopy = (copy) => …   the host's latest copy: { world, seq, at, names, final, files: { characters, realmd } }
 *   guest.onclose = (leaving) => …  the host went away (leaving: it said so first)
 */
export class WorldGuest {
  /** How many play in a world right now: { online, cap, kind }, or null when nobody is running it. */
  static peek(name, { timeoutMs = 7000, trackers } = {}) {
    return WorldGuest.find(name, { timeoutMs, trackers, peek: true });
  }

  static async find(name, { identity, timeoutMs = 9000, trackers, onstatus, peek = false } = {}) {
    const canon = canonName(name);
    const swarm = new TrackerSwarm(await worldTopic(canon), { trackers });
    const attempts = new Map(); // offer id -> { pc, ctl }
    const deadline = Date.now() + timeoutMs;
    try {
      if (!(await swarm.ready())) throw new Error('None of the public trackers could be reached, so worlds cannot be found right now.');
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearInterval(again);
          clearTimeout(giveUp);
          fn(value);
        };
        swarm.onanswer = async ({ offerId, answer }) => {
          const attempt = attempts.get(offerId);
          if (!attempt || attempt.answered) return;
          attempt.answered = true;
          try {
            await attempt.pc.setRemoteDescription(answer);
            const guest = await (peek ? WorldGuest.#ask(attempt) : WorldGuest.#enter(canon, identity, attempt, onstatus));
            attempts.delete(offerId);
            if (peek) attempt.pc.close();
            finish(resolve, guest);
          } catch (err) {
            attempt.pc.close();
            attempts.delete(offerId);
            if (err && err.fatal) finish(reject, err);
          }
        };
        // Offers reach peers the tracker picks, so a few go out, and again while nobody answers.
        const offer = async () => {
          const batch = [];
          for (let i = 0; i < 3; i++) {
            const pc = new RTCPeerConnection({ iceServers: ICE });
            const ctl = pc.createDataChannel('ctl');
            await pc.setLocalDescription(await pc.createOffer());
            batch.push({ pc, ctl });
          }
          await Promise.all(batch.map((a) => gathered(a.pc)));
          if (settled) return batch.forEach((a) => a.pc.close());
          const offers = batch.map((a) => {
            const id = String.fromCharCode(...crypto.getRandomValues(new Uint8Array(20)));
            attempts.set(id, a);
            return { id, offer: a.pc.localDescription.toJSON() };
          });
          swarm.announce(offers);
        };
        offer().catch((e) => finish(reject, e));
        const again = setInterval(() => {
          if (Date.now() + 2500 < deadline) offer().catch(() => {});
        }, 3000);
        const giveUp = setTimeout(() => {
          // Someone answered and is still letting this player in (a world that is just starting
          // answers once it is up): wait for that.
          const wait = () => ([...attempts.values()].some((a) => a.answered) && !settled ? setTimeout(wait, 500) : finish(resolve, null));
          wait();
        }, timeoutMs);
      });
    } finally {
      swarm.leave();
      for (const a of attempts.values()) a.pc.close();
    }
  }

  static #ask({ ctl }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The host did not answer.')), 8000);
      const ask = () => ctl.send(JSON.stringify({ t: 'info' }));
      if (ctl.readyState === 'open') ask();
      else ctl.onopen = ask;
      ctl.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.t !== 'info') return;
          clearTimeout(timer);
          resolve({ online: Number(m.online) || 0, cap: Number(m.cap) || 100, kind: m.kind === 'desktop' ? 'desktop' : 'browser' });
        } catch {
          reject(new Error('The host sent something unreadable.'));
        }
      };
      ctl.onclose = () => reject(new Error('The connection to the host closed.'));
    });
  }

  static #enter(name, identity, { pc, ctl }, onstatus) {
    return new Promise((resolve, reject) => {
      const myNonce = nonce();
      let hostChanged = false;
      let hostKind = 'browser';
      let hostId = '';
      // Long enough for a world that is only now starting on its new host.
      const timer = setTimeout(() => reject(new Error('The host did not finish the handshake.')), 60000);
      const fail = (message, fatal = false) => {
        clearTimeout(timer);
        const err = new Error(message);
        err.fatal = fatal;
        reject(err);
      };
      const send = (m) => ctl.send(JSON.stringify(m));
      const hello = () => {
        onstatus?.('Found the world. Signing in…');
        send({ t: 'hello', v: 1, key: identity.publicKey, nonce: myNonce });
      };
      if (ctl.readyState === 'open') hello();
      else ctl.onopen = hello;
      ctl.onmessage = async (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return fail('The host sent something unreadable.');
        }
        if (m.t === 'challenge') {
          if (!(await verify(m.hostKey, m.sig, hostMessage(name, myNonce)))) return fail('The host could not prove who it is.');
          const host = await fingerprint(m.hostKey);
          hostId = host;
          let pinned = null;
          try {
            pinned = localStorage.getItem(PIN + name);
          } catch { /* no storage: nothing remembered */ }
          // A world's host changes (a world is carried on by another player), so another key is
          // not refused; the player is told.
          hostChanged = Boolean(pinned && pinned !== host);
          if (hostChanged) onstatus?.(`"${name}" is run by a different player than last time.`);
          hostKind = m.kind === 'desktop' ? 'desktop' : 'browser';
          try {
            localStorage.setItem(PIN + name, host);
          } catch { /* not remembered */ }
          send({ t: 'proof', sig: await identity.sign(guestMessage(name, m.nonce)) });
        } else if (m.t === 'welcome') {
          clearTimeout(timer);
          const guest = new WorldGuest(name, pc, ctl, m);
          guest.kind = hostKind;
          guest.hostId = hostId;
          guest.hostChanged = hostChanged;
          resolve(guest);
        } else if (m.t === 'refused') {
          fail('The host refused: ' + m.why, true);
        }
      };
      ctl.onclose = () => fail('The connection to the host closed.');
    });
  }

  constructor(name, pc, ctl, welcome) {
    this.name = name;
    this.pc = pc;
    this.account = welcome.account;
    this.realm = welcome.realm;
    this.rank = Number(welcome.rank) || 1; // the place in the line; 0: not in it
    this.warmAhead = 0; // players before this one whose browsers keep a server warm
    this.copies = welcome.copies === true; // this host sends copies of the world
    this.ctl = ctl;
    this.copyChannel = null;
    this.onclose = null;
    this.oncopy = null;
    this.closed = false;
    let leaving = false;
    const gone = () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.(leaving);
    };
    ctl.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === 'leaving') leaving = true;
        else if (m.t === 'place') {
          this.rank = Number(m.place) || 0;
          this.warmAhead = Number(m.warm) || 0;
        } else if (m.t === 'probe' && this.copyChannel && Number(m.bytes) > 0 && Number(m.bytes) <= 1 << 20) {
          // The host measures how fast this browser can send.
          this.copyChannel.sendText(JSON.stringify({ t: 'probe', id: m.id, bytes: Number(m.bytes) }));
          this.copyChannel.send(new Uint8Array(Number(m.bytes)));
        }
      } catch { /* not for us */ }
    };
    ctl.onclose = gone;
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) gone();
    };
    if (this.copies) this.#receiveCopies();
  }

  // The copy channel: a header, then each file's bytes in the header's order.
  #receiveCopies() {
    const channel = streamOf(this.pc.createDataChannel('copy'));
    this.copyChannel = channel;
    let header = null;
    let chunks = [];
    let got = 0;
    channel.ontext = (text) => {
      try {
        header = JSON.parse(text);
        chunks = [];
        got = 0;
      } catch {
        header = null;
      }
    };
    channel.ondata = async (bytes) => {
      if (!header) return;
      chunks.push(bytes);
      got += bytes.length;
      const total = header.parts.reduce((sum, p) => sum + p.bytes, 0);
      if (got < total) return;
      const h = header;
      header = null;
      const all = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      try {
        const files = {};
        let off = 0;
        for (const p of h.parts) {
          files[p.name] = await unpack(all.subarray(off, off + p.bytes));
          if (files[p.name].length !== p.size) throw new Error('a copied file has the wrong size');
          off += p.bytes;
        }
        this.oncopy?.({ world: h.world, seq: h.seq, at: h.at, names: h.names || {}, final: h.final === true, files });
      } catch (e) {
        console.warn('world copy: not kept', e);
      }
    };
  }

  connect(port) {
    return streamOf(this.pc.createDataChannel('g' + port));
  }

  /** Tells the host what this browser can do for the world: { able, ready, bootMs }. */
  report(fit) {
    try {
      this.ctl.send(JSON.stringify({ t: 'fit', ...fit }));
    } catch { /* the host is gone */ }
  }

  leave() {
    this.closed = true;
    this.pc.close();
  }
}

/** Forget which host a world name belongs to (after the player was told and chose to). */
export function forgetWorldHost(name) {
  try {
    localStorage.removeItem(PIN + canonName(name));
  } catch { /* nothing stored */ }
}

export { toHex };
