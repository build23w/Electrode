// The browser's archive reader (web/lib/mpq.js) against the native chain, byte for byte.
//
// Needs a 1.12.1 Data folder and a running native host that serves the same folder at /data
// (wenilla-host). Without them the test is skipped.
//
//   ELECTRODE_WEB_GAMEFILES    the Data folder
//   ELECTRODE_WEB_NATIVE_DATA  the native host's origin, for example http://127.0.0.1:8090
//   ELECTRODE_WEB_MANIFESTS    folder holding boot-manifest.json and world-manifest.json (optional)
//   ELECTRODE_WEB_SAMPLE       random names to compare, default 2000; "all" compares every name
//   ELECTRODE_WEB_EXPECTED     write the SHA-256 list the browser check reads to this file (optional)
//
//   node --test test/gamefiles-chain.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(here, '..', 'web', 'lib', 'mpq.js'));
const { Chain, MpqError, encodeName, contentType, nameFromPath } = globalThis.ElectrodeMpq;

const DATA = process.env.ELECTRODE_WEB_GAMEFILES || '';
const NATIVE = (process.env.ELECTRODE_WEB_NATIVE_DATA || '').replace(/\/+$/, '');
const MANIFESTS = process.env.ELECTRODE_WEB_MANIFESTS || '';
const SAMPLE = process.env.ELECTRODE_WEB_SAMPLE || '2000';
const EXPECTED = process.env.ELECTRODE_WEB_EXPECTED || '';
const skip = !DATA || !NATIVE ? 'set ELECTRODE_WEB_GAMEFILES and ELECTRODE_WEB_NATIVE_DATA' : false;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fileSource(dir, name) {
  const fd = fs.openSync(path.join(dir, name), 'r');
  const size = fs.fstatSync(fd).size;
  return {
    name,
    size,
    read: (offset, length) =>
      new Promise((resolve, reject) => {
        const buf = Buffer.allocUnsafe(length);
        fs.read(fd, buf, 0, length, offset, (err, n) => (err ? reject(err) : resolve(new Uint8Array(buf.buffer, buf.byteOffset, n))));
      }),
    close: () => fs.closeSync(fd),
  };
}

// What the reader answers for a name, in the terms of the host's route: a status and a body.
async function mine(chain, name) {
  try {
    return { status: 200, body: Buffer.from(await chain.read(name)) };
  } catch (e) {
    if (e instanceof MpqError && e.kind === 'missing') return { status: 404, body: Buffer.alloc(0) };
    return { status: 500, body: Buffer.alloc(0), error: e };
  }
}

async function native(name, method = 'GET') {
  const r = await fetch(`${NATIVE}/data/${encodeName(name)}`, { method, headers: { 'accept-encoding': 'identity' } });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type'), cache: r.headers.get('cache-control') };
}

async function pool(items, width, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

function manifestNames(file) {
  if (!MANIFESTS) return [];
  const names = JSON.parse(fs.readFileSync(path.join(MANIFESTS, file), 'utf8')).names;
  return names.filter((n) => n !== '__index');
}

test('archive reader matches the native chain', { skip, timeout: 3600_000 }, async () => {
  const sources = fs.readdirSync(DATA).filter((n) => fs.statSync(path.join(DATA, n)).isFile()).map((n) => fileSource(DATA, n));
  try {
    let t = performance.now();
    const chain = await Chain.open(sources);
    const openMs = performance.now() - t;
    console.log(`chain open: ${chain.archives.length} archives (${chain.archives.map((a) => a.name).join(', ')}) in ${openMs.toFixed(0)} ms`);

    // The whole index, as bytes.
    t = performance.now();
    const index = Buffer.from(await chain.indexJson());
    const indexMs = performance.now() - t;
    const nativeIndex = Buffer.from(await (await fetch(`${NATIVE}/data/__index`, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer());
    const names = JSON.parse(index.toString('utf8'));
    console.log(`index: ${names.length} names, ${index.length} bytes, built in ${indexMs.toFixed(0)} ms`);
    assert.equal(index.length, nativeIndex.length, 'index length');
    assert.ok(index.equals(nativeIndex), 'index bytes');

    const boot = manifestNames('boot-manifest.json');
    const world = manifestNames('world-manifest.json');
    let sample;
    if (SAMPLE === 'all') sample = names.slice();
    else {
      const rand = rng(0x5eed1e55);
      const picked = new Set();
      const want = Math.min(Number(SAMPLE) || 2000, names.length);
      while (picked.size < want) picked.add(names[Math.floor(rand() * names.length)]);
      sample = [...picked];
    }

    // Names a patch deleted: listed by a lower archive, resolved to a delete marker.
    const tombstoned = [];
    for (const archive of chain.archives) {
      let listfile;
      try { listfile = await archive.readFile('(listfile)'); } catch { continue; }
      for (const raw of new TextDecoder('utf-8', { ignoreBOM: true }).decode(listfile).split(/[;\r\n]/)) {
        const name = raw.trim();
        if (!name || tombstoned.length >= 40 || tombstoned.includes(name)) continue;
        const probe = chain.probe(name);
        if (probe instanceof MpqError && /deleted from patch chain/.test(probe.message)) tombstoned.push(name);
      }
    }
    const missing = ['No\\Such\\File.blp', 'Interface\\FrameXML\\NotThere.lua', 'x', '(nothing)', 'World\\Maps\\Azeroth\\Azeroth_99_99.adt', 'a%b', 'café\\menü.txt'];

    // The same file under other spellings: case and separators must not matter.
    const rand2 = rng(0xc0ffee);
    const spellings = [];
    for (let i = 0; i < 60; i++) {
      const n = names[Math.floor(rand2() * names.length)];
      spellings.push([n, n.toUpperCase()], [n, n.toLowerCase()], [n, n.replace(/\\/g, '/')]);
    }

    const stats = { compared: 0, bytes: 0, mismatches: [], mineMs: 0 };
    const hashes = new Map();
    const compare = async (name, askNativeAs = name) => {
      const t0 = performance.now();
      const a = await mine(chain, askNativeAs);
      stats.mineMs += performance.now() - t0;
      const b = await native(askNativeAs);
      stats.compared++;
      stats.bytes += b.body.length;
      if (a.status !== b.status || !a.body.equals(b.body)) {
        stats.mismatches.push({ name: askNativeAs, mine: a.status, native: b.status, mineBytes: a.body.length, nativeBytes: b.body.length, error: a.error && a.error.message });
        return;
      }
      if (b.status === 200) {
        if (b.type !== contentType(askNativeAs)) stats.mismatches.push({ name: askNativeAs, contentType: [contentType(askNativeAs), b.type] });
        if (!hashes.has(name) && askNativeAs === name) hashes.set(name, [sha256(b.body), b.body.length]);
      }
      // The route's own decoding of the name must give the name back.
      if (nameFromPath(encodeName(askNativeAs)) !== askNativeAs.replace(/\//g, '\\')) stats.mismatches.push({ name: askNativeAs, decode: nameFromPath(encodeName(askNativeAs)) });
    };

    t = performance.now();
    const all = [...new Set([...boot, ...world, ...sample])];
    await pool(all, 12, (n) => compare(n));
    await pool(missing, 4, (n) => compare(n));
    await pool(tombstoned, 4, (n) => compare(n));
    await pool(spellings, 8, ([n, as]) => compare(n, as));
    const totalMs = performance.now() - t;

    // HEAD answers the same status without a body.
    const heads = [...boot.slice(0, 40), ...missing, ...tombstoned.slice(0, 10)];
    let headMismatches = 0;
    await pool(heads, 8, async (n) => {
      const probe = chain.probe(n);
      const status = probe === 'ok' ? 200 : probe.kind === 'missing' ? 404 : 500;
      const b = await native(n, 'HEAD');
      if (status !== b.status || b.body.length !== 0) headMismatches++;
    });

    console.log(`compared ${stats.compared} reads (${boot.length} boot, ${world.length} world, ${sample.length} sampled, ${missing.length} missing, ${tombstoned.length} deleted by a patch, ${spellings.length} respelled), ${(stats.bytes / 1048576).toFixed(1)} MiB, in ${(totalMs / 1000).toFixed(1)} s`);
    console.log(`reader alone: ${(stats.mineMs / 1000).toFixed(1)} s summed across the pool; HEAD checks ${heads.length}, mismatches ${headMismatches}`);
    if (stats.mismatches.length) console.log('MISMATCHES', JSON.stringify(stats.mismatches.slice(0, 20), null, 1));
    assert.equal(stats.mismatches.length, 0, 'read mismatches');
    assert.equal(headMismatches, 0, 'HEAD mismatches');
    // The delete markers live in patch.MPQ: a folder without it has none to test.
    if (chain.archives.some((a) => a.name.toLowerCase() === 'patch.mpq')) assert.ok(tombstoned.length > 0, 'no deleted names found to test');

    if (EXPECTED) {
      const entry = (n) => [n, ...(hashes.get(n) || [null, 0])];
      const browserSample = SAMPLE === 'all' ? sample.filter((_, i) => i % Math.ceil(sample.length / 2000) === 0) : sample;
      fs.mkdirSync(path.dirname(EXPECTED), { recursive: true });
      fs.writeFileSync(EXPECTED, JSON.stringify({
        version: 1,
        index: { sha256: sha256(index), bytes: index.length, count: names.length },
        boot: boot.map(entry),
        world: world.map(entry),
        sample: browserSample.map(entry),
        missing,
        tombstoned,
      }));
      console.log(`wrote ${EXPECTED}`);
    }
  } finally {
    for (const s of sources) s.close();
  }
});
