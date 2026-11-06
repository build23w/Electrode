// The world server, inside this tab. A dedicated worker that loads the server (CMaNGOS compiled to
// wasm), gives it its files, and carries the game client's connections to it as messages.
//
// Page -> worker:  {cmd:'start', options}            start the world
//                  {cmd:'open', key, port}           a client connection to a server port (3724 login, 8085 world)
//                  {cmd:'data', key, bytes}          bytes from the client
//                  {cmd:'close', key}                the client closed it
//                  {cmd:'command', tag, text}        a server console command
//                  {cmd:'member', tag, id}           the game account of another player (by key fingerprint)
//                  {cmd:'copy', tag}                 the stored characters and accounts, to hand to other players
//                  {cmd:'save'}                      store the characters now
//                  {cmd:'adopt', tag}                (a standby) take the world as this browser last stored it
//                  {cmd:'takeover', options}         (a standby) run the world from now on
//                  {cmd:'stop'}                      save and shut the world down
// Worker -> page:  {type:'status', text} {type:'log', line} {type:'ready', account}
//                  {type:'standby', bootMs} {type:'adopted', tag, result, seq}
//
// A standby (start with options.standby) is the world of a player who is in it while someone else
// runs it: the server is up, with the characters and accounts as this browser last stored them
// (lib/copy-store.js), and nobody on it. It takes each newer copy as it is stored ('adopt'), and
// when the world's host goes away it carries the world on at once ('takeover').
//                  {type:'opened', key, ok} {type:'data', key, bytes} {type:'closed', key}
//                  {type:'command', tag, ok, text} {type:'member', tag, account | error} {type:'copy', tag, copy}
//                  {type:'saved', at} {type:'stopped'} {type:'error', message}

'use strict';

// The server's threads are workers too, and the server starts each of them from the script of the
// worker it lives in: this file. Those hand over to the server's own script at once.
if (self.name === 'em-pthread') {
  importScripts(new URL('server/mangosd.js', self.location.href).href);
} else {
  host();
}

function host() {
const base = new URL('./', self.location.href);
const post = (m, transfer) => self.postMessage(m, transfer || []);
const status = (text) => post({ type: 'status', text });

let Module = null;
let ready = false;
let standby = false; // up, but not the world's host: no connections, no saving
let state = null; // db/state.json
let saving = null; // promise of the save in flight
let stopping = false;
const idByKey = new Map();
const keyById = new Map();
const commandWaiters = new Map();
let nextTag = 1 << 20;

self.onmessage = (e) => {
  handle(e.data).catch((err) => post({ type: 'error', message: String((err && err.message) || err) }));
};
self.addEventListener('error', (e) => post({ type: 'error', message: 'world server: ' + (e.message || 'error') }));
self.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: 'world server: ' + String((e.reason && e.reason.message) || e.reason) }));

async function handle(m) {
  switch (m.cmd) {
    case 'start':
      return start(m.options || {});
    case 'adopt':
      return post({ type: 'adopted', tag: m.tag, ...(await adopt().catch((err) => ({ result: 'failed: ' + String((err && err.message) || err) }))) });
    case 'takeover':
      return takeover(m.options || {});
    case 'open': {
      const id = ready && !standby ? Module._electrode_open(m.port) : 0;
      if (id) {
        idByKey.set(m.key, id);
        keyById.set(id, m.key);
      }
      return post({ type: 'opened', key: m.key, ok: !!id });
    }
    case 'data': {
      const id = idByKey.get(m.key);
      if (!id) return;
      const bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
      // In pieces: the bytes pass through the module's stack on the way in.
      for (let off = 0; off < bytes.length; off += 32768) {
        const part = bytes.subarray(off, Math.min(bytes.length, off + 32768));
        Module.ccall('electrode_data', null, ['number', 'array', 'number'], [id, part, part.length]);
      }
      return;
    }
    case 'close': {
      const id = idByKey.get(m.key);
      if (!id) return;
      idByKey.delete(m.key);
      keyById.delete(id);
      Module._electrode_close(id);
      return;
    }
    case 'command': {
      const out = await command(m.text);
      return post({ type: 'command', tag: m.tag, ok: out.ok, text: out.text });
    }
    case 'member':
      try {
        return post({ type: 'member', tag: m.tag, account: await member(m.id) });
      } catch (err) {
        return post({ type: 'member', tag: m.tag, error: String((err && err.message) || err) });
      }
    case 'copy': {
      // What the last save stored: the world as other players' browsers keep it.
      let copy = null;
      if (ready && !standby && state.slot !== undefined) {
        const characters = await readBytes(storage.db, `characters.${state.slot}.sqlite`);
        const realmd = await readBytes(storage.db, `realmd.${state.slot}.sqlite`);
        if (characters && realmd) copy = { seq: state.seq || 0, at: state.savedAt || Date.now(), names: state.names || {}, files: { characters, realmd } };
      }
      return post({ type: 'copy', tag: m.tag, copy }, copy ? [copy.files.characters.buffer, copy.files.realmd.buffer] : []);
    }
    case 'fsstats': {
      // Development: what the server has asked of the file system since the last call.
      const out = fsStats;
      fsStats = { calls: {}, opens: {}, misses: {}, bytes: 0 };
      return post({ type: 'fsstats', tag: m.tag, stats: out });
    }
    case 'save':
      return save();
    case 'stop':
      return stop();
  }
}

// ---- storage (OPFS) ---------------------------------------------------------------------------

async function dir(parent, name, create = true) {
  return parent.getDirectoryHandle(name, { create });
}

async function readBytes(d, name) {
  try {
    const h = await d.getFileHandle(name);
    return new Uint8Array(await (await h.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

async function writeBytes(d, name, bytes) {
  const h = await d.getFileHandle(name, { create: true });
  const a = await h.createSyncAccessHandle();
  try {
    a.truncate(0);
    let off = 0;
    while (off < bytes.length) off += a.write(bytes.subarray(off, Math.min(bytes.length, off + (8 << 20))), { at: off });
    a.flush();
  } finally {
    a.close();
  }
}

async function readJson(d, name) {
  const b = await readBytes(d, name);
  if (!b) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b));
  } catch {
    return null;
  }
}

const writeJson = (d, name, value) => writeBytes(d, name, new TextEncoder().encode(JSON.stringify(value)));

// A packed database from the site, unpacked.
async function download(file, label) {
  const r = await fetch(new URL('db/' + file.url, base));
  if (!r.ok) throw new Error(`could not download ${file.url} (HTTP ${r.status})`);
  const out = new Uint8Array(file.bytes);
  let got = 0;
  let last = 0;
  const reader = r.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) throw new Error(`${file.url} is larger than its manifest says`);
    out.set(value, got);
    got += value.length;
    if (got - last > (4 << 20)) {
      last = got;
      status(`${label} ${Math.round((got / file.bytes) * 100)}%`);
    }
  }
  if (got !== file.bytes) throw new Error(`${file.url}: ${got} bytes, expected ${file.bytes}`);
  return out;
}

// The four databases as byte arrays: the world's content from the site (kept in storage, replaced
// when the site has a newer one), the player's characters and account from storage.
// `worldKey`: 'solo' for the world a player plays alone, else the id of a named world. The game's
// content is one database for all of them (db/world.sqlite); characters and accounts are each
// world's own (db/ for 'solo', db/w-<key>/ for a named world).
async function loadDatabases(root, worldKey, store) {
  const db = await dir(root, 'db');
  const manifest = await (await fetch(new URL('db/manifest.json', base), { cache: 'no-cache' })).json();
  const shared = (await readJson(db, 'state.json')) || {};

  let world = shared.world === manifest.version ? await readBytes(db, 'world.sqlite') : null;
  if (!world || world.length !== manifest.files.world.bytes) {
    status('Downloading the world database…');
    world = await download(manifest.files.world, 'Downloading the world database…');
    status('Storing the world database…');
    await writeBytes(db, 'world.sqlite', world);
    shared.world = manifest.version;
    await writeJson(db, 'state.json', shared);
  }

  // `store`: a second player in the same browser (the page's ?profile=) keeps its worlds apart.
  const own = store ? await dir(db, 'p-' + store) : db;
  const home = worldKey === 'solo' ? own : await dir(own, 'w-' + worldKey);
  state = home === db ? shared : (await readJson(home, 'state.json')) || {};

  let characters = null;
  let realmd = null;
  if (state.slot !== undefined) {
    characters = await readBytes(home, `characters.${state.slot}.sqlite`);
    realmd = await readBytes(home, `realmd.${state.slot}.sqlite`);
  }
  freshWorld = !characters || !realmd;
  if (freshWorld && standby) throw new Error('this browser has no copy of the world yet');
  if (freshWorld) {
    status('Creating your world…');
    characters = await download(manifest.files.characters, 'Creating your world…');
    realmd = await download(manifest.files.realmd, 'Creating your world…');
    delete state.slot;
    delete state.account;
    state.names = {};
  }
  // Which account belongs to which player key. (Older saves kept passwords here too: only the names matter.)
  state.names = state.names || {};
  for (const [id, account] of Object.entries(state.members || {})) if (!state.names[id] && account?.user) state.names[id] = account.user;
  delete state.members;
  const logs = await download(manifest.files.logs, 'Creating your world…');
  return { db: home, world, characters, realmd, logs };
}

// Every extracted file under world/, for the server's data folder (read in place, not copied).
async function worldFiles(root) {
  const world = await dir(root, 'world', false).catch(() => null);
  if (!world) throw new Error('the game data has not been extracted yet');
  const blobs = [];
  const flags = (await readJson(world, '.extracted.json')) || {};
  for (const sub of ['dbc', 'maps', 'vmaps', 'mmaps']) {
    const d = await dir(world, sub, false).catch(() => null);
    if (!d) continue;
    const pending = [];
    for await (const [name, h] of d.entries()) {
      if (h.kind !== 'file' || name.endsWith('.part')) continue;
      pending.push(h.getFile().then((f) => blobs.push({ name: `${sub}/${name}`, data: f })));
      if (pending.length >= 256) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
  }
  return { blobs, flags };
}

// ---- configuration ----------------------------------------------------------------------------

function setKeys(text, pairs) {
  let out = text;
  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${key} = ${value}`) : `${out}\n${key} = ${value}\n`;
  }
  return out;
}

function renderConf(template, o) {
  const noFile = {};
  for (const m of template.matchAll(/^([A-Za-z.]*LogFile)\s*=/gm)) noFile[m[1]] = '""';
  return setKeys(template, {
    ...noFile, // nothing is written to log files: they would only fill memory
    LoginDatabaseInfo: '"/db/realmd.sqlite"',
    WorldDatabaseInfo: '"/db/world.sqlite"',
    CharacterDatabaseInfo: '"/db/characters.sqlite"',
    LogsDatabaseInfo: '"/db/logs.sqlite"',
    DataDir: '"/data"',
    LogsDir: '"/logs"',
    BindIP: '"127.0.0.1"',
    WorldServerPort: '8085',
    'Console.Enable': '0',
    'Ra.Enable': '0',
    'SOAP.Enabled': '0',
    MaxCoreStuckTime: '0',
    'Network.Threads': '1',
    'MapUpdate.Threads': '2',
    // Collision follows what has been extracted. Pathfinding needs each terrain map's header; its
    // tiles are built while the world runs, where players are (see "movement maps" below).
    'vmap.enableLOS': o.vmaps ? '1' : '0',
    'vmap.enableHeight': o.vmaps ? '1' : '0',
    'mmap.enabled': o.mmaps ? '1' : '0',
    // A tab can close at any moment: characters reach the database twice a minute.
    'PlayerSave.Interval': '30000',
    LogLevel: '1',
    LogColors: '""',
    ShowProgressBars: '0',
    ...(o.settings || {}),
  });
}

// ---- the server -------------------------------------------------------------------------------

function command(text) {
  return new Promise((resolve) => {
    const tag = nextTag++;
    commandWaiters.set(tag, resolve);
    Module.ccall('electrode_command', null, ['number', 'string'], [tag, text]);
  });
}

const pageNet = {
  data(id, bytes) {
    const key = keyById.get(id);
    if (key !== undefined) post({ type: 'data', key, bytes }, [bytes.buffer]);
  },
  closed(id) {
    const key = keyById.get(id);
    if (key === undefined) return;
    keyById.delete(id);
    idByKey.delete(key);
    post({ type: 'closed', key });
  },
  event(name, detail) {
    if (name === 'ready') onReady().catch((err) => post({ type: 'error', message: String((err && err.message) || err) }));
    else if (name === 'snapshot') onSnapshot(detail === 'ok');
    else if (name === 'command') {
      const a = detail.indexOf('\n');
      const b = detail.indexOf('\n', a + 1);
      const resolve = commandWaiters.get(Number(detail.slice(0, a)));
      commandWaiters.delete(Number(detail.slice(0, a)));
      if (resolve) resolve({ ok: detail.slice(a + 1, b) === 'ok', text: detail.slice(b + 1) });
    } else if (name === 'mmtile') {
      const [map, x, y] = detail.split(' ').map(Number);
      mmapAsk({ cmd: 'tile', map, x, y });
    } else if (name === 'mmap') mmapAsk({ cmd: 'map', map: Number(detail) });
    else if (name === 'adopted') {
      const cut = detail.indexOf('\n');
      adoptWaiters.get(Number(detail.slice(0, cut)))?.(detail.slice(cut + 1));
      adoptWaiters.delete(Number(detail.slice(0, cut)));
    } else if (name === 'merged') {
      mergeWaiters.get(detail)?.();
      mergeWaiters.delete(detail);
    } else if (name === 'stopped') post({ type: 'stopped' });
  },
};

// ---- movement maps -----------------------------------------------------------------------------
// The server asks for a map tile when it loads terrain and finds none ("mmtile"), and for a whole
// map when a dungeon has no header ("mmap"). A worker builds them from the terrain and collision
// data; a finished file is added to the server's data folder and the server is told to load it.

let mmapWorker = null;
let mmapOff = false;
const mmapWaiting = new Map(); // asked for before what the build needs was ready
const pad = (n, width) => String(n).padStart(width, '0');

function mmapAsk(request) {
  if (mmapOff) return;
  if (!mmapWorker) {
    try {
      mmapWorker = new Worker(new URL('mmap-worker.js', base), { type: 'module' });
    } catch {
      mmapOff = true;
      return;
    }
    mmapWorker.onmessage = (e) => mmapAnswer(e.data).catch((err) => post({ type: 'log', lines: ['movement maps: ' + String((err && err.message) || err)] }));
    mmapWorker.onerror = () => {
      mmapOff = true;
      mmapWorker = null;
    };
    setInterval(() => {
      for (const waiting of mmapWaiting.values()) mmapWorker?.postMessage(waiting);
    }, 20000);
  }
  mmapWorker.postMessage(request);
}

// A file made since the world started: show it to the server in its data folder.
async function addDataFile(sub, name) {
  const FS = Module.FS;
  let parent;
  try {
    parent = FS.lookupPath('/data/' + sub).node;
  } catch {
    return false;
  }
  if (parent.contents[name]) return true;
  const root = await navigator.storage.getDirectory();
  const folder = await (await root.getDirectoryHandle('world')).getDirectoryHandle(sub);
  const file = await (await folder.getFileHandle(name)).getFile();
  Module.WORKERFS.createNode(parent, name, Module.WORKERFS.FILE_MODE, 0, file, new Date(file.lastModified));
  return true;
}

async function mmapAnswer(m) {
  if (m.type === 'log') return post({ type: 'log', lines: ['movement maps: ' + m.line] });
  if (m.type === 'error') return post({ type: 'log', lines: ['movement maps: ' + m.message] });
  if (m.type === 'tile') {
    const key = `t ${m.map} ${m.x} ${m.y}`;
    if (m.buildMs !== undefined || !m.ok) post({ type: 'log', lines: [`movement maps: tile ${pad(m.map, 3)} ${m.x} ${m.y} ${m.ok ? `built in ${(m.buildMs / 1000).toFixed(1)} s` : m.reason}`] });
    if (m.ok) {
      mmapWaiting.delete(key);
      if (await addDataFile('mmaps', `${pad(m.map, 3)}${pad(m.x, 2)}${pad(m.y, 2)}.mmtile`)) Module._electrode_mmap_tile(m.map, m.x, m.y);
    } else if (m.reason === 'not-ready') mmapWaiting.set(key, { cmd: 'tile', map: m.map, x: m.x, y: m.y });
  } else if (m.type === 'map') {
    const key = `m ${m.map}`;
    if (m.ok) {
      mmapWaiting.delete(key);
      // The next time this map is created its header and tiles are found.
      for (const name of m.files || []) await addDataFile('mmaps', name);
      Module._electrode_mmap_tile(m.map, -1, -1);
    } else if (m.reason === 'not-ready') mmapWaiting.set(key, { cmd: 'map', map: m.map });
  }
}

let fsStats = { calls: {}, opens: {}, misses: {}, bytes: 0 };
let startOptions = {};
let freshWorld = false; // this start made the world's databases from the empty templates
const mergeWaiters = new Map();
const adoptWaiters = new Map();
let worldLockName = '';
let storage = null; // { db }
let startTimes = null; // how long each part of the start took, for the log
let snapshotWaiter = null;

// One tab at a time runs a given world of this browser: two would overwrite each other's
// characters. (`name`: where that world is stored.)
function holdWorldLock(name) {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('electrode-world/' + name, { ifAvailable: true }, (lock) => {
      resolve(Boolean(lock));
      return lock ? new Promise(() => {}) : undefined; // held until this worker ends
    });
  });
}

async function start(options) {
  if (Module) throw new Error('the world is already running');
  const worldKey = /^[0-9a-f]{16,64}$/.test(options.world || '') ? options.world : 'solo';
  const store = /^[a-z0-9]{1,16}$/i.test(options.store || '') ? options.store : '';
  worldLockName = `${store}/${worldKey}`;
  standby = options.standby === true;
  // A standby does not store anything, so it needs no hold on the world's storage until it takes over.
  if (!standby && !(await holdWorldLock(worldLockName))) throw new Error('This world is already running in another tab of this browser. Close that tab, or play there.');
  status('Loading the world server…');
  const t0 = performance.now();
  const times = {};
  const mark = (name) => {
    times[name] = Math.round(performance.now() - t0);
  };
  startTimes = { t0, times, mark };
  importScripts(new URL('server/mangosd.js', base).href);
  const root = await navigator.storage.getDirectory();
  startOptions = options;
  const dbs = await loadDatabases(root, worldKey, store);
  storage = { db: dbs.db };
  mark('databases');
  status('Reading the game data…');
  const world = await worldFiles(root);
  mark('files');
  const [confDist, anticheatDist] = await Promise.all(
    ['server/mangosd.conf.dist', 'server/anticheat.conf.dist'].map(async (p) => (await fetch(new URL(p, base))).text())
  );

  status('Starting the world…');
  let lines = [];
  let flush = 0;
  const log = (line) => {
    // Each line with the seconds since the start, so slow parts of the world's start show.
    lines.push(line ? `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}  ${line}` : line);
    if (!flush) {
      flush = setTimeout(() => {
        flush = 0;
        post({ type: 'log', lines });
        lines = [];
      }, 100);
    }
  };
  /* global createMangosd */
  Module = await createMangosd({
    pageNet,
    print: log,
    printErr: log,
    locateFile: (f) => new URL('server/' + f, base).href,
    onAbort: (what) => post({ type: 'error', message: 'the world server stopped: ' + what }),
  });
  const FS = Module.FS;
  if (options.fsStats) {
    for (const op of ['open', 'read', 'llseek', 'close', 'stat', 'lstat', 'write']) {
      const original = FS[op];
      FS[op] = function (...args) {
        fsStats.calls[op] = (fsStats.calls[op] || 0) + 1;
        if (op === 'open' || op === 'stat') {
          const path = typeof args[0] === 'string' ? args[0] : '';
          const folder = path.split('/').slice(0, 3).join('/');
          try {
            const result = original.apply(this, args);
            fsStats.opens[folder] = (fsStats.opens[folder] || 0) + 1;
            return result;
          } catch (e) {
            fsStats.misses[folder] = (fsStats.misses[folder] || 0) + 1;
            throw e;
          }
        }
        const result = original.apply(this, args);
        if (op === 'read') fsStats.bytes += result;
        return result;
      };
    }
  }
  for (const d of ['/db', '/data', '/etc', '/logs', '/snapshot']) FS.mkdir(d);
  FS.writeFile('/db/world.sqlite', dbs.world, { canOwn: true });
  FS.writeFile('/db/characters.sqlite', dbs.characters, { canOwn: true });
  FS.writeFile('/db/realmd.sqlite', dbs.realmd, { canOwn: true });
  FS.writeFile('/db/logs.sqlite', dbs.logs, { canOwn: true });
  FS.mount(Module.WORKERFS, { blobs: world.blobs }, '/data');
  const hasHeaders = world.blobs.some((b) => b.name.startsWith('mmaps/') && b.name.endsWith('.mmap'));
  FS.writeFile('/etc/mangosd.conf', renderConf(confDist, {
    vmaps: !!world.flags.vmaps && options.collision !== false,
    mmaps: hasHeaders && options.pathfinding !== false,
    settings: {
      // The realm is shown under the world's own name.
      ...(options.realm ? { 'Page.RealmName': `"${String(options.realm).replace(/["\r\n\\]/g, '').slice(0, 32)}"` } : {}),
      ...(options.settings || {}),
    },
  }));
  // The browser client cannot answer the anticheat's module checks.
  FS.writeFile('/etc/anticheat.conf', anticheatDist.replace(/^Enable = 1/m, 'Enable = 0'));
  FS.chdir('/etc');
  mark('module');
  Module.callMain(['-c', '/etc/mangosd.conf']);
}

// How often the world is stored (and sent to the players in it).
const SAVE_EVERY = 30000;
const randomPass = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

// A player of this world, known by the fingerprint of their key: the same account every time, on
// whichever host runs the world (the account's name travels with the world's copy). The password
// is new at every join, so no host has to keep one.
const memberWaiters = new Map();
function accountFor(id) {
  if (!memberWaiters.has(id)) {
    memberWaiters.set(id, (async () => {
      const known = state.names[id];
      const account = { user: known || 'M' + id.slice(0, 14).toUpperCase(), pass: randomPass() };
      const made = await command(`account create ${account.user} ${account.pass}`);
      if (!made.ok) {
        // The server reports this command as failed even when it worked (so that the password is
        // not echoed to its log): its answer says which it was.
        const set = await command(`account set password ${account.user} ${account.pass} ${account.pass}`);
        if (!set.ok && !/password was changed/i.test(set.text)) throw new Error('could not open the account: ' + set.text.trim());
      }
      if (!known) {
        state.names[id] = account.user;
        save().catch(() => {});
      }
      return account;
    })().finally(() => memberWaiters.delete(id)));
  }
  return memberWaiters.get(id);
}
function member(id) {
  if (!ready) return Promise.reject(new Error('the world is not up yet'));
  if (!/^[0-9a-f]{20}$/.test(id)) return Promise.reject(new Error('not a player id'));
  return accountFor(id);
}

// The world is up: make sure the player's account exists, then tell the page.
async function onReady() {
  ready = true;
  if (startTimes) {
    startTimes.mark('world');
    const t = startTimes.times;
    post({ type: 'log', lines: [`start: databases ${t.databases} ms, file list ${t.files - t.databases} ms, server loaded ${t.module - t.files} ms, world up ${t.world - t.module} ms (total ${t.world} ms)`] });
  }
  if (standby) return post({ type: 'standby', bootMs: startTimes ? startTimes.times.world : 0, seq: state.seq || 0 });
  await ownAccount();
  setInterval(() => save().catch(() => {}), SAVE_EVERY);
  post({ type: 'ready', account: state.account, fresh: freshWorld });
}

// A standby takes the world as this browser last stored it (the host's latest copy), in place of
// what it has: the rows of the two databases are replaced while the server runs.
//   { result: 'ok', seq } | { result: 'stale' } (it has to be started afresh) | { result: 'busy' | 'failed…' }
let adopting = Promise.resolve();
function adopt() {
  const run = adopting.catch(() => {}).then(async () => {
    if (!ready || !standby) return { result: 'failed: not a standby' };
    const stored = (await readJson(storage.db, 'state.json')) || {};
    if (stored.slot === undefined) return { result: 'failed: nothing stored' };
    if ((stored.seq || 0) === (state.seq || 0) && stored.slot === state.slot) return { result: 'ok', seq: state.seq || 0 };
    const characters = await readBytes(storage.db, `characters.${stored.slot}.sqlite`);
    const realmd = await readBytes(storage.db, `realmd.${stored.slot}.sqlite`);
    if (!characters || !realmd) return { result: 'failed: the stored copy is incomplete' };
    const FS = Module.FS;
    FS.writeFile('/db/incoming-characters.sqlite', characters, { canOwn: true });
    FS.writeFile('/db/incoming-realmd.sqlite', realmd, { canOwn: true });
    const result = await new Promise((resolve) => {
      const tag = nextTag++;
      adoptWaiters.set(tag, resolve);
      Module._electrode_adopt(tag);
    });
    if (result === 'ok') state = { ...stored, names: stored.names || {} };
    return { result, seq: state.seq || 0 };
  });
  adopting = run;
  return run;
}

// The world's host is gone and this standby carries the world on: from here it is the world.
async function takeover(options) {
  if (!ready || !standby) throw new Error('this server is not a standby');
  if (!(await holdWorldLock(worldLockName))) throw new Error('This world is already running in another tab of this browser.');
  const taken = await adopt();
  if (taken.result !== 'ok') throw new Error('the standby could not take the latest copy (' + taken.result + ')');
  standby = false;
  freshWorld = false;
  startOptions = { ...startOptions, ...options };
  await ownAccount();
  setInterval(() => save().catch(() => {}), SAVE_EVERY);
  post({ type: 'ready', account: state.account, fresh: false });
}

// The account of the player who runs this world here. In a named world it is the account of the
// player's key, the same one that key gets when it joins the world while someone else runs it:
// one player, one account, one set of characters in a world.
async function ownAccount() {
  const owner = /^[0-9a-f]{20}$/.test(startOptions.owner || '') ? startOptions.owner : null;
  if (!owner) {
    // Playing alone: one account, kept with its password.
    if (!state.account) {
      const account = { user: 'PLAYER', pass: randomPass() };
      const made = await command(`account create ${account.user} ${account.pass}`);
      if (!made.ok) throw new Error('could not create the account: ' + made.text.trim());
      await command(`account set gmlevel ${account.user} 3`);
      state.account = account;
      await save();
    }
    return;
  }
  // The account this player had when the world last ran here is theirs. (A world saved before
  // accounts followed keys could hold a second one for the same key, from a second tab: its
  // characters come over.)
  const mine = state.account && state.account.user;
  const named = state.names[owner];
  if (mine && named !== mine) {
    state.names[owner] = mine;
    if (named) {
      await new Promise((resolve) => {
        mergeWaiters.set(named, resolve);
        Module.ccall('electrode_merge_account', null, ['string', 'string'], [named, mine]);
      });
    }
  }
  state.account = await accountFor(owner);
  // Every command for the player who made a room, from the start; a world carried on from a
  // copy keeps the levels its accounts have, and an official world gives its host none.
  if (freshWorld && startOptions.admin !== false) await command(`account set gmlevel ${state.account.user} 3`);
  await save();
}

// Characters and account -> storage. The server writes consistent copies; they go to the slot that
// is not current, and state.json flips to it only once both are stored.
function save() {
  if (!ready || standby) return Promise.resolve();
  if (saving) return saving;
  saving = new Promise((resolve, reject) => {
    snapshotWaiter = { resolve, reject };
    Module._electrode_snapshot();
  }).finally(() => {
    saving = null;
  });
  return saving;
}

async function onSnapshot(ok) {
  const waiter = snapshotWaiter;
  snapshotWaiter = null;
  try {
    if (!ok) throw new Error('the server could not write its snapshot');
    const FS = Module.FS;
    const slot = state.slot === 0 ? 1 : 0;
    await writeBytes(storage.db, `characters.${slot}.sqlite`, FS.readFile('/snapshot/characters.sqlite'));
    await writeBytes(storage.db, `realmd.${slot}.sqlite`, FS.readFile('/snapshot/realmd.sqlite'));
    FS.unlink('/snapshot/characters.sqlite');
    FS.unlink('/snapshot/realmd.sqlite');
    state.slot = slot;
    state.seq = (state.seq || 0) + 1;
    state.savedAt = Date.now();
    await writeJson(storage.db, 'state.json', state);
    post({ type: 'saved', at: state.savedAt });
    if (waiter) waiter.resolve();
  } catch (err) {
    if (waiter) waiter.reject(err);
    else post({ type: 'error', message: String((err && err.message) || err) });
  }
}

async function stop() {
  if (!ready || stopping || standby) return;
  stopping = true;
  await command('saveall').catch(() => {});
  await save().catch(() => {});
  Module._electrode_stop();
}
} // host
