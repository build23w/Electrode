// The Worker that builds movement maps (the meshes creatures find their way on) while the world
// runs: one tile when the world server needs it, or a whole map for a dungeon. It runs the core's
// own generator (compiled to WebAssembly, extract/movemapgen.*) on the terrain and collision files
// the extraction made, and stores each finished tile where the world server looks for it.
//
//   const w = new Worker(new URL('./mmap-worker.js', import.meta.url), { type: 'module' });
//   w.postMessage({ cmd: 'tile', map: 0, x: 48, y: 32 });
//
// in:   { cmd: 'tile', map, x, y }   build one tile. The three numbers are those of the file name,
//                                    in its order: world/mmaps/<map %03u><x %02d><y %02d>.mmtile
//       { cmd: 'map', map }          build a whole map with its header: for a map of buildings only
//                                    (a dungeon), whose header only the whole-map build writes
//       { cmd: 'config', workers }   how many tiles are built at a time (before the first request)
//       { cmd: 'status' }
// out:  { type: 'tile', map, x, y, ok, reason?, ms }             ms: from the request to the answer
//       { type: 'map', map, ok, files: [names], reason?, ms }
//         after a build both also carry buildMs (the build alone) and memory (the generator's, MB)
//       { type: 'status', ready, workers, waiting, building }
//       { type: 'log', line }
//       { type: 'error', message }
//
// reason, when ok is false:
//   'not-ready'    the terrain or the collision files are still being made (world/.extracted.json
//                  does not say maps and vmaps yet): ask again later
//   'empty'        the generator found nothing to walk on there and wrote no tile (open sea, the
//                  edge of a map). Remembered, so asking again costs nothing.
//   'has-terrain'  a whole-map request for a map with terrain: ask for its tiles instead
//   'no-such-map'  the map has neither terrain nor collision files
//   'failed'       the generator gave up; a log line says why
//
// Requests wait in a pile, the newest on top; one for a tile already waiting or being built is
// dropped (one answer). A tile that is already stored answers ok at once. A tile request for a map
// of buildings only builds the whole map, since that is the only way such a map gets its header.
//
// Storage (origin private file system): reads world/maps, world/vmaps and world/.extracted.json;
// writes world/mmaps/<tile>.mmtile and, for a map of buildings only, world/mmaps/NNN.mmap last.
// A file gets its name only once it is complete.
//
// Each build runs in a fresh copy of the generator inside a worker of this same file, so memory is
// what one tile needs, a few tiles at a time.

const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const TOOLS = new URL('./extract/', import.meta.url);

const post = (m) => self.postMessage(m);
const log = (line) => post({ type: 'log', line });

const pad = (n, width) => String(n).padStart(width, '0');
const tileName = (map, x, y) => `${pad(map, 3)}${pad(x, 2)}${pad(y, 2)}.mmtile`;
const headerName = (map) => `${pad(map, 3)}.mmap`;

// ---------------------------------------------------------------------------------------------
// Storage

async function dir(path, create = true) {
  let d = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

/** Stores a file under a scratch name and gives it its real name once it is complete. */
async function store(d, name, bytes) {
  const scratch = `${name}.part`;
  const handle = await d.getFileHandle(scratch, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
  if (typeof handle.move === 'function') {
    try {
      await d.removeEntry(name);
    } catch {
      /* not there */
    }
    await handle.move(name);
    return;
  }
  // No renaming in this browser: write the real name directly. A copy cut short by a closed tab
  // is told apart by its length (complete()).
  const real = await (await d.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    real.truncate(0);
    real.write(bytes, { at: 0 });
    real.flush();
  } finally {
    real.close();
  }
  await d.removeEntry(scratch);
}

/** Is this stored tile whole? Its header says how long the rest is. */
async function complete(d, name) {
  let file;
  try {
    file = await (await d.getFileHandle(name)).getFile();
  } catch {
    return false;
  }
  if (file.size < 20) return false;
  const head = new DataView(await file.slice(0, 16).arrayBuffer());
  return head.getUint32(0, true) === 0x4d4d4150 && file.size === 20 + head.getUint32(12, true); // 'MMAP'
}

async function exists(d, name) {
  try {
    await d.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, name) {
  try {
    return JSON.parse(await (await (await (await dir(path, false)).getFileHandle(name)).getFile()).text());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The coordinator: takes the requests, shares them out, answers

let wanted = 0;          // how many to build at a time, from 'config'; 0: by the processor
let inputs = null;       // { maps: [{ name, file }], vmaps: [...], terrain: Set, buildings: Set } once both are complete
let looking = null;      // the check for them, while it runs (requests arrive together)
const empty = new Set(); // tiles the generator wrote nothing for
let emptyLoading = null;
const pile = [];         // jobs waiting, the newest last
const known = new Map(); // key -> job, waiting or being built
const team = [];         // the build workers: { worker, job, ready }

const builderCount = () => wanted || Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 4)));

/** The terrain and collision files, once the extraction has finished both; null until then. */
function ready() {
  if (inputs) return Promise.resolve(inputs);
  looking ??= look().finally(() => { looking = null; });
  return looking;
}

async function look() {
  const state = await readJson('world', '.extracted.json');
  if (!state || !state.maps || !state.vmaps) return null;
  const list = async (path) => {
    const out = [];
    for await (const [name, handle] of (await dir(path, false)).entries()) if (handle.kind === 'file') out.push({ name, file: await handle.getFile() });
    return out;
  };
  const maps = (await list('world/maps')).filter((f) => /^\d{7}\.map$/.test(f.name));
  const vmaps = await list('world/vmaps');
  const terrain = new Set(maps.map((f) => Number(f.name.slice(0, 3))));
  const buildings = new Set(vmaps.filter((f) => /^\d{3}\.vmtree$/.test(f.name)).map((f) => Number(f.name.slice(0, 3))));
  inputs = { maps, vmaps, terrain, buildings };
  return inputs;
}

function loadEmpty() {
  emptyLoading ??= readJson('world/mmaps', '.empty.json').then((names) => { for (const name of names || []) empty.add(name); });
  return emptyLoading;
}

async function saveEmpty() {
  const d = await dir('world/mmaps');
  const access = await (await d.getFileHandle('.empty.json', { create: true })).createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(new TextEncoder().encode(JSON.stringify([...empty])), { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

function answer(job, result) {
  known.delete(job.key);
  const ms = Math.round(performance.now() - job.asked);
  const cost = result.buildMs === undefined ? {} : { buildMs: result.buildMs, memory: result.memory };
  for (const tile of job.tiles) {
    const name = tileName(job.map, tile.x, tile.y);
    const ok = job.kind === 'tile' ? result.ok : result.ok && result.files.includes(name);
    const reason = ok ? undefined : result.ok ? 'empty' : result.reason;
    post({ type: 'tile', map: job.map, x: tile.x, y: tile.y, ok, ...(reason ? { reason } : {}), ms, ...cost });
  }
  if (job.whole) post({ type: 'map', map: job.map, ok: result.ok, files: result.files || [], ...(result.ok ? {} : { reason: result.reason }), ms, ...cost });
}

async function finished(job, result) {
  if (job.kind === 'tile' && !result.ok && result.reason === 'empty') {
    empty.add(tileName(job.map, job.x, job.y));
    await saveEmpty();
  }
  if (!result.ok && result.reason === 'failed') for (const line of result.lines || []) log(line);
  answer(job, result);
}

function startBuilder() {
  const b = { worker: new Worker(import.meta.url, { type: 'module' }), job: null, ready: false };
  const lost = (message) => {
    const job = b.job;
    team.splice(team.indexOf(b), 1);
    b.worker.terminate();
    log(`movement-map builder stopped: ${message}`);
    if (job) answer(job, { ok: false, reason: 'failed', files: [] });
    share();
  };
  b.worker.onerror = (e) => lost(e.message || 'could not start');
  b.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'builder-ready') {
      b.ready = true;
      share();
    } else if (m.type === 'built') {
      const job = b.job;
      b.job = null;
      finished(job, m).then(share, (err) => post({ type: 'error', message: String(err.message || err) }));
    } else if (m.type === 'log') log(m.line);
    else if (m.type === 'error') lost(m.message);
  };
  b.worker.postMessage({ cmd: 'builder', maps: inputs.maps, vmaps: inputs.vmaps });
  team.push(b);
}

/** Gives waiting jobs to idle build workers, newest first; starts more as they are needed. */
function share() {
  if (typeof Worker !== 'function') {
    if (!share.busy && pile.length) {
      share.busy = true;
      const job = pile.pop();
      const t0 = performance.now();
      build(job).then((result) => finished(job, { ...result, buildMs: Math.round(performance.now() - t0) })).catch((err) => finished(job, { ok: false, reason: 'failed', files: [], lines: [String(err.message || err)] }))
        .finally(() => { share.busy = false; share(); });
    }
    return;
  }
  for (const b of team) {
    if (!pile.length) return;
    if (b.ready && !b.job) {
      b.job = pile.pop();
      b.worker.postMessage({ cmd: 'build', job: { kind: b.job.kind, map: b.job.map, x: b.job.x, y: b.job.y } });
    }
  }
  const starting = team.filter((b) => !b.ready).length;
  for (let n = Math.min(pile.length - starting, builderCount() - team.length); n > 0; n--) startBuilder();
}

async function request(msg) {
  const whole = msg.cmd === 'map';
  const map = Number(msg.map);
  const x = Number(msg.x);
  const y = Number(msg.y);
  const asked = performance.now();
  const refuse = (reason) => post(whole ? { type: 'map', map, ok: false, files: [], reason, ms: 0 } : { type: 'tile', map, x, y, ok: false, reason, ms: 0 });
  if (!Number.isInteger(map) || map < 0 || map > 999 || (!whole && !(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 64 && y >= 0 && y < 64))) {
    throw new Error(`not a ${whole ? 'map' : 'tile'} request: ${JSON.stringify(msg)}`);
  }
  const have = await ready();
  if (!have) return refuse('not-ready');
  if (!have.terrain.has(map) && !have.buildings.has(map)) return refuse('no-such-map');
  const out = await dir('world/mmaps');
  await loadEmpty();

  if (have.terrain.has(map)) {
    // A map with terrain: its header is there since the extraction; tiles are built one by one.
    if (whole) return refuse('has-terrain');
    const name = tileName(map, x, y);
    if (await complete(out, name)) return post({ type: 'tile', map, x, y, ok: true, ms: 0 });
    if (empty.has(name)) return refuse('empty');
    const key = `tile ${name}`;
    if (known.has(key)) return undefined;
    const job = { key, kind: 'tile', map, x, y, tiles: [{ x, y }], whole: false, asked };
    known.set(key, job);
    pile.push(job);
    return share();
  }

  // A map of buildings only: built whole. The header is stored last, so it means "all there".
  if (await exists(out, headerName(map))) {
    const files = [];
    for await (const name of out.keys()) if (name.startsWith(pad(map, 3)) && /\.(mmtile|mmap)$/.test(name)) files.push(name);
    if (whole) return post({ type: 'map', map, ok: true, files: files.sort(), ms: 0 });
    return files.includes(tileName(map, x, y)) ? post({ type: 'tile', map, x, y, ok: true, ms: 0 }) : refuse('empty');
  }
  const key = `map ${map}`;
  let job = known.get(key);
  if (!job) {
    job = { key, kind: 'map', map, tiles: [], whole: false, asked };
    known.set(key, job);
    pile.push(job);
  }
  if (whole) job.whole = true;
  else if (!job.tiles.some((t) => t.x === x && t.y === y)) job.tiles.push({ x, y });
  return share();
}

// ---------------------------------------------------------------------------------------------
// A builder: one job at a time, each in a fresh copy of the generator

let tool = null; // { create, compiled, config, offmesh, maps, vmaps }

/** Reads of a mounted file go through a small cache of 1 MB pieces (the tool reads a little at a time). */
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

async function loadTool(maps, vmaps) {
  const { default: create } = await import(new URL('movemapgen.js', TOOLS).href);
  const response = await fetch(new URL('movemapgen.wasm', TOOLS));
  if (!response.ok) throw new Error(`movemapgen.wasm: ${response.status}`);
  const compiled = await WebAssembly.compile(await response.arrayBuffer());
  const text = async (name) => {
    const r = await fetch(new URL(name, TOOLS));
    if (!r.ok) throw new Error(`${name}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  tool = { create, compiled, config: await text('config.json'), offmesh: await text('offmesh.txt'), maps, vmaps };
}

/** Runs the generator once. Returns { ok, files, reason?, lines?, memory }. */
async function build(job) {
  if (!tool) {
    const have = await ready();
    await loadTool(have.maps, have.vmaps);
  }
  const lines = [];
  const M = await tool.create({
    print: (s) => lines.push(s),
    printErr: (s) => lines.push(s),
    // The compiled program is shared; each build gets its own memory.
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(tool.compiled, imports).then(done);
    },
  });
  M.FS.mkdir('/work');
  M.FS.mkdir('/work/maps');
  M.FS.mkdir('/work/vmaps');
  M.FS.mkdir('/work/mmaps');
  M.FS.mount(M.WORKERFS, { blobs: tool.maps.map((f) => ({ name: f.name, data: f.file })) }, '/work/maps');
  M.FS.mount(M.WORKERFS, { blobs: tool.vmaps.map((f) => ({ name: f.name, data: f.file })) }, '/work/vmaps');
  cacheReads(M, 48);
  M.FS.writeFile('/config.json', tool.config);
  M.FS.writeFile('/offmesh.txt', tool.offmesh);

  const args = ['--silent', '--configInputPath', '/config.json', '--offMeshInput', '/offmesh.txt', '--workdir', '/work/', '--threads', '1', String(job.map)];
  // The generator's --tile takes the file name's last number first.
  if (job.kind === 'tile') args.push('--tile', `${job.y},${job.x}`);
  let code;
  try {
    code = M.callMain(args);
  } catch (e) {
    if (e && e.name === 'ExitStatus') code = e.status;
    else {
      lines.push(String((e && e.message) || e));
      code = -1;
    }
  }
  const memory = Math.round(M.HEAPU8.length / 1048576);
  const trouble = () => lines.filter((l) => /fail|error|unable|not exist|invalid|abort/i.test(l)).slice(-6);
  if (code !== 0) return { ok: false, reason: 'failed', files: [], lines: [`generator exit ${code}`, ...trouble()], memory };

  const made = M.FS.readdir('/work/mmaps').filter((n) => n !== '.' && n !== '..');
  const out = await dir('world/mmaps');
  const header = headerName(job.map);
  const files = [];
  if (job.kind === 'tile') {
    const name = tileName(job.map, job.x, job.y);
    if (!made.includes(name)) return { ok: false, reason: 'empty', files: [], memory };
    await store(out, name, M.FS.readFile('/work/mmaps/' + name));
    files.push(name);
    // A map with terrain has its header since the extraction; the generator's is the same.
    if (made.includes(header) && !(await exists(out, header))) await store(out, header, M.FS.readFile('/work/mmaps/' + header));
  } else {
    const tiles = made.filter((n) => n.endsWith('.mmtile')).sort();
    if (!tiles.length || !made.includes(header)) return { ok: false, reason: 'failed', files: [], lines: ['the generator wrote no tiles for this map', ...trouble()], memory };
    for (const name of tiles) {
      await store(out, name, M.FS.readFile('/work/mmaps/' + name));
      files.push(name);
    }
    await store(out, header, M.FS.readFile('/work/mmaps/' + header)); // last: it says the map is complete
    files.push(header);
  }
  return { ok: true, files, memory };
}

async function beginBuilding(msg) {
  await loadTool(msg.maps, msg.vmaps);
  post({ type: 'builder-ready' });
}

async function buildOne(msg) {
  const t0 = performance.now();
  let result;
  try {
    result = await build(msg.job);
  } catch (e) {
    result = { ok: false, reason: 'failed', files: [], lines: [String((e && e.message) || e)] };
  }
  post({ type: 'built', ...result, buildMs: Math.round(performance.now() - t0) });
}

// ---------------------------------------------------------------------------------------------

if (inWorker) {
  self.onmessage = (e) => {
    const msg = e.data || {};
    const fail = (err) => post({ type: 'error', message: String((err && err.message) || err) });
    if (msg.cmd === 'tile' || msg.cmd === 'map') request(msg).catch(fail);
    else if (msg.cmd === 'config') wanted = Math.max(0, Math.min(8, Number(msg.workers) || 0));
    else if (msg.cmd === 'status') {
      ready().then((have) => post({ type: 'status', ready: !!have, workers: team.length, waiting: pile.length, building: team.filter((b) => b.job).length }), fail);
    } else if (msg.cmd === 'builder') beginBuilding(msg).catch(fail);
    else if (msg.cmd === 'build') buildOne(msg).catch(fail);
  };
}
