// The addons code that needs no browser: .toc reading and the tab's rows (against the desktop
// launcher's own module where it is at hand), which folders count as addons, the .zip reader, the
// game's AddOns folder as the reader serves it, and the pack tool.
//
//   ELECTRODE_DESKTOP_ADDONS  the desktop launcher's src/world/addons.js (optional)
//   ELECTRODE_WEB_ADDONS      a folder of shipped addon folders to compare on (optional)
//
//   node --test test/addons.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseToc, stripColors, addonRows, findAddonFolders, unzip } from '../web/lib/addons.js';

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(here, '..', 'web', 'lib', 'mpq.js'));
const { addonFolder, addonsRoute } = globalThis.ElectrodeMpq;

const DESKTOP = process.env.ELECTRODE_DESKTOP_ADDONS || '';
const SHIPPED = process.env.ELECTRODE_WEB_ADDONS || '';

function tempDir(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `electrode-web-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tree(base, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

// Made-up addons that exercise the .toc reading: a byte-order mark, colour codes, CRLF, a key
// given twice, text that is not UTF-8, no title, and odd spacing.
const MADE_UP = {
  'CoolBars/CoolBars.toc': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('## Interface: 11200\r\n## Title: |cFF00FF00Cool|r Bars |cffff8800v2|r\r\n## Notes: Bars, but |cFFFFFFFFcool|r\r\n## Author: |cFF112233Someone|r\r\n## Version: 2.0\r\n## Title: Second title is ignored\r\nCoolBars.lua\r\n')]),
  'CoolBars/CoolBars.lua': 'print("bars")',
  'Gebaeude/gebaeude.TOC': Buffer.concat([Buffer.from('## Interface: 20400\n## Notes: Geb'), Buffer.from([0xe4]), Buffer.from('ude z'), Buffer.from([0xe4]), Buffer.from('hlen\n##Version:1\n##  Author  :   Jemand   \n')]),
  'Plain/Plain.toc': 'Plain.lua\n# a comment\n## X-Website: example\n',
  'NotAnAddon/Other.toc': '## Title: not listed\n',
  '!questie/!Questie.toc': '## Title: My own Questie\n## Version: 9\n',
};

// The addon folders in `dir`, read the way the page reads its stored ones.
function readAddons(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const toc = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }).find((x) => x.isFile() && x.name.toLowerCase() === `${e.name}.toc`.toLowerCase());
    if (toc) out.push({ folder: e.name, fields: parseToc(fs.readFileSync(path.join(dir, e.name, toc.name))) });
  }
  return out;
}

test('.toc fields and colour codes', () => {
  const f = parseToc(MADE_UP['CoolBars/CoolBars.toc']);
  assert.deepEqual(f, { Interface: '11200', Title: '|cFF00FF00Cool|r Bars |cffff8800v2|r', Notes: 'Bars, but |cFFFFFFFFcool|r', Author: '|cFF112233Someone|r', Version: '2.0' });
  assert.equal(stripColors(f.Title), 'Cool Bars v2');
  const g = parseToc(MADE_UP['Gebaeude/gebaeude.TOC']);
  assert.deepEqual(g, { Interface: '20400', Notes: 'Gebäude zählen', Version: '1', Author: 'Jemand' });
  assert.deepEqual(parseToc(Buffer.from(MADE_UP['Plain/Plain.toc'])), { 'X-Website': 'example' });
});

test('rows match the desktop launcher on the same folders', { skip: !DESKTOP ? 'set ELECTRODE_DESKTOP_ADDONS' : false }, async (t) => {
  const desktop = await import(pathToFileURL(path.resolve(DESKTOP)).href);
  const yours = tempDir(t, 'addons');
  tree(yours, MADE_UP);
  const shippedDir = SHIPPED || path.join(tempDir(t, 'shipped'));
  if (!SHIPPED) tree(shippedDir, { '!Questie/!Questie.toc': '## Title: |cFFFFFFFFQuestie|r|cFF00FF00 v0|r\n## Version: 0\n', 'Other/Other.toc': '## Title: Other\n' });
  for (const disabled of [[], ['coolbars', '!QUESTIE'], ['Plain']]) {
    for (const [mine, theirs] of [[yours, shippedDir], [shippedDir, yours], [yours, path.join(yours, 'none')]]) {
      const want = desktop.listAddons({ yours: mine, shipped: theirs, disabled });
      const got = addonRows({ yours: readAddons(mine), shipped: fs.existsSync(theirs) ? readAddons(theirs) : [], disabled });
      // The desktop leaves replacesShipped off a shipped row; here it is there and false.
      for (const row of got) if (row.source === 'shipped') { assert.equal(row.replacesShipped, false); delete row.replacesShipped; }
      assert.deepEqual(got, want);
    }
  }
  const rows = desktop.listAddons({ yours, shipped: shippedDir, disabled: [] });
  assert.ok(rows.find((r) => r.folder === '!questie' && r.source === 'yours' && r.replacesShipped), 'the player’s copy replaces the shipped one');
  assert.ok(!rows.find((r) => r.folder === 'NotAnAddon'));
  for (const [rel, body] of Object.entries(MADE_UP)) {
    if (!/\.toc$/i.test(rel)) continue;
    assert.deepEqual(parseToc(Buffer.from(body)), desktop.parseToc(Buffer.from(body)), rel);
  }
  if (SHIPPED) {
    const q = rows.find((r) => r.source === 'shipped' || r.folder.toLowerCase() === '!questie');
    assert.ok(q, 'the shipped folder lists something');
    console.log(`compared with the desktop module on ${readAddons(shippedDir).length} shipped and ${readAddons(yours).length} made-up addons`);
  }
});

// A folder on disk as the page's "folder to look in": { name, list() }.
function diskFolder(dir, name = path.basename(dir)) {
  return {
    name,
    list: async () => {
      const files = new Map();
      const dirs = new Map();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.set(e.name, diskFolder(path.join(dir, e.name), e.name));
        else files.set(e.name, () => new Blob([fs.readFileSync(path.join(dir, e.name))]));
      }
      return { files, dirs };
    },
  };
}

test('which folders of a download are addons', async (t) => {
  const base = tempDir(t, 'layouts');
  const layouts = {
    itself: { 'TinyTip/TinyTip.toc': 'x', 'TinyTip/a.lua': 'x' },
    several: { 'pack/A/A.toc': 'x', 'pack/B/b.TOC': 'x', 'pack/C/readme.txt': 'x' },
    archive: { 'unpacked/Name-master/!Name/!Name.toc': 'x', 'unpacked/Name-master/README.md': 'x' },
    none: { 'empty/readme.txt': 'x' },
    tooDeep: { 'deep/a/b/C/C.toc': 'x' },
  };
  const starts = { itself: 'TinyTip', several: 'pack', archive: 'unpacked', none: 'empty', tooDeep: 'deep' };
  const want = { itself: ['TinyTip'], several: ['A', 'B'], archive: ['!Name'], none: [], tooDeep: [] };
  const desktop = DESKTOP ? await import(pathToFileURL(path.resolve(DESKTOP)).href) : null;
  for (const [name, files] of Object.entries(layouts)) {
    const dir = path.join(base, name);
    tree(dir, files);
    const start = path.join(dir, starts[name]);
    const found = (await findAddonFolders(diskFolder(start))).map((f) => f.name).sort();
    assert.deepEqual(found, want[name], name);
    if (desktop) assert.deepEqual(found, desktop.findAddonFolders(start).map((d) => path.basename(d)).sort(), `${name}: as the desktop finds them`);
  }
});

// A .zip written here: stored and deflated members, with the right sums unless told otherwise.
function makeZip(members, { flags = 0, badCrc = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body, method = 8] of members) {
    const raw = Buffer.from(body);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = (zlib.crc32(raw) ^ (badCrc ? 1 : 0)) >>> 0;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(flags, 8); head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(n.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    central.push(head, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...locals, dir, end])], 'addon.zip');
}

test('.zip archives', async () => {
  const big = Buffer.alloc(200000, 'abcdefg');
  const members = [['Name-master/', '', 0], ['Name-master/!Name/!Name.toc', '## Title: Named\n'], ['Name-master/!Name/data.lua', big], ['Name-master\\!Name\\stored.bin', Buffer.from([0, 1, 2, 255]), 0]];
  const files = await unzip(makeZip(members));
  assert.deepEqual(files.map((f) => f[0]), ['Name-master/!Name/!Name.toc', 'Name-master/!Name/data.lua', 'Name-master/!Name/stored.bin']);
  assert.ok(Buffer.from(await files[1][1].arrayBuffer()).equals(big));
  assert.deepEqual([...new Uint8Array(await files[2][1].arrayBuffer())], [0, 1, 2, 255]);
  await assert.rejects(unzip(makeZip([['../evil.lua', 'x']])), /leads outside/);
  await assert.rejects(unzip(makeZip([['/abs.lua', 'x']])), /leads outside/);
  await assert.rejects(unzip(makeZip([['a/b.lua', 'x']], { flags: 1 })), /password/);
  await assert.rejects(unzip(makeZip([['a/b.lua', 'hello']], { badCrc: true })), /damaged/);
  await assert.rejects(unzip(new File([Buffer.from('Rar!\x1a\x07\x00 this is not a zip at all, not even close')], 'x.zip')), /not a \.zip/);
});

test('the AddOns folder as the game sees it', async () => {
  const blob = (s) => new Blob([s]);
  const read = async (file) => new Uint8Array(await file.arrayBuffer());
  const text = async (a) => (a.body ? Buffer.from(a.body).toString('latin1') : null);
  // The player's copy first, then the shipped addons: a folder name belongs to its first spelling.
  const folder = addonFolder([
    { path: '!questie/!Questie.toc', file: blob('player') },
    { path: '!Questie/!Questie.toc', file: blob('shipped') },
    { path: '!Questie/Old.lua', file: blob('old') },
    { path: 'Other/Other.toc', file: blob('other') },
  ]);
  assert.equal(Buffer.from(folder.listing).toString(), '!questie/!Questie.toc\nOther/Other.toc');
  const get = (p, method = 'GET', query = null) => addonsRoute(method, '/addons/' + p, query, folder, read);
  assert.equal(await text(await get('!Questie/!Questie.toc')), 'player');
  assert.equal((await get('!Questie/Old.lua')).status, 404, 'the shipped copy is replaced, not merged');
  assert.equal(await text(await get('Other/Other.toc')), 'other');
  for (const bad of ['Other', 'Other/../!Questie/!Questie.toc', 'Other//Other.toc', '../shipped/Other/Other.toc', 'Other/C:Other.toc', 'Other%5COther.toc', '']) {
    assert.equal((await get(bad)).status, 404, bad);
  }
  const lead = await get('Other/Other.toc', 'GET', 'xhr');
  assert.equal(await text(lead), ' other');
  assert.deepEqual([lead.status, lead.type, lead.cache], [200, 'application/octet-stream', 'no-store']);
  assert.equal(await text(await get('Other/Other.toc', 'GET', 'xhr=1')), 'other', 'only the exact query asks for the space');
  const head = await get('Other/Other.toc', 'HEAD', 'xhr');
  assert.deepEqual([head.status, head.body, head.type], [200, null, 'application/octet-stream']);
  assert.equal((await get('Other/Nope.toc', 'HEAD')).status, 404);
  assert.equal((await get('Other/Other.toc', 'POST')).status, 405);
  const index = await addonsRoute('GET', '/addons/__index', null, folder, read);
  assert.deepEqual([index.status, index.type, index.cache, await text(index)], [200, 'text/plain; charset=utf-8', 'no-store', '!questie/!Questie.toc\nOther/Other.toc']);
  assert.equal((await addonsRoute('HEAD', '/addons/__index', null, folder, read)).body, null);

  // Order: folder by folder, names in order at each level, a folder's files where the folder sorts.
  const ordered = addonFolder(['B/B.toc', 'A/z.lua', 'A/a/x.lua', 'A/a.lua', 'A/A.toc', 'A/a/b/c.lua'].map((p) => ({ path: p, file: blob(p) })));
  assert.deepEqual(ordered.paths, ['A/A.toc', 'A/a/b/c.lua', 'A/a/x.lua', 'A/a.lua', 'A/z.lua', 'B/B.toc']);
  // Percent-encoded names, as the client sends each part.
  const spaced = addonFolder([{ path: 'My Addon/Sub Dir/File (1).lua', file: blob('spaced') }]);
  assert.equal(await text(await addonsRoute('GET', '/addons/My%20Addon/Sub%20Dir/File%20(1).lua', 'xhr', spaced, read)), ' spaced');
  // Names the client cannot ask for, and a folder nested too deep, are not listed.
  const odd = addonFolder([{ path: 'A/A.toc', file: blob('a') }, { path: 'loose.lua', file: blob('x') }, { path: 'A/../B.lua', file: blob('x') }, { path: 'A/c:d.lua', file: blob('x') }, { path: 'A/' + 'd/'.repeat(25) + 'deep.lua', file: blob('x') }, { path: 'A/' + 'd/'.repeat(24) + 'ok.lua', file: blob('x') }]);
  assert.deepEqual(odd.paths, ['A/A.toc', 'A/' + 'd/'.repeat(24) + 'ok.lua']);

  // No list: an empty folder.
  const empty = await addonsRoute('GET', '/addons/__index', null, null, read);
  assert.deepEqual([empty.status, empty.body.length], [200, 0]);
  assert.equal((await addonsRoute('GET', '/addons/Other/Other.toc', 'xhr', null, read)).status, 404);
});

test('the pack tool', (t) => {
  const base = tempDir(t, 'pack');
  const src = path.join(base, 'src');
  const lic = path.join(base, 'licenses');
  const out = path.join(base, 'site', 'addons');
  tree(src, { '!CoolBars/!coolbars.toc': MADE_UP['CoolBars/CoolBars.toc'], '!CoolBars/Libs/Lib.lua': 'lib', '!CoolBars/core.lua': 'core', 'Plain/Plain.toc': '## Title: Plain\n', 'loose.txt': 'x', 'NotOne/x.lua': 'x' });
  tree(lic, { 'coolbars-LICENSE.txt': 'a notice', 'coolbars-other.md': 'another', 'unrelated-LICENSE.txt': 'no' });
  const tool = path.join(here, '..', 'tools', 'pack-addons.mjs');
  const run = () => spawnSync(process.execPath, [tool, '--src', src, '--licenses', lic, '--out', out], { encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.addons.map((a) => a.folder), ['!CoolBars', 'Plain']);
  const cool = index.addons[0];
  assert.equal(cool.toc.Title, '|cFF00FF00Cool|r Bars |cffff8800v2|r');
  assert.deepEqual(cool.files.map((f) => f.path), ['!coolbars.toc', 'Libs/Lib.lua', 'core.lua']);
  assert.deepEqual(cool.notices, ['coolbars-LICENSE.txt', 'coolbars-other.md']);
  assert.deepEqual(index.addons[1].notices, []);
  assert.equal(cool.bytes, cool.files.reduce((s, f) => s + f.size, 0));
  for (const f of cool.files) assert.ok(fs.readFileSync(path.join(out, '!CoolBars', f.path)).equals(fs.readFileSync(path.join(src, '!CoolBars', f.path))), f.path);
  assert.deepEqual(fs.readdirSync(path.join(out, 'licenses')).sort(), ['coolbars-LICENSE.txt', 'coolbars-other.md']);
  assert.ok(!JSON.stringify(index).includes(base.replace(/\\/g, '\\\\')) && !JSON.stringify(index).includes(base), 'no path of this machine in the index');
  // The same files give the same version; a changed file gives another; an earlier pack is replaced.
  const first = index.version;
  r = run();
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')).version, first);
  fs.rmSync(path.join(src, 'Plain'), { recursive: true });
  fs.writeFileSync(path.join(src, '!CoolBars', 'core.lua'), 'core 2');
  r = run();
  assert.equal(r.status, 0, r.stderr);
  const second = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.notEqual(second.version, first);
  assert.ok(!fs.existsSync(path.join(out, 'Plain')), 'an addon no longer in the source is gone');
  // A folder that is not an earlier pack is left alone.
  const foreign = path.join(base, 'foreign');
  tree(foreign, { 'keep.txt': 'mine' });
  const refused = spawnSync(process.execPath, [tool, '--src', src, '--out', foreign], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'mine');
});
