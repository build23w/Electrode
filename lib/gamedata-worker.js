// Answers the page's game-data requests (see gamedata-sync.js) from the Files the page hands it:
// the archives of the player's own game folder, read in place, and the files of the addons that
// are on. A dedicated worker, so the reads are synchronous and off the page's thread.
//
// in:  { type: 'init', control, buffer, files, addons }  two SharedArrayBuffers, [{ name, file }]
//                                                        and [{ path, file }]
//      { type: 'reset', files, addons }                  other archives, or none; addons left out
//                                                        keeps the ones there are
//      { type: 'addons', addons }                        other addon files only
//      { type: 'read', seq, kind, method, path, query }  a blocking request: answered through shared memory
//      { type: 'request', id, kind, method, path, query } an ordinary request: answered by a message
// out: { type: 'ready', archives, addonFiles, error }    after init, reset and addons
//      { type: 'response', id, status, body, contentType, cacheControl }
// kind is 'data' or 'addons'; path is the URL's path (/data/... or /addons/...), query the text
// after its "?".

'use strict';

importScripts('mpq.js');

const { Chain, MpqError, dataRoute, addonsRoute, addonFolder, statusOf } = self.ElectrodeMpq;

// Slots of the control array, shared with gamedata-sync.js.
const STATE = 0; // 0 waiting, 1 a part is in the buffer and more follow, 2 the last part is in the buffer
const SEQ = 1; // the request this answer belongs to
const STATUS = 2;
const TOTAL = 3; // the whole body's length
const LENGTH = 4; // the length of the part in the buffer
const WANTED = 5; // the blocking request the page is waiting for now
const TYPE = 6; // the answer's content type, as an index into TYPES
const CACHE = 7; // its cache line, as an index into CACHES
const MORE = 1;
const DONE = 2;

// The content types and cache lines an answer can carry, by number, for the shared memory.
// The same two lists are in gamedata-sync.js.
const TYPES = [null, 'application/octet-stream', 'image/x-blp', 'audio/mpeg', 'application/json', 'text/plain; charset=utf-8'];
const CACHES = [null, 'private, max-age=31536000, immutable', 'private, max-age=86400', 'no-store'];

let control = null;
let buffer = null;
let files = [];
let folder = null; // the AddOns folder the game sees, or null for an empty one
let chainPromise = null;
let answered = 0; // the last blocking request dealt with
const deferred = []; // ordinary requests put aside while the page is blocked

class NotReady extends Error {}

const reader = new FileReaderSync();

function syncSource(name, file) {
  return {
    name,
    size: file.size,
    read: (offset, length) => new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + length))),
  };
}

async function openChain() {
  const sources = files.filter((f) => f && f.file && /\.mpq$/i.test(f.name)).map((f) => syncSource(f.name, f.file));
  if (sources.length === 0) throw new NotReady('no game files are available');
  let chain;
  try {
    chain = await Chain.open(sources);
  } catch (e) {
    if (e instanceof MpqError && e.kind === 'notmpq') throw new NotReady(e.message);
    throw e;
  }
  // Built now, so the first request for the index does not wait for it.
  await chain.indexJson();
  return chain;
}

function getChain() {
  if (!chainPromise) {
    const opening = openChain();
    chainPromise = opening;
    opening.catch(() => {
      if (chainPromise === opening) chainPromise = null;
    });
  }
  return chainPromise;
}

async function prepare() {
  const addonFiles = folder ? folder.paths.length : 0;
  try {
    const chain = await getChain();
    postMessage({ type: 'ready', archives: chain.archives.length, addonFiles, error: null });
  } catch (e) {
    postMessage({ type: 'ready', archives: 0, addonFiles, error: String(e && e.message ? e.message : e) });
  }
}

function setAddons(list) {
  folder = list && list.length ? addonFolder(list) : null;
}

const readWhole = (file) => new Uint8Array(reader.readAsArrayBuffer(file));

// What the route answers: { status, body, type, cache }.
async function answer(message) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (message.kind === 'addons') return await addonsRoute(message.method, message.path, message.query, folder, readWhole);
      return await dataRoute(await getChain(), message.method, message.path);
    } catch (e) {
      if (e instanceof MpqError && e.kind === 'io' && attempt === 0) {
        chainPromise = null; // a stale file: read the tables again, once
        continue;
      }
      if (e instanceof NotReady) {
        return { status: 503, body: new TextEncoder().encode(e.message), type: 'text/plain; charset=utf-8', cache: 'no-store' };
      }
      return { status: statusOf(e), body: null };
    }
  }
}

// Put a blocking answer where the page is looking: part by part when it is larger than the buffer.
function send(seq, status, body, type, cache) {
  const total = body ? body.length : 0;
  if (Atomics.load(control, WANTED) !== seq) return; // the page gave up on this request
  Atomics.store(control, SEQ, seq);
  Atomics.store(control, STATUS, status);
  Atomics.store(control, TYPE, Math.max(0, TYPES.indexOf(type || null)));
  Atomics.store(control, CACHE, Math.max(0, CACHES.indexOf(cache || null)));
  Atomics.store(control, TOTAL, total);
  let at = 0;
  for (;;) {
    const n = Math.min(buffer.length, total - at);
    if (n) buffer.set(body.subarray(at, at + n));
    at += n;
    Atomics.store(control, LENGTH, n);
    if (at >= total) {
      Atomics.store(control, STATE, DONE);
      return;
    }
    Atomics.store(control, STATE, MORE);
    // Until the page has taken this part; a page that gave up is not waited for.
    const woke = Atomics.wait(control, STATE, MORE, 60000);
    if (woke === 'timed-out' || Atomics.load(control, WANTED) !== seq) return;
  }
}

async function read(message) {
  try {
    const a = await answer(message);
    send(message.seq, a.status, a.body, a.type, a.cache);
  } catch (e) {
    send(message.seq, 500, null, null, null);
  }
  answered = message.seq;
}

async function request(message) {
  let a;
  try {
    a = await answer(message);
  } catch (e) {
    a = { status: 500, body: null };
  }
  let body = null;
  if (a.body) {
    // Hand the bytes over without a copy when they are this answer's own buffer (an index is kept).
    const own = !a.shared && a.body.byteOffset === 0 && a.body.byteLength === a.body.buffer.byteLength;
    body = own ? a.body.buffer : a.body.slice().buffer;
  }
  postMessage({ type: 'response', id: message.id, status: a.status, body, contentType: a.type || null, cacheControl: a.cache || null }, body ? [body] : []);
}

// The page is blocked on a request this worker has not dealt with yet.
function pageIsWaiting() {
  return control !== null && Atomics.load(control, WANTED) !== answered;
}

async function drain() {
  while (deferred.length && !pageIsWaiting()) await request(deferred.shift());
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'init') {
    control = new Int32Array(message.control);
    buffer = new Uint8Array(message.buffer);
    files = message.files || [];
    setAddons(message.addons);
    prepare();
  } else if (message.type === 'reset') {
    files = message.files || [];
    if (message.addons !== undefined) setAddons(message.addons);
    chainPromise = null;
    prepare();
  } else if (message.type === 'addons') {
    setAddons(message.addons);
    prepare();
  } else if (message.type === 'read') {
    read(message).then(drain);
  } else if (message.type === 'request') {
    // A blocked page comes first: its own request is behind this one in the queue.
    if (pageIsWaiting()) deferred.push(message);
    else request(message);
  }
};
