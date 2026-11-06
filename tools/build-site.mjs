// Assembles the site as it is published: the page (web/), the compiled parts (game client, world
// server, extractors, databases, shipped addons) and the license notices, in one folder.
//
//   node tools/build-site.mjs --built <dir> --out <dir> [--scan]
//
// --built  the folder the build steps wrote their output to (client/, server/, extract/, db/, addons/,
//          boot-manifest.json, world-manifest.json): see README "Building"
// --out    the folder to write; it is emptied first
// --scan   run tools/scan-identity.mjs on the result and fail if anything of the build machine is in it
//
// Development pages (web/dev*, <built>/dev*) are left out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanIdentity } from './scan-identity.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : null;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = opt('built');
const out = opt('out');
if (!built || !out) {
  console.error('usage: node tools/build-site.mjs --built <dir> --out <dir> [--scan]');
  process.exit(2);
}

const skip = (name) => /^dev(-|$)/.test(name) || name === '.DS_Store' || name === 'Thumbs.db';
function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (!skip(name)) copy(path.join(from, name), path.join(to, name));
  } else {
    fs.copyFileSync(from, to);
  }
}

// Keep a .git folder in the output if there is one (the output can be a checkout of the pages branch).
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(out)) if (name !== '.git') fs.rmSync(path.join(out, name), { recursive: true, force: true });

copy(path.join(root, 'web'), out);
for (const part of ['client', 'server', 'extract', 'db', 'addons', 'boot-manifest.json', 'world-manifest.json']) {
  const from = path.join(built, part);
  if (!fs.existsSync(from)) throw new Error(`missing in --built: ${part}`);
  copy(from, path.join(out, part));
}
copy(path.join(root, 'licenses'), path.join(out, 'licenses'));
fs.copyFileSync(path.join(root, 'LICENSES.md'), path.join(out, 'licenses', 'LICENSES.md'));
// The host must serve every file as it is (folders starting with "!" or "_" included).
fs.writeFileSync(path.join(out, '.nojekyll'), '');

let files = 0;
let bytes = 0;
const largest = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else {
      files++;
      bytes += st.size;
      largest.push([st.size, path.relative(out, p)]);
    }
  }
})(out);
largest.sort((a, b) => b[0] - a[0]);
console.log(`${files} files, ${(bytes / 1e6).toFixed(1)} MB -> ${out}`);
for (const [size, name] of largest.slice(0, 5)) console.log(`  ${(size / 1e6).toFixed(1).padStart(6)} MB  ${name}`);
if (largest[0][0] > 100e6) throw new Error(`${largest[0][1]} is larger than 100 MB: the host refuses files that size`);

if (args.includes('--scan')) {
  const found = scanIdentity([out]);
  for (const f of found) for (const h of f.hits) console.log(`${f.file}: ${h.count} x "${h.text}"  e.g. ${h.sample}`);
  if (found.length) {
    console.error(`${found.length} file(s) carry the build machine's identity: not publishable`);
    process.exit(1);
  }
  console.log('scan: nothing of the build machine found');
}
