// Finding each other without a server of our own: public WebTorrent trackers pass the first
// WebRTC messages (an offer and its answer) between browsers that announce the same topic.
// After that the browsers talk directly; nothing of the game goes through a tracker.
//
// The trackers are run by volunteers for WebTorrent. They see the topic (a hash of the world's
// name) and the connection details in an offer, which include the sender's IP address.

export const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

const latin1 = (bytes) => String.fromCharCode(...bytes);
const randomId = () => latin1(crypto.getRandomValues(new Uint8Array(20)));

/**
 * One peer's place in a topic, on every tracker that answers.
 *   swarm.onoffer  = ({ from, offerId, offer, answer(sdp) }) => …   an offer from another peer
 *   swarm.onanswer = ({ from, offerId, answer }) => …               the answer to one of ours
 *   swarm.announce(offers)   offers: [{ id, offer }]; an empty list only keeps the place
 *   swarm.leave()            tell the trackers and close
 */
export class TrackerSwarm {
  constructor(topic, { trackers = TRACKERS } = {}) {
    this.topic = latin1(topic);
    this.peerId = randomId();
    this.urls = trackers;
    this.sockets = new Map(); // url -> { ws, open, timer }
    this.onoffer = null;
    this.onanswer = null;
    this.seen = new Set(); // offers and answers already handed over (the trackers repeat each other)
    this.closed = false;
    this.lastOffers = [];
    for (const url of this.urls) this.#connect(url);
  }

  get connected() {
    let n = 0;
    for (const s of this.sockets.values()) if (s.open) n++;
    return n;
  }

  /** Resolves once at least one tracker is connected (or after `ms`), with the number connected. */
  ready(ms = 5000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.connected || this.closed || Date.now() - t0 > ms) resolve(this.connected);
        else setTimeout(tick, 100);
      };
      tick();
    });
  }

  announce(offers = []) {
    this.lastOffers = offers;
    for (const [url, s] of this.sockets) if (s.open) this.#send(url, offers, 'started');
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    for (const [url, s] of this.sockets) {
      clearTimeout(s.timer);
      clearTimeout(s.retry);
      if (s.open) {
        try {
          this.#send(url, [], 'stopped');
        } catch { /* closing anyway */ }
      }
      try {
        s.ws.close();
      } catch { /* closed already */ }
    }
    this.sockets.clear();
  }

  #send(url, offers, event) {
    const s = this.sockets.get(url);
    if (!s || !s.open) return;
    s.ws.send(JSON.stringify({
      action: 'announce',
      info_hash: this.topic,
      peer_id: this.peerId,
      numwant: offers.length,
      uploaded: 0,
      downloaded: 0,
      left: 1,
      event,
      offers: offers.map((o) => ({ offer_id: o.id, offer: o.offer })),
    }));
  }

  #connect(url) {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    const s = { ws, open: false, timer: 0, retry: 0, tries: (this.sockets.get(url)?.tries || 0) + 1 };
    this.sockets.set(url, s);
    ws.onopen = () => {
      s.open = true;
      s.tries = 0;
      this.#send(url, this.lastOffers, 'started');
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.info_hash !== this.topic || m.peer_id === this.peerId) return;
      if (m.interval && !s.timer) {
        // Keep the place: announce again a little before the tracker would drop it.
        const every = Math.max(30, Math.min(120, m.interval)) * 1000 * 0.8;
        s.timer = setInterval(() => this.#send(url, [], 'update'), every);
      }
      if (m.offer && m.offer_id && m.peer_id) {
        const key = 'o' + m.peer_id + m.offer_id;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.onoffer?.({
          from: m.peer_id,
          offerId: m.offer_id,
          offer: m.offer,
          answer: (answer) => {
            if (!s.open) return;
            ws.send(JSON.stringify({ action: 'announce', info_hash: this.topic, peer_id: this.peerId, to_peer_id: m.peer_id, offer_id: m.offer_id, answer }));
          },
        });
      } else if (m.answer && m.offer_id && m.peer_id) {
        const key = 'a' + m.offer_id;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.onanswer?.({ from: m.peer_id, offerId: m.offer_id, answer: m.answer });
      }
    };
    const down = () => {
      if (!s.open && s.done) return;
      s.open = false;
      s.done = true;
      clearInterval(s.timer);
      s.timer = 0;
      if (this.closed) return;
      // Try again, slower each time, while the page still wants the place.
      s.retry = setTimeout(() => this.#connect(url), Math.min(60000, 2000 * 2 ** Math.min(5, s.tries)));
    };
    ws.onclose = down;
    ws.onerror = down;
  }
}
