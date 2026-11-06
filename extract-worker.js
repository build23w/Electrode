// The Worker that turns the player's game archives into the files the world server reads.
// It runs the core's own extractors (compiled to WebAssembly, in extract/) on the player's archives
// and writes the results into the browser's private storage. Nothing leaves the browser.
//
//   const w = new Worker(new URL('./extract-worker.js', import.meta.url), { type: 'module' });
//   w.postMessage({ cmd: 'run', stages: ['dbc', 'maps', 'vmaps'], files: [{ name: 'dbc.MPQ', file }, ...] });
//
// in:   { cmd: 'run', stages?: ['dbc', 'maps', 'vmaps'], files?: [{ name, file }], maps?: [map ids], force?: true }
//         files: the archives as File objects (from a folder the player chose), read where they
//         are. Without it the archives are taken from gamefiles/ in storage.
//       { cmd: 'status' }
// out:  { type: 'progress', stage, done, total, detail }
//       { type: 'log', line }
//       { type: 'done', stage }            one per finished stage
//       { type: 'finished', state }        after the last stage asked for
//       { type: 'status', state }
//       { type: 'error', message }
//
// Storage (origin private file system):
//   gamefiles/            the player's archives, flat (dbc.MPQ, terrain.MPQ, patch.MPQ, ...); read only,
//                         and only when the run brings no files
//   world/dbc/*.dbc       game tables                         stage 'dbc' (with world/Cameras/*)
//   world/maps/*.map      terrain, one file per tile          stage 'maps'
//   world/mmaps/NNN.mmap  movement-map header of every map with terrain (the world server wants one
//                         before it loads terrain there); written at the end of 'maps'
//   world/vmaps/*         collision models                    stage 'vmaps'
//   world/.extracted.json { dbc, maps, vmaps, ... } set as stages finish
//   world/.tmp/           scratch of the 'vmaps' stage, removed when it finishes
//
// A stage that is already complete is skipped unless force is set. 'maps' resumes at the first map
// that was not finished. To cancel, terminate the worker.

const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const TOOLS = new URL('./extract/', import.meta.url);
const STAGES = ['dbc', 'maps', 'vmaps'];

// The archives each tool opens, in the spelling it opens them by.
const ARCHIVES = {
  ad: ['model.MPQ', 'dbc.MPQ', 'terrain.MPQ', 'patch.MPQ', 'patch-2.MPQ'],
  vmaps: ['terrain.MPQ', 'model.MPQ', 'wmo.MPQ', 'patch.MPQ', 'patch-2.MPQ'],
};

const post = (m) => self.postMessage(m);
const log = (line) => post({ type: 'log', line });

// ---------------------------------------------------------------------------------------------
// Storage

async function dir(path, create = true) {
  let d = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function writeBytes(d, name, bytes, flush = false) {
  const handle = await d.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(bytes, { at: 0 });
    if (flush) access.flush();
  } finally {
    access.close();
  }
}

async function readState() {
  try {
    const world = await dir('world', false);
    const file = await (await world.getFileHandle('.extracted.json')).getFile();
    return JSON.parse(await file.text());
  } catch {
    return {};
  }
}

async function writeState(state) {
  await writeBytes(await dir('world'), '.extracted.json', new TextEncoder().encode(JSON.stringify(state)), true);
}

async function remove(d, name) {
  try {
    await d.removeEntry(name, { recursive: true });
  } catch {
    /* not there */
  }
}

// The archives a run was given as File objects (lower-case name -> File), or null: then gamefiles/.
let given = null;

/** [{ name, file }] -> Map(lower-case name -> File), or null when there is no list. */
function archiveMap(files) {
  if (!Array.isArray(files)) return null;
  const map = new Map();
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !(f.file instanceof Blob)) throw new Error('files must be a list of { name, file }.');
    map.set(f.name.split(/[\\/]/).pop().toLowerCase(), f.file);
  }
  return map;
}

/** The same list again, for a worker of this file. */
const archiveList = () => (given ? [...given].map(([name, file]) => ({ name, file })) : undefined);

/** The player's archives by lower-case name: the ones the run was given, else those in gamefiles/. */
async function gameArchives() {
  if (given) return given;
  let d;
  try {
    d = await dir('gamefiles', false);
  } catch {
    throw new Error('No game files in this browser yet (gamefiles/ is missing).');
  }
  const files = new Map();
  for await (const [name, handle] of d.entries()) {
    if (handle.kind === 'file' && /\.mpq$/i.test(name)) files.set(name.toLowerCase(), await handle.getFile());
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// The tools

/**
 * Reads of a mounted archive go through a small cache of 1 MB pieces: the tools read an archive a
 * few kilobytes at a time, and each uncached read is a round trip to the file.
 */
function cacheReads(M, pieces) {
  const PIECE = 1 << 20;
  const reader = new FileReaderSync();
  const cache = new Map();
  M.WORKERFS.stream_ops.read = (stream, buffer, offset, length, position) => {
    const node = stream.node;
    if (position >= node.size) return 0;
    length = Math.min(length, node.size - position);
    let done = 0;
    while (done < length) {
      const at = position + done;
      const index = Math.floor(at / PIECE);
      const key = node.id * 8192 + index;
      let piece = cache.get(key);
      if (piece) {
        cache.delete(key);
        cache.set(key, piece);
      } else {
        const start = index * PIECE;
        piece = new Uint8Array(reader.readAsArrayBuffer(node.contents.slice(start, Math.min(node.size, start + PIECE))));
        cache.set(key, piece);
        if (cache.size > pieces) cache.delete(cache.keys().next().value);
      }
      const within = at - index * PIECE;
      const n = Math.min(length - done, piece.length - within);
      buffer.set(piece.subarray(within, within + n), offset + done);
      done += n;
    }
    return done;
  };
}

async function loadTool(file, onLine) {
  const { default: create } = await import(new URL(file, TOOLS).href);
  const M = await create({ print: onLine, printErr: onLine });
  M.FS.mkdir('/out');
  return M;
}

/** Mounts the archives `names` (those that exist) at /gamefiles; throws if a needed one is missing. */
function mountArchives(M, files, names, pieces) {
  const missing = names.filter((n) => !files.has(n.toLowerCase()));
  if (missing.length) throw new Error(`Game files are missing: ${missing.join(', ')}`);
  M.FS.mkdir('/gamefiles');
  M.FS.mount(M.WORKERFS, { blobs: names.map((n) => ({ name: n, data: files.get(n.toLowerCase()) })) }, '/gamefiles');
  cacheReads(M, pieces);
}

/** The size of a tool's memory now, in MB (it only grows). */
const megabytes = (M) => Math.round(M.HEAPU8.length / 1048576);

/** Runs a tool's main; returns its exit code. */
function runMain(M, args) {
  try {
    return M.callMain(args);
  } catch (e) {
    if (e && e.name === 'ExitStatus') return e.status;
    throw e;
  }
}

/** Calls an exported step; a tool that gives up (exit) becomes an Error. */
function step(M, name, ...args) {
  try {
    return M['_' + name](...args);
  } catch (e) {
    if (e && e.name === 'ExitStatus') throw new Error(`The extractor stopped (${name}, code ${e.status}).`);
    throw e;
  }
}

/** Moves every file of the module's folder `from` into the storage folder `to`. Returns how many. */
async function flushDir(M, from, to) {
  let names;
  try {
    names = M.FS.readdir(from).filter((n) => n !== '.' && n !== '..');
  } catch {
    return 0;
  }
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const path = `${from}/${names[next]}`;
      const name = names[next++];
      const bytes = M.FS.readFile(path);
      M.FS.unlink(path);
      await writeBytes(to, name, bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
  return names.length;
}

async function loadAd(files, onLine, pieces) {
  const A = await loadTool('ad.js', onLine);
  mountArchives(A, files, ARCHIVES.ad, pieces);
  const opened = A.ccall('ad_open', 'number', ['string', 'string', 'number'], ['/gamefiles', '/out', 1]);
  if (opened !== ARCHIVES.ad.length) throw new Error(`Only ${opened} of ${ARCHIVES.ad.length} archives could be opened.`);
  return A;
}

// ---------------------------------------------------------------------------------------------
// Movement-map headers

/**
 * A map's movement-map header (NNN.mmap) as the movement-map generator writes it: the navigation
 * mesh parameters for the map's tiles. `tiles` are [x, y] pairs: for a terrain file NNNYYXX.map
 * x = XX and y = YY, for a collision tile NNN_XX_YY.vmtile x = XX and y = YY. 28 bytes.
 */
export function navMeshHeader(tiles) {
  const GRID = Math.fround(533.3333);
  const seen = new Set();
  let xMax = 0;
  let yMax = 0;
  for (const [x, y] of tiles) {
    seen.add(x * 65536 + y);
    if (x > xMax) xMax = x;
    if (y > yMax) yMax = y;
  }
  const v = new DataView(new ArrayBuffer(28));
  v.setFloat32(0, Math.fround(Math.fround((32 - xMax) * GRID) - GRID), true);
  v.setFloat32(4, 1.1754943508222875e-38, true); // FLT_MIN: the height range is open
  v.setFloat32(8, Math.fround(Math.fround((32 - yMax) * GRID) - GRID), true);
  v.setFloat32(12, GRID, true);
  v.setFloat32(16, GRID, true);
  v.setInt32(20, seen.size, true);
  v.setInt32(24, -2147483648, true);
  return new Uint8Array(v.buffer);
}

/** Writes the header of every map with terrain that has none yet. Returns how many were written. */
async function terrainHeaders() {
  const tiles = new Map(); // map id -> [[x, y], ...]
  const add = (id, x, y) => {
    if (!tiles.has(id)) tiles.set(id, []);
    tiles.get(id).push([x, y]);
  };
  const terrain = new Set();
  for await (const name of (await dir('world/maps')).keys()) {
    if (!/^\d{7}\.map$/.test(name)) continue;
    const id = Number(name.slice(0, 3));
    terrain.add(id);
    add(id, Number(name.slice(5, 7)), Number(name.slice(3, 5)));
  }
  for await (const name of (await dir('world/vmaps')).keys()) {
    if (!/^\d{3}_\d\d_\d\d\.vmtile$/.test(name)) continue;
    add(Number(name.slice(0, 3)), Number(name.slice(4, 6)), Number(name.slice(7, 9)));
  }
  const out = await dir('world/mmaps');
  const have = new Set();
  for await (const name of out.keys()) have.add(name);
  let written = 0;
  for (const id of [...terrain].sort((a, b) => a - b)) {
    const name = `${String(id).padStart(3, '0')}.mmap`;
    if (have.has(name)) continue;
    await writeBytes(out, name, navMeshHeader(tiles.get(id)));
    written++;
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Stage: game tables (and the cinematic cameras, which the same tool writes)

async function stageDbc(ctx) {
  post({ type: 'progress', stage: 'dbc', done: 0, total: 2, detail: 'game tables' });
  const A = await ctx.ad();
  step(A, 'ad_dbc');
  const tables = await flushDir(A, '/out/dbc', await dir('world/dbc'));
  if (tables < 100) throw new Error(`Only ${tables} game tables were found in the archives.`);
  post({ type: 'progress', stage: 'dbc', done: 1, total: 2, detail: 'cameras' });
  step(A, 'ad_cameras');
  const cameras = await flushDir(A, '/out/Cameras', await dir('world/Cameras'));
  post({ type: 'progress', stage: 'dbc', done: 2, total: 2, detail: `${tables} tables, ${cameras} cameras` });
  ctx.state.dbc = true;
}

// ---------------------------------------------------------------------------------------------
// Stage: terrain. The tiles are shared out to a few workers of this same file; each converts rows
// of tiles and stores them.

const BATCH_TILES = 24;

async function stageMaps(ctx, only) {
  const A = await ctx.ad();
  const count = step(A, 'ad_maps_begin');
  const done = new Set(ctx.state.mapsDone || []);
  const plan = [];
  let total = 0;
  let already = 0;
  for (let z = 0; z < count; z++) {
    const tiles = step(A, 'ad_map_open', z);
    if (!tiles) continue;
    const id = step(A, 'ad_map_id', z);
    total += tiles;
    if (done.has(id)) {
      already += tiles;
      continue;
    }
    if (only && !only.includes(id)) continue;
    const rows = [];
    for (let y = 0; y < 64; y++) {
      let n = 0;
      for (let x = 0; x < 64; x++) n += A._ad_map_has(y, x);
      if (n) rows.push({ y, n });
    }
    plan.push({ z, id, name: A.UTF8ToString(step(A, 'ad_map_name', z)), rows, open: 0 });
  }
  // The two continents first: that is where every character starts.
  plan.sort((a, b) => (a.id > 1) - (b.id > 1) || a.z - b.z);
  const jobs = [];
  for (const map of plan) {
    let rows = [];
    let n = 0;
    for (const row of map.rows) {
      rows.push(row.y);
      n += row.n;
      if (n >= BATCH_TILES) {
        jobs.push({ map, rows, tiles: n });
        rows = [];
        n = 0;
      }
    }
    if (rows.length) jobs.push({ map, rows, tiles: n });
    map.open = jobs.filter((j) => j.map === map).length;
  }
  const outstanding = jobs.reduce((s, j) => s + j.tiles, 0);
  let converted = 0;
  let width = 1;
  let memory = 0;
  let lastPost = 0;
  const progress = (detail, force) => {
    const now = performance.now();
    if (!force && now - lastPost < 150) return;
    lastPost = now;
    post({ type: 'progress', stage: 'maps', done: already + converted, total, detail });
  };
  progress('', true);

  const finishJob = async (job, tiles) => {
    converted += tiles;
    progress(job.map.name);
    if (--job.map.open === 0) {
      done.add(job.map.id);
      ctx.state.mapsDone = [...done].sort((a, b) => a - b);
      await writeState(ctx.state);
    }
  };

  if (jobs.length) {
    width = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1, jobs.length));
    let next = 0;
    if (typeof Worker === 'function') {
      const workers = [];
      await Promise.all(Array.from({ length: width }, () => new Promise((resolve, reject) => {
        const w = new Worker(import.meta.url, { type: 'module' });
        workers.push(w);
        let job = null;
        const fail = (message) => {
          w.terminate();
          reject(new Error(message));
        };
        const give = () => {
          if (next >= jobs.length) {
            w.terminate();
            resolve();
            return;
          }
          job = jobs[next++];
          w.postMessage({ cmd: 'shard-rows', z: job.map.z, rows: job.rows });
        };
        w.onerror = (e) => fail(e.message || 'a terrain worker failed to start');
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'shard-ready') give();
          else if (m.type === 'shard-done') {
            memory = Math.max(memory, m.memory);
            finishJob(job, m.tiles).then(give, (err) => fail(err.message));
          }
          else if (m.type === 'log') log(m.line);
          else if (m.type === 'error') fail(m.message);
        };
        w.postMessage({ cmd: 'shard', files: archiveList() });
      }))).finally(() => workers.forEach((w) => w.terminate()));
    } else {
      width = 1;
      const to = await dir('world/maps');
      for (const job of jobs) {
        step(A, 'ad_map_open', job.map.z);
        let tiles = 0;
        for (const y of job.rows) tiles += step(A, 'ad_map_row', job.map.z, y);
        await flushDir(A, '/out/maps', to);
        memory = megabytes(A);
        await finishJob(job, tiles);
      }
    }
  }
  if (converted !== outstanding) throw new Error(`${converted} of ${outstanding} terrain tiles were written.`);
  progress('', true);
  if (plan.length) log(`terrain: ${converted} tiles of ${plan.length} maps, ${width} at a time, tool memory ${memory} MB each`);

  // Complete once every map with terrain is done (a run limited to some maps leaves the rest).
  let all = true;
  for (let z = 0; z < count; z++) if (step(A, 'ad_map_open', z) && !done.has(step(A, 'ad_map_id', z))) all = false;
  const headers = await terrainHeaders();
  if (headers) log(`movement-map headers: ${headers} maps with terrain`);
  if (all) {
    ctx.state.maps = true;
    ctx.state.mmapHeaders = true;
  }
  return all;
}

// A terrain worker: its own copy of the extractor, fed rows of tiles by the stage above.
let shard = null;

async function shardStart(msg) {
  given = archiveMap(msg.files);
  const A = await loadAd(await gameArchives(), () => {}, 24);
  step(A, 'ad_maps_begin');
  shard = { A, z: -1, to: await dir('world/maps') };
  post({ type: 'shard-ready' });
}

async function shardRows({ z, rows }) {
  const { A } = shard;
  if (shard.z !== z) {
    step(A, 'ad_map_open', z);
    shard.z = z;
  }
  let tiles = 0;
  for (const y of rows) tiles += step(A, 'ad_map_row', z, y);
  await flushDir(A, '/out/maps', shard.to);
  post({ type: 'shard-done', tiles, memory: megabytes(A) });
}

// ---------------------------------------------------------------------------------------------
// Stage: collision models. Two tools, as on a desktop: the extractor writes raw models (a scratch
// folder there), the assembler turns them into the collision files. Here the raw models go into one
// scratch file in storage as each is finished, and the assembler reads them back from it, so memory
// holds one model at a time. The tools run in a worker of this same file; each collision file it
// finishes is handed to this one, which stores it while the tools carry on.

/**
 * Sends every file a tool finishes writing under `prefix` to `onFile(name, bytes)`, which says how
 * many of its first bytes to keep in memory (the extractor looks at a finished model's header
 * again); the rest is dropped. `bytes` is only valid during the call.
 */
function sink(M, prefix, onFile, onRemove) {
  const FS = M.FS;
  const write = FS.write;
  const close = FS.close;
  const unlink = FS.unlink;
  FS.write = (stream, buffer, offset, length, position, canOwn) => {
    const n = write.call(FS, stream, buffer, offset, length, position, canOwn);
    if (n && stream.path && stream.path.startsWith(prefix)) stream.node.unsent = true;
    return n;
  };
  FS.close = (stream) => {
    const { node, path } = stream;
    close.call(FS, stream);
    if (node && node.unsent) {
      node.unsent = false;
      const keep = onFile(path.slice(prefix.length), node.usedBytes ? node.contents.subarray(0, node.usedBytes) : new Uint8Array(0));
      if (node.usedBytes > keep) FS.truncate(node, keep);
    }
  };
  FS.unlink = (path) => {
    unlink.call(FS, path);
    const plain = path.replace(/\/+/g, '/');
    if (plain.startsWith(prefix)) onRemove(plain.slice(prefix.length));
  };
}

/**
 * Makes one folder of a tool's file system find names whatever their case, keeping the spelling a
 * file was first created with: what the tools get on a Windows disk. They rely on it. The extractor
 * writes a model under the name one place spells in capitals and later asks for it by the name
 * another place spells in lower case; where that fails it leaves the object out, so a
 * case-sensitive folder ends with fewer objects in the collision data.
 */
export function foldCase(M, path) {
  const FS = M.FS;
  if (!FS.folded) {
    const folded = (FS.folded = new Map()); // folder node -> Map(lower-case name -> name as created)
    const lookupNode = FS.lookupNode;
    const createNode = FS.createNode;
    FS.lookupNode = (parent, name) => {
      const names = folded.get(parent);
      const lower = names && name.toLowerCase();
      const known = names && names.get(lower);
      if (known === undefined || known === name) return lookupNode.call(FS, parent, name);
      try {
        return lookupNode.call(FS, parent, known);
      } catch (e) {
        names.delete(lower); // removed since
        return lookupNode.call(FS, parent, name);
      }
    };
    FS.createNode = (parent, name, mode, rdev) => {
      const node = createNode.call(FS, parent, name, mode, rdev);
      const names = parent && folded.get(parent);
      if (names) {
        const lower = name.toLowerCase();
        let live = false;
        if (names.has(lower)) {
          try {
            lookupNode.call(FS, parent, names.get(lower));
            live = true;
          } catch {
            /* that one was removed */
          }
        }
        if (!live) names.set(lower, name);
      }
      return node;
    };
  }
  const node = FS.lookupPath(path).node;
  const names = new Map();
  for (const name of Object.keys(node.contents || {})) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  FS.folded.set(node, names);
}

/**
 * Runs the two tools. `emit.progress(done of 1000, detail)`, `emit.log(line)`, and
 * `emit.file(name, bytes)` for every finished collision file (bytes is the caller's to keep).
 */
async function collisionTools(emit) {
  const T0 = performance.now();
  // Progress never goes back (the extractor reads a few more buildings after the maps).
  let reached = 0;
  const progress = (done, detail) => emit.progress((reached = Math.max(reached, done)), detail);
  progress(0, 'reading buildings');
  const tmp = await dir('world/.tmp');
  const open = async (name) => (await tmp.getFileHandle(name, { create: true })).createSyncAccessHandle();

  // 1. The extractor: buildings and models out of the archives.
  const raw = await open('buildings.pack');
  const list = await open('dir_bin');
  const index = new Map(); // name -> [offset, length] in buildings.pack
  let rawEnd = 0;
  let listEnd = 0;
  let mapsTotal = 0;
  let mapsDone = 0;
  let models = 0;
  const X = await loadTool('vmap_extractor.js', (line) => {
    if (line.startsWith('Extracting ')) progress(Math.min(300, ++models / 12), mapsDone ? 'reading what stands on each map' : 'reading buildings');
    else if (line.startsWith('Map - ')) mapsTotal++;
    else if (line.startsWith('Processing Map ')) progress(300 + (300 * ++mapsDone) / Math.max(1, mapsTotal), 'reading what stands on each map');
    else if (/^(fatal|error)/i.test(line) && !line.startsWith('Error opening archive')) emit.log(line);
  });
  const files = await gameArchives();
  // The tool opens these two as well when they are there; nothing it reads is in them.
  const optional = ['texture.MPQ', 'base.MPQ'].filter((n) => files.has(n.toLowerCase()));
  mountArchives(X, files, [...ARCHIVES.vmaps, ...optional], 96);
  X.FS.mkdir('/out/Buildings');
  foldCase(X, '/out/Buildings');
  sink(X, '/out/Buildings/', (name, bytes) => {
    if (name === 'dir_bin') {
      // Appended to, tile by tile: with nothing of it kept, each piece arrives once.
      list.write(bytes, { at: listEnd });
      listEnd += bytes.length;
      return 0;
    }
    raw.write(bytes, { at: rawEnd });
    index.set(name, [rawEnd, bytes.length]);
    rawEnd += bytes.length;
    return 16;
  }, (name) => index.delete(name));
  const code = runMain(X, ['-d', '/gamefiles', '-o', '/out']);
  raw.flush();
  raw.close();
  list.flush();
  list.close();
  if (code !== 0) throw new Error(`The collision extractor stopped with code ${code}.`);
  if (index.size < 1000 || !listEnd) throw new Error(`The collision extractor found only ${index.size} models.`);
  const T1 = performance.now();
  emit.log(`collision models read: ${index.size} files, ${(rawEnd / 1048576).toFixed(0)} MB, ${((T1 - T0) / 1000).toFixed(1)} s, tool memory ${megabytes(X)} MB`);

  // 2. The assembler, reading the raw models back from the scratch file.
  const rawFile = await (await tmp.getFileHandle('buildings.pack')).getFile();
  const listFile = await (await tmp.getFileHandle('dir_bin')).getFile();
  const blobs = [{ name: 'dir_bin', data: listFile }];
  for (const [name, [at, length]] of index) blobs.push({ name, data: rawFile.slice(at, at + length) });
  let boundsDone = 0;
  let converted = 0;
  let count = 0;
  let vmoCount = 0;
  let bytesOut = 0;
  let complaint = null;
  const S = await loadTool('vmap_assembler.js', (line) => {
    if (line.startsWith('Calculating model bounds')) progress(600 + Math.min(250, ++boundsDone * 6), 'building collision trees');
    else if (line.startsWith('Converting ')) progress(850 + Math.min(150, ++converted / 40), 'converting models');
    else if (/^error|cannot open|could not/i.test(line)) {
      complaint ??= line;
      emit.log(line);
    }
  });
  S.FS.mkdir('/buildings');
  S.FS.mount(S.WORKERFS, { blobs }, '/buildings');
  foldCase(S, '/buildings');
  cacheReads(S, 96);
  S.FS.mkdir('/out/vmaps');
  sink(S, '/out/vmaps/', (name, bytes) => {
    count++;
    if (name.endsWith('.vmo')) vmoCount++;
    bytesOut += bytes.length;
    emit.file(name, bytes.slice());
    return 0;
  }, () => {});
  const code2 = runMain(S, ['/buildings', '/out/vmaps']);
  if (code2 !== 0) throw new Error(`The collision assembler stopped with code ${code2}.`);
  // It reports some failures only in words, and carries on with what it has.
  if (complaint) throw new Error(`The collision assembler reported: ${complaint}`);
  if (vmoCount < 1000) throw new Error(`The collision assembler converted only ${vmoCount} models.`);
  emit.log(`collision files built: ${count} files, ${(bytesOut / 1048576).toFixed(0)} MB, ${((performance.now() - T1) / 1000).toFixed(1)} s, tool memory ${megabytes(S)} MB`);
  return count;
}

async function stageVmaps(ctx) {
  let lastPost = 0;
  const progress = (done, detail, force) => {
    const now = performance.now();
    if (!force && now - lastPost < 200) return;
    lastPost = now;
    post({ type: 'progress', stage: 'vmaps', done: Math.round(done), total: 1000, detail });
  };
  // All or nothing: whatever an earlier run left is removed first.
  const world = await dir('world');
  await remove(world, '.tmp');
  await remove(world, 'vmaps');
  const to = await dir('world/vmaps');

  // Storing: up to eight files at a time.
  const queue = [];
  let active = 0;
  let stored = 0;
  let failed = null;
  let idle = null;
  let waiting = 0;
  let waitingMost = 0;
  const pump = () => {
    while (active < 8 && queue.length) {
      const [name, bytes] = queue.shift();
      active++;
      writeBytes(to, name, bytes).then(() => { stored++; }, (e) => { failed ??= e; }).finally(() => {
        active--;
        waiting -= bytes.length;
        pump();
        if (!active && !queue.length && idle) idle();
      });
    }
  };
  const hold = (name, bytes) => {
    waiting += bytes.length;
    if (waiting > waitingMost) waitingMost = waiting;
    queue.push([name, bytes]);
  };

  let count;
  if (typeof Worker === 'function') {
    count = await new Promise((resolve, reject) => {
      const w = new Worker(import.meta.url, { type: 'module' });
      w.onerror = (e) => reject(new Error(e.message || 'the collision worker failed to start'));
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'tools-file') {
          hold(m.name, m.bytes);
          pump();
        } else if (m.type === 'tools-progress') progress(m.done, m.detail);
        else if (m.type === 'log') log(m.line);
        else if (m.type === 'tools-done') {
          w.terminate();
          resolve(m.count);
        } else if (m.type === 'error') {
          w.terminate();
          reject(new Error(m.message));
        }
      };
      w.postMessage({ cmd: 'tools', files: archiveList() });
    });
  } else {
    // No workers inside workers here: the tools run in this one and the files wait until they end.
    count = await collisionTools({ progress, log, file: hold });
    pump();
  }
  if (active || queue.length) await new Promise((resolve) => { idle = resolve; });
  if (failed) throw failed;
  if (stored !== count) throw new Error(`${stored} of ${count} collision files were stored.`);
  await remove(world, '.tmp');
  log(`collision files stored: ${stored}; most waiting to be stored at once: ${(waitingMost / 1048576).toFixed(1)} MB`);
  progress(1000, `${stored} files`, true);
  ctx.state.vmaps = true;
}

// The collision tools' worker.
async function toolsStart(msg) {
  given = archiveMap(msg.files);
  const count = await collisionTools({
    progress: (done, detail) => post({ type: 'tools-progress', done, detail }),
    log,
    file: (name, bytes) => self.postMessage({ type: 'tools-file', name, bytes }, [bytes.buffer]),
  });
  post({ type: 'tools-done', count });
}

// ---------------------------------------------------------------------------------------------

let running = false;

async function run(msg) {
  if (running) throw new Error('An extraction is already running in this worker.');
  running = true;
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('This browser has no private file storage.');
    const wanted = STAGES.filter((s) => (msg.stages || STAGES).includes(s));
    const state = await readState();
    given = archiveMap(msg.files);
    const files = await gameArchives();
    let ad = null;
    const ctx = {
      state,
      // One copy of the map/table extractor for the stages that need it.
      ad: async () => (ad ??= await loadAd(files, (line) => { if (/error|invalid|unrecoverable/i.test(line)) log(line); }, 32)),
    };
    for (const stage of wanted) {
      if (state[stage] && !msg.force) {
        post({ type: 'done', stage });
        continue;
      }
      const t0 = performance.now();
      let complete = true;
      if (stage === 'dbc') await stageDbc(ctx);
      else if (stage === 'maps') {
        if (msg.force) state.mapsDone = [];
        complete = await stageMaps(ctx, Array.isArray(msg.maps) ? msg.maps.map(Number) : null);
      } else await stageVmaps(ctx);
      await writeState(state);
      log(`${stage}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      if (complete) post({ type: 'done', stage });
    }
    post({ type: 'finished', state });
  } finally {
    running = false;
  }
}

if (inWorker) {
  self.onmessage = (e) => {
    const msg = e.data || {};
    const fail = (err) => post({ type: 'error', message: String((err && err.message) || err) });
    if (msg.cmd === 'run') run(msg).catch(fail);
    else if (msg.cmd === 'status') readState().then((state) => post({ type: 'status', state }), fail);
    else if (msg.cmd === 'shard') shardStart(msg).catch(fail);
    else if (msg.cmd === 'shard-rows') shardRows(msg).catch(fail);
    else if (msg.cmd === 'tools') toolsStart(msg).catch(fail);
  };
}
