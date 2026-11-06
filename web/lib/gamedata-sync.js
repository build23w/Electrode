// The game client's reads of game data and of its AddOns folder, answered in the page from the
// player's own files.
//
// The client asks for GET/HEAD /data/<name> and GET /data/__index (the game archives), and
// GET /addons/__index and /addons/<path> (its AddOns folder), by synchronous XMLHttpRequest, by
// fetch and by ordinary XMLHttpRequest. This module answers all three: it replaces
// window.XMLHttpRequest with a subclass and wraps window.fetch, and leaves every other request
// to the browser. Nothing goes to the network or to the service worker.
//
// How: a worker (gamedata-worker.js) reads from the Files it is given. An ordinary request is a
// message to it and a message back. For a blocking request the page posts the request and spins
// on a shared flag until the worker has put the answer into shared memory; that needs
// SharedArrayBuffer, so the page must be cross-origin isolated (sw.js sees to that).
//
//   const reader = await installGameDataReader({ addons });  // before the game client starts
//     files   [{ name, file }]: the archives; left out, getArchiveFiles() (lib/gamefiles.js)
//     addons  [{ path, file }]: the AddOns folder's files, path "<Addon>/<...>" with forward
//             slashes (lib/addons.js: getAddonFiles()); left out, an empty folder
//   reader.ready                 { archives, addonFiles, error }: error is set while there are no archives
//   reader.read(method, path)    -> { status, body, type, cache }   the blocking read, callable directly
//   reader.request(method, path) -> Promise<{ status, body, type, cache }>   the ordinary one
//   await reader.reset({ files, addons })   after a source changed: files left out is
//                                getArchiveFiles() again, addons left out keeps the ones there are
//   await reader.setAddons(addons)          other addon files only; the game reads its AddOns
//                                folder again at its next interface load
//   reader.uninstall()
//
// Only requests made by the page itself are answered: a worker's own fetch, or a URL set on an
// element, still goes to the network. The browser's own fetch stays reachable as fetch.native.

import { getArchiveFiles } from './gamefiles.js';

// Slots of the control array, shared with gamedata-worker.js.
const STATE = 0;
const SEQ = 1;
const STATUS = 2;
const TOTAL = 3;
const LENGTH = 4;
const WANTED = 5;
const TYPE = 6;
const CACHE = 7;
const WAITING = 0;
const DONE = 2;

const TIMEOUT_MS = 60000;

// The content types and cache lines an answer can carry, by number, for the shared memory.
// The same two lists are in gamedata-worker.js.
const TYPES = [null, 'application/octet-stream', 'image/x-blp', 'audio/mpeg', 'application/json', 'text/plain; charset=utf-8'];
const CACHES = [null, 'private, max-age=31536000, immutable', 'private, max-age=86400', 'no-store'];

// The headers these routes carried when a server or the service worker answered them.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

let installed = null;

function latin1(bytes) {
  // One character per byte, as the client expects of its text responses.
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return out;
}

function headersOf(answer) {
  const headers = { ...ISOLATION };
  if (answer.type) headers['Content-Type'] = answer.type;
  if (answer.cache) headers['Cache-Control'] = answer.cache;
  return headers;
}

// The files to read: the caller's list, else the active source's; none when there is none.
async function filesFor(given) {
  if (given !== undefined) return { files: given || [], problem: null };
  try {
    return { files: await getArchiveFiles(), problem: null };
  } catch (e) {
    return { files: [], problem: String(e && e.message ? e.message : e) };
  }
}

export async function installGameDataReader({ files, addons, bufferBytes = 4 << 20 } = {}) {
  if (installed) return installed;
  if (typeof SharedArrayBuffer !== 'function' || !self.crossOriginIsolated) {
    throw new Error('The page is not cross-origin isolated, so the game data reader cannot start.');
  }
  const control = new Int32Array(new SharedArrayBuffer(8 * 4));
  const buffer = new Uint8Array(new SharedArrayBuffer(bufferBytes));
  const worker = new Worker(new URL('./gamedata-worker.js', import.meta.url));

  let onReady = null;
  const waiting = new Map(); // ordinary requests in flight, by id
  let nextId = 0;
  worker.onmessage = ({ data }) => {
    if (!data) return;
    if (data.type === 'ready') {
      if (onReady) onReady({ archives: data.archives, addonFiles: data.addonFiles || 0, error: data.error });
    } else if (data.type === 'response') {
      const settle = waiting.get(data.id);
      waiting.delete(data.id);
      if (settle) settle({ status: data.status, body: data.body ? new Uint8Array(data.body) : null, type: data.contentType, cache: data.cacheControl });
    }
  };
  let failed = null;
  worker.onerror = (e) => {
    failed = new Error(e.message || 'The game data reader stopped.');
    if (onReady) onReady({ archives: 0, addonFiles: 0, error: failed.message });
    for (const settle of waiting.values()) settle({ status: 500, body: null, type: null, cache: null });
    waiting.clear();
  };
  const whenReady = () => new Promise((resolve) => { onReady = resolve; });

  let source = await filesFor(files);
  let pending = whenReady();
  worker.postMessage({ type: 'init', control: control.buffer, buffer: buffer.buffer, files: source.files, addons: addons || [] });
  let ready = await pending;
  if (source.problem && ready.error) ready = { ...ready, archives: 0, error: source.problem };

  // An ordinary request: a message there and a message back.
  function ask(method, hit) {
    if (failed) return Promise.resolve({ status: 500, body: null, type: null, cache: null });
    return new Promise((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      worker.postMessage({ type: 'request', id, kind: hit.kind, method, path: hit.path, query: hit.query });
    });
  }

  let seq = 0;
  // A blocking request: post it, then wait on the shared flag, since the page cannot take a
  // message while it waits.
  function askBlocking(method, hit) {
    seq = (seq + 1) | 0;
    Atomics.store(control, WANTED, seq);
    Atomics.store(control, STATE, WAITING);
    Atomics.notify(control, STATE); // releases a worker still holding an answer nobody took
    worker.postMessage({ type: 'read', seq, kind: hit.kind, method, path: hit.path, query: hit.query });
    const deadline = performance.now() + TIMEOUT_MS;
    let body = null;
    let at = 0;
    for (;;) {
      let state;
      let spins = 0;
      while ((state = Atomics.load(control, STATE)) === WAITING || Atomics.load(control, SEQ) !== seq) {
        if ((++spins & 0xfffff) === 0 && performance.now() > deadline) return { status: 0, body: null, type: null, cache: null };
      }
      const n = Atomics.load(control, LENGTH);
      if (body === null) body = new Uint8Array(Atomics.load(control, TOTAL));
      if (n) body.set(buffer.subarray(0, n), at);
      at += n;
      if (state === DONE) break;
      Atomics.store(control, STATE, WAITING);
      Atomics.notify(control, STATE);
    }
    const status = Atomics.load(control, STATUS);
    return {
      status,
      body: body.length || status === 200 ? body : null,
      type: TYPES[Atomics.load(control, TYPE)] || null,
      cache: CACHES[Atomics.load(control, CACHE)] || null,
    };
  }

  const origin = self.location.origin;

  function route(url) {
    let u;
    try {
      u = new URL(url, self.location.href);
    } catch (e) {
      return null;
    }
    if (u.origin !== origin) return null;
    const query = u.search ? u.search.slice(1) : null;
    if (u.pathname.startsWith('/data/')) return { kind: 'data', path: u.pathname, query, url: u.href };
    if (u.pathname.startsWith('/addons/')) return { kind: 'addons', path: u.pathname, query, url: u.href };
    return null;
  }

  // The same two reads for a caller that has the path: "/data/..." or "/addons/...", with its
  // query if there is one.
  const missing = { status: 404, body: null, type: null, cache: null };
  const read = (method, path) => {
    const hit = route(path);
    return hit ? askBlocking(String(method).toUpperCase(), hit) : missing;
  };
  const request = (method, path) => {
    const hit = route(path);
    return hit ? ask(String(method).toUpperCase(), hit) : Promise.resolve(missing);
  };

  // ---- fetch ----

  const nativeFetch = self.fetch;

  function gameDataFetch(input, init) {
    let url;
    let method = 'GET';
    let signal = null;
    try {
      if (typeof Request === 'function' && input instanceof Request) {
        url = input.url;
        method = input.method;
        signal = input.signal;
      } else {
        url = String(input);
      }
      if (init && init.method) method = String(init.method);
      if (init && init.signal) signal = init.signal;
    } catch (e) {
      return nativeFetch.apply(self, arguments);
    }
    const hit = route(url);
    if (!hit) return nativeFetch.apply(self, arguments);
    if (signal && signal.aborted) return Promise.reject(signal.reason || new DOMException('The request was aborted.', 'AbortError'));
    return ask(method.toUpperCase(), hit).then((answer) => new Response(answer.body, { status: answer.status, headers: headersOf(answer) }));
  }
  gameDataFetch.native = nativeFetch;

  // ---- XMLHttpRequest ----

  const Native = self.XMLHttpRequest;
  const local = new WeakMap(); // the requests answered here, with their state
  const utf8 = new TextDecoder();

  class GameDataXMLHttpRequest extends Native {
    open(method, url, async, ...rest) {
      local.delete(this);
      const hit = route(String(url));
      if (!hit) return arguments.length < 3 ? super.open(method, url) : super.open(method, url, async, ...rest);
      local.set(this, {
        blocking: arguments.length >= 3 && async === false,
        method: String(method).toUpperCase(),
        hit,
        answer: null,
        text: null,
        mime: '',
        type: '',
        buffer: null,
        state: 1,
        sent: false,
      });
      if (!local.get(this).blocking) this.dispatchEvent(new Event('readystatechange'));
      return undefined;
    }

    send(body) {
      const mine = local.get(this);
      if (!mine) return super.send(body);
      if (mine.sent) throw new DOMException('The request was already sent.', 'InvalidStateError');
      mine.sent = true;
      const finish = (answer) => {
        if (local.get(this) !== mine || mine.state === 4) return; // opened again, or aborted
        mine.answer = answer;
        mine.state = 4;
        const size = answer.body ? answer.body.length : 0;
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: size, total: size }));
        this.dispatchEvent(new ProgressEvent('loadend', { lengthComputable: true, loaded: size, total: size }));
      };
      if (mine.blocking) {
        const answer = askBlocking(mine.method, mine.hit);
        if (answer.status === 0) throw new DOMException('The game data reader did not answer.', 'NetworkError');
        finish(answer);
      } else {
        ask(mine.method, mine.hit).then(finish);
      }
      return undefined;
    }

    abort() {
      const mine = local.get(this);
      if (!mine) return super.abort();
      const inFlight = mine.sent && mine.state !== 4;
      mine.state = 4;
      mine.answer = null;
      if (inFlight) {
        this.dispatchEvent(new ProgressEvent('abort'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      }
      local.delete(this);
      return undefined;
    }

    overrideMimeType(type) {
      const mine = local.get(this);
      if (mine) mine.mime = String(type).toLowerCase();
      else super.overrideMimeType(type);
    }

    setRequestHeader(name, value) {
      if (!local.has(this)) super.setRequestHeader(name, value);
    }

    getResponseHeader(name) {
      const mine = local.get(this);
      if (!mine) return super.getResponseHeader(name);
      if (!mine.answer) return null;
      const want = String(name).toLowerCase();
      for (const [k, v] of Object.entries(headersOf(mine.answer))) if (k.toLowerCase() === want) return v;
      return null;
    }

    getAllResponseHeaders() {
      const mine = local.get(this);
      if (!mine) return super.getAllResponseHeaders();
      if (!mine.answer) return '';
      return Object.entries(headersOf(mine.answer)).map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`).join('');
    }

    get readyState() {
      const mine = local.get(this);
      return mine ? mine.state : super.readyState;
    }

    get status() {
      const mine = local.get(this);
      return mine ? (mine.answer ? mine.answer.status : 0) : super.status;
    }

    get statusText() {
      return local.has(this) ? '' : super.statusText;
    }

    get responseURL() {
      const mine = local.get(this);
      return mine ? (mine.answer ? mine.hit.url : '') : super.responseURL;
    }

    get responseType() {
      const mine = local.get(this);
      return mine ? mine.type : super.responseType;
    }

    set responseType(value) {
      const mine = local.get(this);
      if (!mine) super.responseType = value;
      else if (!mine.blocking && ['', 'text', 'arraybuffer', 'blob', 'json'].includes(value)) mine.type = value;
    }

    get responseText() {
      const mine = local.get(this);
      if (!mine) return super.responseText;
      if (mine.type !== '' && mine.type !== 'text') throw new DOMException('responseText is only for text responses.', 'InvalidStateError');
      if (!mine.answer || !mine.answer.body) return '';
      // One character per byte when the caller asked for that, as the game client does.
      if (mine.text === null) mine.text = mine.mime.includes('x-user-defined') ? latin1(mine.answer.body) : utf8.decode(mine.answer.body);
      return mine.text;
    }

    get response() {
      const mine = local.get(this);
      if (!mine) return super.response;
      if (mine.type === '' || mine.type === 'text') return this.responseText;
      if (!mine.answer || !mine.answer.body) return null;
      const body = mine.answer.body;
      if (mine.type === 'arraybuffer') {
        if (mine.buffer === null) {
          const whole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
          mine.buffer = whole ? body.buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        }
        return mine.buffer;
      }
      if (mine.type === 'blob') return new Blob([body], { type: mine.answer.type || '' });
      try {
        return JSON.parse(utf8.decode(body));
      } catch (e) {
        return null;
      }
    }
  }

  self.XMLHttpRequest = GameDataXMLHttpRequest;
  self.fetch = gameDataFetch;

  installed = {
    get ready() {
      return ready;
    },
    read,
    request,
    async reset({ files: given, addons: list } = {}) {
      source = await filesFor(given);
      pending = whenReady();
      worker.postMessage({ type: 'reset', files: source.files, addons: list });
      ready = await pending;
      if (source.problem && ready.error) ready = { ...ready, archives: 0, error: source.problem };
      return ready;
    },
    async setAddons(list) {
      pending = whenReady();
      worker.postMessage({ type: 'addons', addons: list || [] });
      const now = await pending;
      ready = source.problem && now.error ? { ...now, archives: 0, error: source.problem } : now;
      return ready;
    },
    uninstall() {
      if (self.XMLHttpRequest === GameDataXMLHttpRequest) self.XMLHttpRequest = Native;
      if (self.fetch === gameDataFetch) self.fetch = nativeFetch;
      worker.terminate();
      installed = null;
    },
  };
  return installed;
}
