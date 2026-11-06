// The page's handle on the world server that runs in this tab (server-worker.js).

export class WorldServer extends EventTarget {
  constructor() {
    super();
    this.worker = new Worker(new URL('../server-worker.js', import.meta.url));
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    this.worker.onerror = (e) => this.#fail(new Error(e.message || 'the world server worker failed to load'));
    this.connections = new Map();
    this.commands = new Map();
    this.members = new Map();
    this.nextKey = 1;
    this.nextTag = 1;
    this.ready = false;
    this.account = null;
    this.started = null;
  }

  /** Starts the world. Resolves with the player's account once the world accepts logins. */
  start(options = {}) {
    if (!this.started) {
      this.started = new Promise((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
      });
      this.worker.postMessage({ cmd: 'start', options });
    }
    return this.started;
  }

  /**
   * Starts the server as a standby of a world someone else runs: up, with the world as this
   * browser last stored it, nobody on it. Resolves { bootMs, seq } when it is up.
   */
  standby(options = {}) {
    return new Promise((resolve, reject) => {
      this.resolveStandby = resolve;
      this.rejectStandby = reject;
      this.worker.postMessage({ cmd: 'start', options: { ...options, standby: true } });
    });
  }

  /** A standby takes the latest stored copy: resolves { result: 'ok' | 'stale' | …, seq }. */
  adopt() {
    return new Promise((resolve) => {
      const tag = this.nextTag++;
      this.commands.set(tag, resolve);
      this.worker.postMessage({ cmd: 'adopt', tag });
    });
  }

  /** A standby becomes the world. Resolves with the player's account, like start(). */
  takeover(options = {}) {
    if (!this.started) {
      this.started = new Promise((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
      });
      this.worker.postMessage({ cmd: 'takeover', options });
    }
    return this.started;
  }

  /** A connection to one of the server's ports, standing in for a socket. */
  connect(port) {
    const key = this.nextKey++;
    const conn = {
      key,
      onopen: null,
      ondata: null,
      onclose: null,
      open: false,
      closed: false,
      send: (bytes) => {
        if (conn.closed) return;
        const copy = bytes.slice ? bytes.slice() : new Uint8Array(bytes);
        this.worker.postMessage({ cmd: 'data', key, bytes: copy }, [copy.buffer]);
      },
      close: () => {
        if (conn.closed) return;
        conn.closed = true;
        this.connections.delete(key);
        this.worker.postMessage({ cmd: 'close', key });
      },
    };
    this.connections.set(key, conn);
    this.worker.postMessage({ cmd: 'open', key, port });
    return conn;
  }

  /** A server console command; resolves with {ok, text}. */
  command(text) {
    return new Promise((resolve) => {
      const tag = this.nextTag++;
      this.commands.set(tag, resolve);
      this.worker.postMessage({ cmd: 'command', tag, text });
    });
  }

  /** The game account of another player, by the fingerprint of their key; made on first sight. */
  async member(id) {
    // A world that is still starting answers once it is up.
    if (!this.started) throw new Error('the world is not started');
    await this.started;
    return new Promise((resolve, reject) => {
      const tag = this.nextTag++;
      this.members.set(tag, { resolve, reject });
      this.worker.postMessage({ cmd: 'member', tag, id });
    });
  }

  /** The world as last saved, for other players to keep: { seq, at, names, files } or null. */
  copy() {
    return new Promise((resolve) => {
      const tag = this.nextTag++;
      this.commands.set(tag, resolve);
      this.worker.postMessage({ cmd: 'copy', tag });
    });
  }

  /** Saves now; resolves when the save is stored (or after 10 s). */
  saveNow() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.removeEventListener('saved', done);
        resolve();
      };
      const timer = setTimeout(done, 10000);
      this.addEventListener('saved', done);
      this.worker.postMessage({ cmd: 'save' });
    });
  }

  /** Development: file-system calls the server made since the last call (start with { fsStats: true }). */
  fsStats() {
    return new Promise((resolve) => {
      const tag = this.nextTag++;
      this.commands.set(tag, resolve);
      this.worker.postMessage({ cmd: 'fsstats', tag });
    });
  }

  save() {
    this.worker.postMessage({ cmd: 'save' });
  }

  stop() {
    this.worker.postMessage({ cmd: 'stop' });
  }

  #fail(error) {
    if (this.rejectStart && !this.ready) this.rejectStart(error);
    if (this.rejectStandby && !this.isStandby) this.rejectStandby(error);
    this.dispatchEvent(new CustomEvent('error', { detail: error }));
  }

  #onMessage(m) {
    switch (m.type) {
      case 'status':
        this.dispatchEvent(new CustomEvent('status', { detail: m.text }));
        break;
      case 'log':
        this.dispatchEvent(new CustomEvent('log', { detail: m.lines }));
        break;
      case 'ready':
        this.ready = true;
        this.fresh = m.fresh === true; // this start made the world new (no characters were stored for it)
        this.account = m.account;
        this.resolveStart?.(m.account);
        this.dispatchEvent(new CustomEvent('ready', { detail: m.account }));
        break;
      case 'standby':
        this.isStandby = true;
        this.resolveStandby?.({ bootMs: m.bootMs, seq: m.seq });
        break;
      case 'adopted':
        this.commands.get(m.tag)?.({ result: m.result, seq: m.seq });
        this.commands.delete(m.tag);
        break;
      case 'opened': {
        const conn = this.connections.get(m.key);
        if (!conn) break;
        if (m.ok) {
          conn.open = true;
          conn.onopen?.();
        } else {
          conn.closed = true;
          this.connections.delete(m.key);
          conn.onclose?.(false);
        }
        break;
      }
      case 'data':
        this.connections.get(m.key)?.ondata?.(m.bytes);
        break;
      case 'closed': {
        const conn = this.connections.get(m.key);
        if (!conn) break;
        conn.closed = true;
        this.connections.delete(m.key);
        conn.onclose?.(true);
        break;
      }
      case 'command':
        this.commands.get(m.tag)?.({ ok: m.ok, text: m.text });
        this.commands.delete(m.tag);
        break;
      case 'member': {
        const waiter = this.members.get(m.tag);
        this.members.delete(m.tag);
        if (waiter) m.error ? waiter.reject(new Error(m.error)) : waiter.resolve(m.account);
        break;
      }
      case 'fsstats':
        this.commands.get(m.tag)?.(m.stats);
        this.commands.delete(m.tag);
        break;
      case 'copy':
        this.commands.get(m.tag)?.(m.copy);
        this.commands.delete(m.tag);
        break;
      case 'saved':
        this.dispatchEvent(new CustomEvent('saved', { detail: m.at }));
        break;
      case 'stopped':
        this.dispatchEvent(new CustomEvent('stopped'));
        break;
      case 'error':
        this.#fail(new Error(m.message));
        break;
    }
  }
}
