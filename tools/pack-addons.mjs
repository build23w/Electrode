// Packs the addons that come with the game for the site: every addon folder copied as it is to
// <out>/<Folder>/..., its notice files to <out>/licenses/, and <out>/index.json, which lists each
// folder with its .toc fields and its files (path, size, SHA-256) so the page can show the
// addons without fetching them and fetch only the ones that are on.
//
//   node tools/pack-addons.mjs --src <folder of addon folders> --licenses <folder> --out <site>/addons
//
// --licenses: the notice files of an addon are the files there named "<addon>-...", where
// <addon> is the folder's name in lower case without leading punctuation ("!Questie" -> questie-*).
// The source folders are only read. <out> is replaced, but only if it is empty or an earlier pack.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseToc } from '../web/lib/addons.js';

const args = process.argv.slice(2);
const opt = (name, required = true) => {
  const i = args.indexOf('--' + name);
  if (i < 0 || !args[i + 1]) {
    if (required) throw new Error(`missing --${name}`);
    return null;
  }
  return path.resolve(args[i + 1]);
};
const src = opt('src');
const licenses = opt('licenses', false);
const out = opt('out');

const MAX_FILES = 50000;
const MAX_DEPTH = 24;
const plain = (name) => name !== '' && name !== '.' && name !== '..' && !/[\\/:]/.test(name);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The files of one addon folder, relative paths with forward slashes; links are not followed.
function walk(dir, rel, depth, list) {
  if (depth > MAX_DEPTH) throw new Error(`${dir}: folders nested too deep for an addon`);
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name))) {
    if (!plain(e.name)) continue;
    const at = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), at, depth + 1, list);
    else if (e.isFile()) {
      if (list.length >= MAX_FILES) throw new Error(`${dir}: too many files for an addon`);
      list.push(at);
    }
  }
  return list;
}

// An addon is a folder holding a .toc of its own name (any case).
const addons = [];
for (const e of fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name))) {
  if (!e.isDirectory() || !plain(e.name)) continue;
  const dir = path.join(src, e.name);
  const toc = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isFile() && x.name.toLowerCase() === `${e.name}.toc`.toLowerCase());
  if (!toc) continue;
  addons.push({ folder: e.name, dir, toc: parseToc(fs.readFileSync(path.join(dir, toc.name))), files: walk(dir, '', 0, []) });
}
if (!addons.length) throw new Error(`no addon in ${src}: an addon is a folder holding a .toc file of the same name`);

// Replace <out> only when it is ours to replace.
if (fs.existsSync(out)) {
  const there = fs.readdirSync(out);
  if (there.length && !there.includes('index.json')) throw new Error(`${out} holds something else: not replaced`);
  const earlier = there.includes('index.json') ? JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')) : { addons: [] };
  for (const a of earlier.addons || []) if (plain(a.folder)) fs.rmSync(path.join(out, a.folder), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'licenses'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'index.json'), { force: true });
}
fs.mkdirSync(out, { recursive: true });

const index = { version: '', addons: [] };
const stamp = createHash('sha256');
let total = 0;
for (const a of addons) {
  const files = [];
  let bytes = 0;
  for (const rel of a.files) {
    const from = path.join(a.dir, rel);
    const to = path.join(out, a.folder, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const sum = sha256(from);
    if (sha256(to) !== sum) throw new Error(`${to}: the copy differs from ${from}`);
    const size = fs.statSync(from).size;
    files.push({ path: rel, size, sha256: sum });
    stamp.update(`${a.folder}/${rel}\0${size}\0${sum}\n`);
    bytes += size;
  }
  // The addon's notices: copied as they are, named in the index.
  const notices = [];
  if (licenses) {
    const prefix = a.folder.toLowerCase().replace(/^[^a-z0-9]+/, '') + '-';
    for (const name of fs.readdirSync(licenses).sort(byName)) {
      if (!name.toLowerCase().startsWith(prefix) || !fs.statSync(path.join(licenses, name)).isFile()) continue;
      fs.mkdirSync(path.join(out, 'licenses'), { recursive: true });
      fs.copyFileSync(path.join(licenses, name), path.join(out, 'licenses', name));
      stamp.update(`licenses/${name}\0${sha256(path.join(licenses, name))}\n`);
      notices.push(name);
    }
  }
  index.addons.push({ folder: a.folder, toc: a.toc, bytes, files, notices });
  total += bytes;
  console.log(`${a.folder}: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB${notices.length ? `, notices ${notices.join(', ')}` : ''}`);
}
// The pack's version is its contents: the same files give the same version.
index.version = stamp.digest('hex').slice(0, 16);
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
console.log(`pack ${index.version}: ${index.addons.length} addon(s), ${(total / 1048576).toFixed(1)} MiB, in ${out}`);
