// The player's own game files, and where the page reads them from.
//
// Three sources, used in this order when more than one is usable:
//   session  the files of a folder the player picked for this visit (any browser); nothing is stored
//   linked   the game's Data folder itself, by a folder handle kept in IndexedDB (Chrome, Edge);
//            nothing is copied, and a later visit may have to ask for permission again
//   copied   a copy of the 14 archives in the browser's private storage (OPFS folder "gamefiles")
//
//   gameFilesStatus()                           which source is active and whether it is complete
//   linkGameFolder(dirHandle, opts)             remember a folder from showDirectoryPicker
//   grantGameFolder()                           ask for permission to read the linked folder again (from a click)
//   useSessionFiles(fileList, opts)             use the files of <input webkitdirectory> for this visit
//   forgetGameFolder()                          drop the linked folder and the session files
//   getArchiveFiles()                           [{ name, file }] of the active source, for the workers
//   importGameFiles(source, onProgress, opts)   make the copy
//   removeGameFiles()                           delete the copy
//   startServiceWorker()                        register ../sw.js (cross-origin isolation)
//
// The files are read inside the browser and are never uploaded anywhere.

const DIR = 'gamefiles';
const STAMP = '.imported.json';
const DB_NAME = 'electrode-gamefiles';
const DB_STORE = 'kv';
const LINK_KEY = 'linked-folder';

// The 1.12.1 (build 5875) enUS archives: names, sizes and SHA-256.
export const MANIFEST = {
  clientVersion: '1.12.1.5875',
  files: [
    { path: 'backup.MPQ', bytes: 6341628, sha256: '5f95175d6046827bbd46ec207a78032a9279fbcf4163c308fb73655f537ff26a' },
    { path: 'base.MPQ', bytes: 11202638, sha256: '8664981b6ae6f43ad2c2a3670e7b92fb6765da200b427a7e57e03c5cb5645241' },
    { path: 'dbc.MPQ', bytes: 3875834, sha256: 'a37649169842347ae37a270f49b005a95e184f5ba3d2c1d2d16f37ea2bb902e4' },
    { path: 'fonts.MPQ', bytes: 1284223, sha256: '0e8a8121f40ff27dad6beba63a83b708c753762c898420a674a74987a6e31522' },
    { path: 'interface.MPQ', bytes: 69655328, sha256: '9ac598e8c1595f0c50276860936956e6196ef5f041de13db79a5d75b6be99105' },
    { path: 'misc.MPQ', bytes: 6084832, sha256: '59c4138eefb00f6e640667cd7d16decaec4b2048ee17dc4f58195bd93d7c6a60' },
    { path: 'model.MPQ', bytes: 190911084, sha256: 'd8f168e2d346a113076e5b100296cc8f77cc74db2f85e16d25052bc5fc59b639' },
    { path: 'patch-2.MPQ', bytes: 9095702, sha256: 'd8273a13ac9ed17be5b9a4454bd7de71d48266822c1aba44ca73defad7a4593e' },
    { path: 'patch.MPQ', bytes: 2055856542, sha256: '5fe80699e8d6de05a2c76bb63a523bbf53761cc1ddf528c77a755324d8476ec1' },
    { path: 'sound.MPQ', bytes: 707653955, sha256: '7ccbaef51dd998366d5d71b5d702caef9518e415066fb94d7c503fe07deda4cb' },
    { path: 'speech.MPQ', bytes: 229168847, sha256: '1759231dfb0427d4ad48d6cde23623df8eb3e35f8bf8b40ed2abbb89005be6dd' },
    { path: 'terrain.MPQ', bytes: 1099777804, sha256: '4ca9cb8ebc40027f15168fbc2f311d4420f5c628f1327e4317087febae1aa638' },
    { path: 'texture.MPQ', bytes: 664940439, sha256: '5768dc52b2e59f6854e3c30812644af86d1834d60b2d5970860cea893c0c4c07' },
    { path: 'wmo.MPQ', bytes: 363565077, sha256: '00d40ff633cd71ab60f20833a06b18e9638132227c8c1d2bc509c905e51552ce' },
  ],
};

export const TOTAL_BYTES = MANIFEST.files.reduce((sum, f) => sum + f.bytes, 0);

// code: 'none' (no source yet), 'permission' (the linked folder needs permission), 'not-found'
// (no game folder there), 'missing', 'wrong-size', 'quota', 'unsupported', 'copy', 'verify',
// 'aborted'. `details` lists the files concerned where there are any.
export class GameFilesError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'GameFilesError';
    this.code = code;
    this.details = details;
  }
}

const lower = (s) => s.toLowerCase();
const WANTED = new Map(MANIFEST.files.map((f) => [lower(f.path), f]));

// ---- finding the archives in what the player chose ----

async function entriesOf(dirHandle) {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) out.push([name, handle]);
  return out;
}

// The folder that holds the archives: the handle itself, or its "Data" folder.
async function dataFolder(dirHandle) {
  const list = await entriesOf(dirHandle);
  if (list.some(([n, h]) => h.kind === 'file' && lower(n) === 'dbc.mpq')) return { dir: dirHandle, list };
  const data = list.find(([n, h]) => h.kind === 'directory' && lower(n) === 'data');
  if (data) return { dir: data[1], list: await entriesOf(data[1]) };
  return { dir: dirHandle, list };
}

// Every archive of the set found in the source, as { path, file | url, size }, keyed by its
// manifest name in lower case. A folder handle is the game folder or its Data folder; a file
// list is whatever a folder input gave, where the copy under a "Data" folder wins.
async function collect(source) {
  const found = new Map();
  if (source && source.kind === 'directory' && typeof source.entries === 'function') {
    const { list } = await dataFolder(source);
    for (const [name, handle] of list) {
      if (handle.kind !== 'file' || !WANTED.has(lower(name)) || found.has(lower(name))) continue;
      const file = await handle.getFile();
      found.set(lower(name), { path: name, file, size: file.size });
    }
    return found;
  }
  if (!source || typeof source[Symbol.iterator] !== 'function') {
    throw new GameFilesError('not-found', 'Choose the World of Warcraft 1.12.1 folder (or its Data folder).');
  }
  const rank = (path) => {
    const parts = path.split(/[\\/]/);
    const inData = parts.length > 1 && lower(parts[parts.length - 2]) === 'data';
    return (inData ? 0 : 1000) + parts.length;
  };
  for (const item of source) {
    if (!item || typeof item.name !== 'string') continue;
    const path = item.webkitRelativePath || item.path || item.name;
    const key = lower(path.split(/[\\/]/).pop());
    if (!WANTED.has(key)) continue;
    const candidate = typeof item.url === 'string' ? { path, url: item.url, size: item.size } : { path, file: item, size: item.size };
    const have = found.get(key);
    if (!have || rank(path) < rank(have.path)) found.set(key, candidate);
  }
  return found;
}

// The name and size checks every source passes: all 14 there, and (unless relaxed) the
// 1.12.1 enUS sizes. Returns the names whose size differs.
function check(found, strict) {
  if (found.size === 0) {
    throw new GameFilesError('not-found', 'No game archives in that folder. Choose the World of Warcraft 1.12.1 folder (the one holding WoW.exe) or its Data folder.');
  }
  const missing = MANIFEST.files.filter((f) => !found.has(lower(f.path))).map((f) => f.path);
  if (missing.length) throw new GameFilesError('missing', `That folder lacks ${missing.length} of the ${MANIFEST.files.length} archives: ${missing.join(', ')}.`, missing);
  const wrong = MANIFEST.files.filter((f) => found.get(lower(f.path)).size !== f.bytes).map((f) => f.path);
  if (wrong.length && strict) {
    throw new GameFilesError('wrong-size', `These archives are not the 1.12.1 (build 5875) enUS ones: ${wrong.join(', ')}.`, wrong);
  }
  return wrong;
}

function entriesFrom(found) {
  return MANIFEST.files.map((f) => {
    const src = found.get(lower(f.path));
    return { name: f.path, size: src.size, expected: f.bytes, sha256: src.size === f.bytes ? f.sha256 : null, file: src.file, url: src.url };
  });
}

// ---- the helper worker: the copy, and the SHA-256 check ----

function runWorker(job, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gamefiles-worker.js', import.meta.url));
    const finish = (settle, value) => {
      worker.terminate();
      if (signal) signal.removeEventListener('abort', onAbort);
      settle(value);
    };
    const onAbort = () => finish(reject, new GameFilesError('aborted', 'Cancelled.'));
    if (signal) signal.addEventListener('abort', onAbort);
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        if (onProgress) onProgress({ phase: data.phase, file: data.name, bytes: data.bytes, total: data.total, fraction: data.total ? data.bytes / data.total : 1 });
      } else if (data.type === 'done') finish(resolve, data);
      else if (data.type === 'error') finish(reject, new GameFilesError(data.code, data.message));
    };
    worker.onerror = (e) => finish(reject, new GameFilesError('copy', e.message || 'The helper worker could not start.'));
    worker.postMessage(job);
  });
}

// ---- the three sources ----

let session = null; // { files: [{ name, file, size }], strict }

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function kv(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const request = run(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function linkRecord() {
  try {
    const record = await kv('readonly', (store) => store.get(LINK_KEY));
    return record && record.handle ? record : null;
  } catch (e) {
    return null;
  }
}

async function storedFolder(create = false) {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new GameFilesError('unsupported', 'This browser has no private file storage for sites.');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

// One row per archive for a source: { name, expected, size, state, file }.
function rows(found) {
  return MANIFEST.files.map((f) => {
    const src = found ? found.get(lower(f.path)) : null;
    if (!src) return { name: f.path, expected: f.bytes, size: null, state: 'missing', file: null };
    return { name: f.path, expected: f.bytes, size: src.size, state: src.size === f.bytes ? 'ok' : 'wrong-size', file: src.file || null };
  });
}

function complete(source) {
  if (!source.files) return false;
  if (source.files.some((f) => f.state === 'missing')) return false;
  return !source.strict || source.files.every((f) => f.state === 'ok');
}

async function sessionSource() {
  if (!session) return null;
  const found = new Map(session.files.map((f) => [lower(f.name), { file: f.file, size: f.size }]));
  return { mode: 'session', strict: session.strict, permission: 'granted', files: rows(found) };
}

async function linkedSource() {
  const record = await linkRecord();
  if (!record) return null;
  let permission = 'granted';
  try {
    if (typeof record.handle.queryPermission === 'function') permission = await record.handle.queryPermission({ mode: 'read' });
  } catch (e) {
    permission = 'prompt';
  }
  const source = { mode: 'linked', strict: record.strict !== false, permission, files: null, handle: record.handle };
  if (permission !== 'granted') return source;
  try {
    source.files = rows(await collect(record.handle));
  } catch (e) {
    source.files = rows(null); // the folder is gone, or cannot be read right now
  }
  return source;
}

async function copiedSource() {
  let dir = null;
  try {
    dir = await storedFolder();
  } catch (e) {
    dir = null;
  }
  const found = new Map();
  let imported = null;
  if (dir) {
    for (const f of MANIFEST.files) {
      try {
        const file = await (await dir.getFileHandle(f.path)).getFile();
        found.set(lower(f.path), { file, size: file.size });
      } catch (e) {
        /* not there, or being written right now */
      }
    }
    try {
      imported = JSON.parse(await (await (await dir.getFileHandle(STAMP)).getFile()).text());
    } catch (e) {
      imported = null;
    }
  }
  return { mode: 'copied', strict: !imported || imported.strict !== false, permission: 'granted', files: rows(found), imported };
}

// Every source there is, and the active one: the first usable in the order session, linked,
// copied; when none is usable, the first that exists.
async function survey() {
  const copied = await copiedSource();
  const linked = await linkedSource();
  const list = [await sessionSource(), linked, copied.imported ? copied : null].filter(Boolean);
  const active = list.find(complete) || list[0] || null;
  return { active, linked, copied };
}

/**
 * Which source is active and what it holds.
 *   ready            the active source has the whole set and can be read now
 *   mode             'session' | 'linked' | 'copied' | null
 *   needsPermission  the linked folder is the only thing to use and the browser wants a click
 *                    before it may be read again: call grantGameFolder() from one
 *   files            [{ name, expected, size, state: 'ok' | 'missing' | 'wrong-size' | 'unknown' }]
 *   sources          { session: bool, linked: null | 'granted' | 'prompt' | 'denied', copied: bool }
 *   imported         the copy's stamp, or null when there is no finished copy
 */
export async function gameFilesStatus() {
  const { active, linked, copied } = await survey();
  const shown = active || copied;
  const files = shown.files
    ? shown.files.map((f) => ({ name: f.name, expected: f.expected, size: f.size, state: f.state }))
    : MANIFEST.files.map((f) => ({ name: f.path, expected: f.bytes, size: null, state: 'unknown' }));
  return {
    ready: active !== null && complete(active),
    mode: active ? active.mode : null,
    needsPermission: active !== null && active.mode === 'linked' && active.permission === 'prompt',
    strict: shown.strict,
    imported: copied.imported,
    files,
    missing: files.filter((f) => f.state === 'missing').map((f) => f.name),
    wrongSize: files.filter((f) => f.state === 'wrong-size').map((f) => f.name),
    bytes: files.reduce((sum, f) => sum + (f.size || 0), 0),
    totalBytes: TOTAL_BYTES,
    sources: { session: session !== null, linked: linked ? linked.permission : null, copied: copied.imported !== null && complete(copied) },
  };
}

/**
 * The 14 archives of the active source as [{ name, file }], named as in the manifest. Files
 * clone to workers by reference, so the list can be posted to any worker that reads them.
 * Rejects with a GameFilesError: 'none', 'permission', 'missing' or 'wrong-size'.
 */
export async function getArchiveFiles() {
  const { active } = await survey();
  if (!active) throw new GameFilesError('none', 'No game files yet: choose your game folder.');
  if (active.mode === 'linked' && active.permission !== 'granted') {
    throw new GameFilesError('permission', 'The browser needs your permission to read the game folder again.');
  }
  const missing = active.files.filter((f) => f.state === 'missing').map((f) => f.name);
  if (missing.length) throw new GameFilesError('missing', `The game folder lacks ${missing.length} of the ${MANIFEST.files.length} archives: ${missing.join(', ')}.`, missing);
  if (!complete(active)) {
    const wrong = active.files.filter((f) => f.state === 'wrong-size').map((f) => f.name);
    throw new GameFilesError('wrong-size', `These archives are not the 1.12.1 (build 5875) enUS ones: ${wrong.join(', ')}.`, wrong);
  }
  return active.files.map((f) => ({ name: f.name, file: f.file }));
}

// The name and size checks, then the optional SHA-256 pass, for a source that is read in place.
async function accept(source, { strict = true, verify = false, onProgress, signal } = {}) {
  if (signal && signal.aborted) throw new GameFilesError('aborted', 'Cancelled.');
  const found = await collect(source);
  const wrong = check(found, strict);
  const entries = entriesFrom(found);
  if (entries.some((e) => !e.file)) throw new GameFilesError('unsupported', 'These archives are not files on this device.');
  if (verify) await runWorker({ type: 'verify', entries }, onProgress, signal);
  return { entries, strict: wrong.length === 0, verified: Boolean(verify) };
}

/**
 * Remember the player's game folder (a FileSystemDirectoryHandle from showDirectoryPicker; the
 * game folder or its Data folder) and read it in place from now on. Nothing is copied.
 * options: strict (default true), verify (SHA-256 of every archive, slower), onProgress, signal.
 * Resolves with gameFilesStatus(). A browser that cannot keep a folder handle rejects with
 * 'unsupported': use useSessionFiles() with the same handle for this visit instead.
 */
export async function linkGameFolder(dirHandle, options = {}) {
  if (!dirHandle || dirHandle.kind !== 'directory') throw new GameFilesError('not-found', 'Choose the World of Warcraft 1.12.1 folder (or its Data folder).');
  const { dir } = await dataFolder(dirHandle);
  const accepted = await accept(dir, options);
  try {
    await kv('readwrite', (store) => store.put({ handle: dir, strict: accepted.strict, verified: accepted.verified, linkedAt: new Date().toISOString() }, LINK_KEY));
  } catch (e) {
    throw new GameFilesError('unsupported', 'This browser cannot remember a folder.');
  }
  return gameFilesStatus();
}

/**
 * Ask the browser for permission to read the linked folder again. Call it from a click: the
 * browser shows its prompt only then. Resolves with gameFilesStatus().
 */
export async function grantGameFolder() {
  const record = await linkRecord();
  if (!record) throw new GameFilesError('none', 'No game folder is linked.');
  let permission = 'granted';
  if (typeof record.handle.requestPermission === 'function') permission = await record.handle.requestPermission({ mode: 'read' });
  if (permission !== 'granted') throw new GameFilesError('permission', 'The browser did not allow reading the game folder.');
  return gameFilesStatus();
}

/**
 * Use the files of a folder the player picked, for this visit only: a FileList or array of
 * Files from <input type="file" webkitdirectory> or a drop (a folder handle works too).
 * Nothing is stored; the next visit starts without them. Options as for linkGameFolder.
 * Resolves with gameFilesStatus().
 */
export async function useSessionFiles(source, options = {}) {
  const accepted = await accept(source, options);
  session = { files: accepted.entries.map((e) => ({ name: e.name, file: e.file, size: e.size })), strict: accepted.strict };
  return gameFilesStatus();
}

/** Drop the linked folder and this visit's files. The copy, if there is one, stays. */
export async function forgetGameFolder() {
  session = null;
  try {
    await kv('readwrite', (store) => store.delete(LINK_KEY));
  } catch (e) {
    /* nothing was kept */
  }
  return gameFilesStatus();
}

// ---- the copy ----

/**
 * Copy the archives into the browser's storage.
 *
 * source: a FileSystemDirectoryHandle (showDirectoryPicker), a FileList or array of Files
 *   (<input type="file" webkitdirectory>), or an array of { name, size, url } to fetch from.
 *   The game folder and its Data folder both work.
 * onProgress({ phase: 'copy' | 'verify', file, bytes, total, fraction })
 * options:
 *   verify  also check each file's SHA-256 (slower; reads every byte once more only for files already stored)
 *   strict  refuse a file whose size is not the 1.12.1 enUS one (default true)
 *   force   copy again even when a file of the right size is already stored
 *   signal  an AbortSignal to cancel
 * Resolves with gameFilesStatus(); rejects with a GameFilesError.
 */
export async function importGameFiles(source, onProgress, options = {}) {
  const { verify = false, strict = true, force = false, signal } = options;
  if (signal && signal.aborted) throw new GameFilesError('aborted', 'Cancelled.');
  const found = await collect(source);
  const wrong = check(found, strict);
  await storeArchives(entriesFrom(found), onProgress, { verify, force, signal, strict: wrong.length === 0 });
  return gameFilesStatus();
}

/**
 * The copy itself, for a list of entries already matched to their names:
 * [{ name, size, sha256 | null, file | url }]. importGameFiles calls it with the whole set;
 * a development check may store fewer archives through the same path.
 */
export async function storeArchives(entries, onProgress, { verify = false, force = false, signal, strict = true } = {}) {
  const dir = await storedFolder(true);
  let toWrite = 0;
  for (const entry of entries) {
    let stored = -1;
    try {
      stored = (await (await dir.getFileHandle(entry.name)).getFile()).size;
    } catch (e) {
      stored = -1;
    }
    if (force || stored !== entry.size) toWrite += entry.size - Math.max(0, stored);
  }

  // Ask the browser to keep this storage, and check there is room before a long copy.
  try {
    if (navigator.storage.persist) await navigator.storage.persist();
  } catch (e) {
    /* best effort */
  }
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota === 'number' && typeof usage === 'number' && quota - usage < toWrite) {
      const gb = (n) => (n / 1073741824).toFixed(1);
      throw new GameFilesError('quota', `The browser allows this site ${gb(quota - usage)} GB more, and the game files need ${gb(toWrite)} GB. Free some disk space, or use a normal window instead of a private one, and try again.`);
    }
  } catch (e) {
    if (e instanceof GameFilesError) throw e;
  }

  const done = await runWorker({
    type: 'import',
    dir: DIR,
    stampName: STAMP,
    stamp: { version: 1, clientVersion: MANIFEST.clientVersion, strict },
    entries,
    verify,
    force,
  }, onProgress, signal);
  return done.stamp;
}

/** Delete the copy. A linked folder and this visit's files are not touched. */
export async function removeGameFiles() {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(DIR, { recursive: true });
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') throw e;
  }
}

// ---- the service worker ----

/**
 * Register the service worker and make sure this page runs under it, cross-origin isolated.
 * The first visit (and a forced reload) is not under the worker yet, so the page reloads once.
 * Resolves with { controlled, isolated, reloading }; when `reloading` is true the page is about
 * to reload and the caller should stop.
 */
export async function startServiceWorker({ reload = true } = {}) {
  if (!('serviceWorker' in navigator)) throw new GameFilesError('unsupported', 'This browser has no service workers (a private window can turn them off).');
  const script = new URL('../sw.js', import.meta.url);
  const scope = new URL('../', import.meta.url);
  await navigator.serviceWorker.register(script, { scope: scope.pathname, updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  const controlled = Boolean(navigator.serviceWorker.controller);
  const isolated = Boolean(self.crossOriginIsolated);
  const KEY = 'electrode-sw-reloads';
  if (controlled && isolated) {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* no session storage */ }
    return { controlled, isolated, reloading: false };
  }
  let tries = 0;
  try { tries = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) { tries = 2; }
  if (reload && tries < 2) {
    try { sessionStorage.setItem(KEY, String(tries + 1)); } catch (e) { /* no session storage */ }
    location.reload();
    return { controlled, isolated, reloading: true };
  }
  return { controlled, isolated, reloading: false };
}
