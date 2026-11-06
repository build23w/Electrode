// Runs the wasm map/DBC extractor under Node on real folders, to compare its output with a native
// build's. Not part of the site.
//
//   node extract/test/node-ad.mjs <ad.js> <game Data folder> <output folder> [cli|steps]
//
// cli    the tool's own main: -d /gamefiles -o /out -e 7
// steps  the step interface the page uses, tiles in reverse order (the output must not depend on order)

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const [adJs, data, out, mode = 'cli'] = process.argv.slice(2);
if (!adJs || !data || !out) {
  console.error('usage: node-ad.mjs <ad.js> <game Data folder> <output folder> [cli|steps]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const { default: createAd } = await import(pathToFileURL(path.resolve(adJs)).href);
let lines = 0;
const M = await createAd({ print: () => { lines++; }, printErr: (s) => console.error(s) });
M.FS.mkdir('/gamefiles');
M.FS.mkdir('/out');
M.FS.mount(M.NODEFS, { root: path.resolve(data) }, '/gamefiles');
M.FS.mount(M.NODEFS, { root: path.resolve(out) }, '/out');

const t0 = performance.now();
if (mode === 'cli') {
  const code = M.callMain(['-d', '/gamefiles', '-o', '/out', '-e', '7']);
  console.log(`exit ${code}`);
} else {
  const opened = M.ccall('ad_open', 'number', ['string', 'string', 'number'], ['/gamefiles', '/out', 1]);
  console.log(`archives opened: ${opened}`);
  M.ccall('ad_dbc', null, [], []);
  M.ccall('ad_cameras', null, [], []);
  const maps = M.ccall('ad_maps_begin', 'number', [], []);
  let tiles = 0;
  for (let z = maps - 1; z >= 0; z--) {
    const n = M.ccall('ad_map_open', 'number', ['number'], [z]);
    if (!n) continue;
    for (let y = 63; y >= 0; y--) for (let x = 63; x >= 0; x--) tiles += M._ad_map_tile(z, y, x);
  }
  M.ccall('ad_close', null, [], []);
  console.log(`maps ${maps}, tiles written ${tiles}`);
}
const count = (d) => { try { return fs.readdirSync(path.join(out, d)).length; } catch { return 0; } };
console.log(`${((performance.now() - t0) / 1000).toFixed(1)} s, ${lines} lines printed, dbc ${count('dbc')}, maps ${count('maps')}, Cameras ${count('Cameras')}, heap ${(M.HEAPU8.length / 1048576).toFixed(0)} MB`);
