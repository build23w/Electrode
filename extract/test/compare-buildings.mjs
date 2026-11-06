// Compares two raw-model folders written by the collision extractor (Buildings/), one from a native
// build and one from the wasm build. Not part of the site.
//
//   node extract/test/compare-buildings.mjs <native Buildings> <wasm Buildings>
//
// Three things in these folders are not fixed by the extractor's source, so a byte comparison of two
// different builds cannot pass:
//   - the objects inside a building are numbered in the order of a std::unordered_set, which each
//     standard library walks differently: the same objects get different numbers and a different
//     order in dir_bin;
//   - a liquid header is written with two bytes of padding the extractor never sets;
//   - an object's angles come out of the C library's asin/atan2, whose last digits differ between
//     C libraries.
// So this checks: every model file identical once the padding bytes are masked; dir_bin with the
// same entries, numbers aside, where an entry may differ from its partner only by rounding.

import fs from 'node:fs';
import path from 'node:path';

const [a, b] = process.argv.slice(2);
const names = fs.readdirSync(a).sort();
const other = new Set(fs.readdirSync(b));

// --- model files

/** Offsets of the two padding bytes of every liquid header in a raw building file, or null if it does not parse. */
function liquidPadding(buf) {
  const out = [];
  if (buf.length < 20 || buf.toString('latin1', 0, 7) !== 'VMAPs05') return null;
  let o = 12;
  const groups = buf.readUInt32LE(o);
  o += 8;
  for (let g = 0; g < groups; g++) {
    o += 36; // flags, group id, bounds, liquid flags
    for (const tag of ['GRP ', 'INDX', 'VERT']) {
      if (o + 8 > buf.length || buf.toString('latin1', o, o + 4) !== tag) return null;
      o += 8 + buf.readInt32LE(o + 4);
    }
    if (o + 40 <= buf.length && buf.toString('latin1', o, o + 4) === 'LIQU') {
      // header (32 bytes with its padding), one height per vertex, one byte per tile
      const h = o + 8;
      out.push(h + 30, h + 31);
      o = h + 32 + 4 * buf.readInt32LE(h) * buf.readInt32LE(h + 4) + buf.readInt32LE(h + 8) * buf.readInt32LE(h + 12);
    }
  }
  return o === buf.length ? out : null;
}

let identical = 0, paddingOnly = 0, different = 0, missing = 0;
const bad = [];
for (const n of names) {
  if (n === 'dir_bin') continue;
  if (!other.has(n)) { missing++; bad.push(`missing: ${n}`); continue; }
  const A = fs.readFileSync(path.join(a, n));
  const B = fs.readFileSync(path.join(b, n));
  if (A.equals(B)) { identical++; continue; }
  const pad = A.length === B.length ? liquidPadding(A) : null;
  if (pad) {
    for (const at of pad) { A[at] = 0; B[at] = 0; }
    if (A.equals(B)) { paddingOnly++; continue; }
  }
  different++;
  bad.push(`different: ${n}`);
}
const extra = [...other].filter((n) => !names.includes(n));
console.log(`model files: ${names.length - 1} expected; ${identical} identical, ${paddingOnly} identical but for liquid-header padding, ${different} different, ${missing} missing, ${extra.length} extra`);
for (const l of bad.slice(0, 10)) console.log('  ' + l);

// --- dir_bin: map, tile x, tile y, flags (u32 each), set (u16), object number (u32), position,
// angles (3 floats each), scale (float), bounds (6 floats, if flags & 4), name length (u32), name.

function entries(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  const ids = new Set();
  let o = 0;
  while (o < buf.length) {
    const start = o;
    const flags = buf.readUInt32LE(o + 12);
    ids.add(buf.readUInt32LE(o + 18));
    const floats = [];
    for (let i = 0; i < 7; i++) floats.push(buf.readFloatLE(o + 22 + 4 * i));
    o += 50 + (flags & 4 ? 24 : 0);
    const nameAt = o + 4;
    o = nameAt + buf.readUInt32LE(o);
    out.push({
      where: buf.toString('hex', start, start + 18) + buf.toString('hex', start + 50, o), // all but number and the 7 floats
      exact: buf.toString('hex', start + 22, start + 50),
      floats,
    });
  }
  return { list: out, objects: ids.size, bytes: buf.length };
}
const na = entries(path.join(a, 'dir_bin'));
const nb = entries(path.join(b, 'dir_bin'));
const count = new Map();
for (const e of nb.list) { const k = e.where + e.exact; count.set(k, (count.get(k) || 0) + 1); }
const left = [];
for (const e of na.list) { const k = e.where + e.exact; const n = count.get(k) || 0; if (n) count.set(k, n - 1); else left.push(e); }
const pool = new Map();
for (const e of nb.list) {
  const k = e.where + e.exact;
  const n = count.get(k) || 0;
  if (!n) continue;
  count.set(k, n - 1);
  if (!pool.has(e.where)) pool.set(e.where, []);
  pool.get(e.where).push(e);
}
let rounding = 0, unpaired = 0, worstPosition = 0, worstAngle = 0;
for (const e of left) {
  const candidates = pool.get(e.where) || [];
  let best = -1, bestDistance = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    let d = 0;
    for (let j = 0; j < 7; j++) d += Math.abs(candidates[i].floats[j] - e.floats[j]);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  if (best < 0) { unpaired++; continue; }
  const m = candidates.splice(best, 1)[0];
  const position = Math.max(...[0, 1, 2].map((j) => Math.abs(m.floats[j] - e.floats[j])));
  const angle = Math.max(...[3, 4, 5].map((j) => Math.abs(m.floats[j] - e.floats[j])));
  if (position <= 0.002 && angle <= 0.0001 && m.floats[6] === e.floats[6]) {
    rounding++;
    worstPosition = Math.max(worstPosition, position);
    worstAngle = Math.max(worstAngle, angle);
  } else unpaired++;
}
for (const c of pool.values()) unpaired += c.length;
console.log(`dir_bin: ${na.bytes} / ${nb.bytes} bytes, ${na.list.length} / ${nb.list.length} entries, ${na.objects} / ${nb.objects} objects`);
console.log(`  entries identical (number aside): ${na.list.length - left.length}; differing only by rounding: ${rounding} (largest: ${worstPosition} in a position, ${worstAngle} degrees in an angle); without a partner: ${unpaired}`);
process.exit(different || missing || extra.length || unpaired || na.list.length !== nb.list.length || na.objects !== nb.objects ? 1 : 0);
