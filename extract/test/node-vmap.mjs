// Runs the wasm collision tools under Node on real folders, to compare their output with a native
// build's. Not part of the site.
//
//   node extract/test/node-vmap.mjs <tools folder> <game Data folder> <output folder> [--buildings <folder>]
//
// <tools folder> holds vmap_extractor.js and vmap_assembler.js. Writes <output>/Buildings (the
// extractor's raw models) and <output>/vmaps (the assembler's result). With --buildings the
// extractor is skipped and the assembler reads that folder of raw models instead (a native
// extractor's, to compare the assemblers alone).

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const args = process.argv.slice(2);
const bi = args.indexOf('--buildings');
const buildings = bi >= 0 ? args.splice(bi, 2)[1] : null;
const [tools, data, out] = args;
if (!tools || !data || !out) {
  console.error('usage: node-vmap.mjs <tools folder> <game Data folder> <output folder> [--buildings <folder>]');
  process.exit(2);
}
fs.mkdirSync(path.join(out, 'vmaps'), { recursive: true });

async function tool(file, argv, mounts) {
  const { default: create } = await import(pathToFileURL(path.resolve(tools, file)).href);
  let lines = 0;
  const M = await create({ print: () => { lines++; }, printErr: (s) => console.error(s) });
  for (const [at, root] of Object.entries(mounts)) {
    M.FS.mkdir(at);
    M.FS.mount(M.NODEFS, { root: path.resolve(root) }, at);
  }
  const t0 = performance.now();
  let code;
  try {
    code = M.callMain(argv);
  } catch (e) {
    code = e && e.name === 'ExitStatus' ? e.status : (console.error(e), -1);
  }
  console.log(`${file}: exit ${code}, ${((performance.now() - t0) / 1000).toFixed(1)} s, ${lines} lines printed, heap ${(M.HEAPU8.length / 1048576).toFixed(0)} MB`);
  return code;
}

if (!buildings) {
  if (await tool('vmap_extractor.js', ['-d', '/gamefiles', '-o', '/out'], { '/gamefiles': data, '/out': out }) !== 0) process.exit(1);
  console.log(`Buildings: ${fs.readdirSync(path.join(out, 'Buildings')).length} files`);
}
const mounts = { '/out': out };
if (buildings) mounts['/raw'] = buildings;
if (await tool('vmap_assembler.js', [buildings ? '/raw' : '/out/Buildings', '/out/vmaps'], mounts) !== 0) process.exit(1);
console.log(`vmaps: ${fs.readdirSync(path.join(out, 'vmaps')).length} files`);
