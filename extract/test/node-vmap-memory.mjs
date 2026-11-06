// Runs the wasm collision tools under Node the way the page does: output in the module's own file
// system, not in a folder on disk, with the raw-model folder made to ignore case as the worker makes
// it (--case-sensitive leaves that out, to see what it changes). Writes a hash list of the collision
// files ("sha256  vmaps/<name>" lines) to compare a browser run against. Not part of the site.
//
//   node extract/test/node-vmap-memory.mjs <tools folder> <game Data folder> <hash list to write> [<raw list to write>] [--case-sensitive]

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const fold = !argv.includes('--case-sensitive');
const [tools, data, hashList, rawList] = argv.filter((a) => a !== '--case-sensitive');
const { foldCase } = await import('../../web/extract-worker.js');
if (!tools || !data || !hashList) {
  console.error('usage: node-vmap-memory.mjs <tools folder> <game Data folder> <hash list to write> [<raw list to write>]');
  process.exit(2);
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function load(file) {
  const { default: create } = await import(pathToFileURL(path.resolve(tools, file)).href);
  return create({ print: () => {}, printErr: (s) => console.error(s) });
}
function main(M, argv) {
  const t0 = performance.now();
  let code;
  try {
    code = M.callMain(argv);
  } catch (e) {
    code = e && e.name === 'ExitStatus' ? e.status : (console.error(e), -1);
  }
  return { code, seconds: ((performance.now() - t0) / 1000).toFixed(1) };
}
const names = (M, dir) => M.FS.readdir(dir).filter((n) => n !== '.' && n !== '..');

const X = await load('vmap_extractor.js');
X.FS.mkdir('/gamefiles');
X.FS.mount(X.NODEFS, { root: path.resolve(data) }, '/gamefiles');
X.FS.mkdir('/out');
X.FS.mkdir('/out/Buildings');
if (fold) foldCase(X, '/out/Buildings');
const x = main(X, ['-d', '/gamefiles', '-o', '/out']);
const raw = names(X, '/out/Buildings');
console.log(`extractor: exit ${x.code}, ${x.seconds} s, ${raw.length} raw files`);
if (x.code !== 0) process.exit(1);
if (rawList) fs.writeFileSync(rawList, raw.sort().map((n) => `${sha(X.FS.readFile('/out/Buildings/' + n))}  ${n}`).join('\n') + '\n');

const S = await load('vmap_assembler.js');
S.FS.mkdir('/raw');
for (const n of raw) S.FS.writeFile('/raw/' + n, X.FS.readFile('/out/Buildings/' + n));
if (fold) foldCase(S, '/raw');
S.FS.mkdir('/out');
S.FS.mkdir('/out/vmaps');
const s = main(S, ['/raw', '/out/vmaps']);
const built = names(S, '/out/vmaps').sort();
console.log(`assembler: exit ${s.code}, ${s.seconds} s, ${built.length} collision files`);
if (s.code !== 0) process.exit(1);
fs.writeFileSync(hashList, built.map((n) => `${sha(S.FS.readFile('/out/vmaps/' + n))}  vmaps/${n}`).join('\n') + '\n');
