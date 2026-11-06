// Compares movement-map tiles (.mmtile) from two builds of the generator, section by section.
// Not part of the site.
//
//   node extract/test/compare-mmtiles.mjs <native mmaps folder> <other mmaps folder> [names...]
//
// Without names: every .mmtile and .mmap of the second folder. A tile is the generator's 20-byte
// header and one Detour navigation-mesh tile: its header, vertices, polygons, links, detail meshes,
// detail vertices, detail triangles, bounding-volume tree and off-mesh connections.

import fs from 'node:fs';
import path from 'node:path';

const [a, b, ...only] = process.argv.slice(2);
const names = (only.length ? only : fs.readdirSync(b).filter((n) => /\.(mmtile|mmap)$/.test(n))).sort();

const HEADER = ['magic', 'version', 'x', 'y', 'layer', 'userId', 'polyCount', 'vertCount', 'maxLinkCount', 'detailMeshCount',
  'detailVertCount', 'detailTriCount', 'bvNodeCount', 'offMeshConCount', 'offMeshBase'];

function parse(buf) {
  const t = { mmapMagic: buf.readUInt32LE(0), dtVersion: buf.readUInt32LE(4), mmapVersion: buf.readUInt32LE(8), size: buf.readUInt32LE(12), usesLiquids: buf[16] & 1 };
  const d = buf.subarray(20);
  const h = {};
  HEADER.forEach((k, i) => { h[k] = d.readInt32LE(4 * i); });
  h.floats = [];
  for (let i = 0; i < 10; i++) h.floats.push(d.readFloatLE(60 + 4 * i)); // walkable height, radius, climb, bmin, bmax, bv factor
  let o = 100;
  const take = (bytes) => { const s = d.subarray(o, o + bytes); o += bytes; return s; };
  const s = {
    verts: take(12 * h.vertCount),
    polys: take(32 * h.polyCount),
    links: take(16 * h.maxLinkCount),
    detailMeshes: take(12 * h.detailMeshCount),
    detailVerts: take(12 * h.detailVertCount),
    detailTris: take(4 * h.detailTriCount),
    bvTree: take(16 * h.bvNodeCount),
    offMeshCons: take(36 * h.offMeshConCount),
  };
  return { t, h, s, parsed: o, length: d.length };
}

const floats = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
function vertexDistance(x, y) { // largest per-coordinate difference, same order
  const fx = floats(Buffer.from(x)), fy = floats(Buffer.from(y));
  let m = 0;
  for (let i = 0; i < fx.length; i++) m = Math.max(m, Math.abs(fx[i] - fy[i]));
  return m;
}

let same = 0, differ = 0;
for (const n of names) {
  const fa = path.join(a, n), fb = path.join(b, n);
  if (!fs.existsSync(fa)) { console.log(`${n}: not in the native folder`); differ++; continue; }
  const A = fs.readFileSync(fa), B = fs.readFileSync(fb);
  if (A.equals(B)) { same++; console.log(`${n}: identical (${A.length} bytes)`); continue; }
  differ++;
  if (n.endsWith('.mmap')) { console.log(`${n}: header differs`); continue; }
  const pa = parse(A), pb = parse(B);
  const fields = [];
  for (const k of ['mmapMagic', 'dtVersion', 'mmapVersion', 'size', 'usesLiquids']) if (pa.t[k] !== pb.t[k]) fields.push(`${k} ${pa.t[k]}/${pb.t[k]}`);
  for (const k of HEADER) if (pa.h[k] !== pb.h[k]) fields.push(`${k} ${pa.h[k]}/${pb.h[k]}`);
  const fl = pa.h.floats.map((v, i) => Math.abs(v - pb.h.floats[i]));
  const sections = [];
  for (const k of Object.keys(pa.s)) {
    const x = pa.s[k], y = pb.s[k];
    if (x.length !== y.length) { sections.push(`${k}: ${x.length}/${y.length} bytes`); continue; }
    if (x.equals(y)) continue;
    let bytes = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) bytes++;
    const extra = k === 'verts' || k === 'detailVerts' ? `, largest coordinate difference ${vertexDistance(x, y).toPrecision(3)}` : '';
    sections.push(`${k}: ${bytes} of ${x.length} bytes${extra}`);
  }
  console.log(`${n}: ${A.length}/${B.length} bytes; polygons ${pa.h.polyCount}/${pb.h.polyCount}, vertices ${pa.h.vertCount}/${pb.h.vertCount}, detail triangles ${pa.h.detailTriCount}/${pb.h.detailTriCount}`);
  console.log(`   header fields that differ: ${fields.join(', ') || 'none'}; largest header float difference ${Math.max(...fl).toPrecision(3)}; padding after the liquids flag ${A.subarray(16, 20).toString('hex')}/${B.subarray(16, 20).toString('hex')}`);
  console.log(`   sections that differ: ${sections.join('; ') || 'none'}${pa.parsed !== pa.length || pb.parsed !== pb.length ? ' (did not parse to the end)' : ''}`);
}
console.log(`${names.length} files: ${same} identical, ${differ} not`);
process.exit(differ ? 1 : 0);
