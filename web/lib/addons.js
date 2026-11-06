// The game client's addons, as the launcher's AddOns tab manages them, in a browser.
//
// Two places hold them: the ones the site ships (addons/ beside the page, listed in its
// index.json) and the player's own, kept in this browser's private storage. One of the player's
// with the same folder name as a shipped one replaces it. Addons are turned on and off here and
// nowhere else: the game is given only the files of the ones that are on (getAddonFiles(), for
// lib/gamedata-sync.js), and it reads its AddOns folder again at every interface load.
//
//   listAddons()                  { addons: [row], termsAccepted }   row: { folder, title, version,
//                                 notes, author, interface, enabled, source: 'shipped' | 'yours', replacesShipped }
//   acceptAddonTerms()            the tab's licensing notice, once; resolves to the list
//   setAddonEnabled(folder, on)   resolves to the list
//   addAddons(source)             a folder handle, the Files of a folder input or a drop, or one
//                                 .zip File; resolves to the list plus added: [titles]
//   removeAddon(folder)           one of the player's own; resolves to the list
//   getAddonFiles()               [{ path, file }] of every addon that is on
//   reloadGameInterface()         true when the game was in the world and was told to reload
//   forgetClientAddonLists()      before the client starts: its own per-character on/off lists go
//
// Private storage (OPFS): addons/yours/<Folder>/... the player's addons; addons/state.json what is
// off and when the notice was accepted; addons/shipped/<pack version>/... the shipped files of
// addons that are on, fetched from the site once.

const ROOT = 'addons';
const YOURS = 'yours';
const SHIPPED = 'shipped';
const INCOMING = 'incoming';
const STATE = 'state.json';

/** A folder that large is not an addon (the same bounds as the reader's listing). */
const MAX_FILES = 50000;
const MAX_DEPTH = 24;
/** An archive that unpacks to more than this is not an addon. */
const MAX_UNPACKED = 1 << 30;

const TERMS_FIRST = 'Accept the addon licensing notice in the AddOns tab first.';
const NO_7Z_RAR = 'A browser cannot open .7z or .rar archives. Unpack it on your computer and add the folder, or use a .zip.';

/** The client's own per-character addon lists, in its saved files (localStorage). */
const CLIENT_ADDON_STATE_PREFIX = 'benilla:/benilla-config/addon-state/';

// ---- .toc files (the same reading as the desktop launcher's) ----

/** `|cFFrrggbb...|r` colour codes out of a .toc title. */
export const stripColors = (s) => s.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '');

/** The `## Key: value` lines of a .toc (UTF-8, else read as Windows-1252 like the client). */
export function parseToc(bytes) {
  let text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes);
  const fields = {};
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^##\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2];
  }
  return fields;
}

/** One row of the tab from an addon's folder name and .toc fields. */
export function addonRow(folder, fields, source, enabled) {
  return {
    folder,
    title: stripColors(fields.Title || folder).trim() || folder,
    version: fields.Version || '',
    notes: stripColors(fields.Notes || ''),
    author: stripColors(fields.Author || ''),
    interface: fields.Interface || '',
    source,
    enabled,
  };
}

/**
 * Every addon the game could load, the player's own and the shipped ones, sorted by title.
 * `yours` and `shipped` are [{ folder, fields }]; `disabled` is folder names, in any case.
 */
export function addonRows({ yours, shipped, disabled = [] }) {
  const off = new Set(disabled.map((n) => n.toLowerCase()));
  const mineNames = new Set(yours.map((a) => a.folder.toLowerCase()));
  const shippedNames = new Set(shipped.map((a) => a.folder.toLowerCase()));
  const row = (a, source) => addonRow(a.folder, a.fields || {}, source, !off.has(a.folder.toLowerCase()));
  const rows = [
    ...yours.map((a) => ({ ...row(a, 'yours'), replacesShipped: shippedNames.has(a.folder.toLowerCase()) })),
    ...shipped.filter((a) => !mineNames.has(a.folder.toLowerCase())).map((a) => ({ ...row(a, 'shipped'), replacesShipped: false })),
  ];
  return rows.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** A name a file or folder of an addon can have: not empty, "." or "..", no separator or colon. */
const plainName = (name) => name !== '' && name !== '.' && name !== '..' && !/[\\/:]/.test(name);

// ---- folders to look for addons in ----
//
// A folder is { name, list() -> { files: Map(name -> () => Blob), dirs: Map(name -> folder) } },
// whether it is a folder handle, a list of Files with paths, or an unpacked archive.

function handleFolder(handle, name = handle.name) {
  let listed = null;
  return {
    name,
    list() {
      if (!listed) {
        listed = (async () => {
          const files = new Map();
          const dirs = new Map();
          for await (const [n, h] of handle.entries()) {
            if (h.kind === 'directory') dirs.set(n, handleFolder(h, n));
            else files.set(n, () => h.getFile());
          }
          return { files, dirs };
        })();
      }
      return listed;
    },
  };
}

function listedFolder(name) {
  const folder = { name, files: new Map(), dirs: new Map(), list: async () => ({ files: folder.files, dirs: folder.dirs }) };
  return folder;
}

/** A folder tree from [path, Blob] pairs with '/'-separated paths. */
function treeOf(entries) {
  const root = listedFolder('');
  for (const [path, blob] of entries) {
    const parts = path.split('/').filter((p) => p !== '');
    if (!parts.length) continue;
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, listedFolder(part));
      at = at.dirs.get(part);
    }
    at.files.set(parts[parts.length - 1], () => blob);
  }
  return root;
}

/** Whether the folder holds `<its name>.toc`, matched without regard to case. */
async function hasToc(folder) {
  if (folder.name === '') return false;
  const want = `${folder.name}.toc`.toLowerCase();
  const { files } = await folder.list();
  for (const name of files.keys()) if (name.toLowerCase() === want) return true;
  return false;
}

async function addonsIn(folder) {
  const out = [];
  for (const sub of (await folder.list()).dirs.values()) if (await hasToc(sub)) out.push(sub);
  return out;
}

/**
 * The addon folders a download holds: the folder itself when it is one, else the addon folders
 * inside it or one level further down (an archive's `Name-master/!Name/` layout).
 */
export async function findAddonFolders(folder) {
  if (await hasToc(folder)) return [folder];
  const here = await addonsIn(folder);
  if (here.length) return here;
  const out = [];
  for (const sub of (await folder.list()).dirs.values()) out.push(...(await addonsIn(sub)));
  return out;
}

// ---- .zip archives ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The files of a .zip as [path, Blob] pairs: stored and deflated members, checked against their CRC. */
export async function unzip(file) {
  const bad = (why) => new Error(`${file.name || 'The archive'} could not be unpacked: ${why}`);
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw bad('it is not a .zip file.');
  const count = tv.getUint16(end + 10, true);
  const dirSize = tv.getUint32(end + 12, true);
  const dirOffset = tv.getUint32(end + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw bad('it is in the ZIP64 form, which is not read here. Unpack it on your computer and add the folder.');
  if (count > MAX_FILES) throw bad('it holds too many files for an addon.');
  const dir = new Uint8Array(await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const dv = new DataView(dir.buffer);
  const out = [];
  let unpacked = 0;
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > dir.length || dv.getUint32(at, true) !== 0x02014b50) throw bad('its list of files is damaged.');
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    const packed = dv.getUint32(at + 20, true);
    const size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const offset = dv.getUint32(at + 42, true);
    const rawName = dir.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch (e) {
      name = new TextDecoder('windows-1252').decode(rawName);
    }
    name = name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue; // a folder
    const parts = name.split('/');
    if (name.startsWith('/') || parts.some((p) => p === '..' || p.includes(':'))) throw bad(`it holds a path that leads outside it (${name}).`);
    if (flags & 1) throw bad('it is protected by a password.');
    if (method !== 0 && method !== 8) throw bad(`${name} is packed in a way that is not read here (method ${method}).`);
    unpacked += size;
    if (unpacked > MAX_UNPACKED) throw bad('it unpacks to more than an addon can be.');
    const head = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
    if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw bad(`${name}: damaged.`);
    const start = offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const data = file.slice(start, start + packed);
    let bytes;
    if (method === 0) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      if (typeof DecompressionStream !== 'function') throw bad('this browser cannot unpack .zip files. Unpack it on your computer and add the folder.');
      try {
        bytes = new Uint8Array(await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      } catch (e) {
        throw bad(`${name}: damaged.`);
      }
    }
    if (bytes.length !== size || crc32(bytes) !== crc) throw bad(`${name}: damaged.`);
    out.push([name, new Blob([bytes])]);
  }
  return out;
}

// ---- private storage ----

async function rootDir(create = true) {
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('This browser has no private file storage for sites.');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
}

async function writeFile(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable !== 'function') throw new Error('This browser cannot store files for a site from a page.');
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

async function removeEntry(dir, name) {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') throw e;
  }
}

async function readState() {
  const state = { disabled: [], termsAccepted: null, pending: [] };
  try {
    const saved = JSON.parse(await (await (await (await rootDir(false)).getFileHandle(STATE)).getFile()).text());
    if (Array.isArray(saved.disabled)) state.disabled = saved.disabled.map(String);
    if (typeof saved.termsAccepted === 'string') state.termsAccepted = saved.termsAccepted;
    if (Array.isArray(saved.pending)) state.pending = saved.pending.map(String);
  } catch (e) {
    /* nothing saved yet */
  }
  return state;
}

async function writeState(state) {
  await writeFile(await rootDir(), STATE, JSON.stringify(state));
}

async function requireTerms() {
  const state = await readState();
  if (!state.termsAccepted) throw new Error(TERMS_FIRST);
  return state;
}

// One change at a time: the state file and the folders are read and written whole.
let queue = Promise.resolve();
function serial(run) {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** The player's own addons: [{ folder, fields }], each a folder with a .toc of its name. */
async function yourAddons(state) {
  let yours;
  try {
    yours = await (await rootDir(false)).getDirectoryHandle(YOURS);
  } catch (e) {
    return [];
  }
  const skip = new Set(state.pending.map((n) => n.toLowerCase())); // an add that did not finish
  const out = [];
  for await (const [folder, handle] of yours.entries()) {
    if (handle.kind !== 'directory' || skip.has(folder.toLowerCase())) continue;
    const want = `${folder}.toc`.toLowerCase();
    let toc = null;
    for await (const [name, h] of handle.entries()) {
      if (h.kind === 'file' && name.toLowerCase() === want) { toc = h; break; }
    }
    if (!toc) continue;
    let fields = {};
    try {
      fields = parseToc(new Uint8Array(await (await toc.getFile()).arrayBuffer()));
    } catch (e) {
      /* listed with its folder name */
    }
    out.push({ folder, fields });
  }
  return out;
}

// ---- the shipped addons: listed by the site, fetched when they are on ----

// The browser's own fetch: the game data reader wraps window.fetch and answers /addons/ at the
// origin's root itself, which is not this site's addons folder.
const siteFetch = (url, init) => (globalThis.fetch.native || globalThis.fetch).call(globalThis, url, init);
const siteUrl = (path) => new URL('../addons/' + path.split('/').map(encodeURIComponent).join('/'), import.meta.url);

let packPromise = null;

/** The site's pack: { version, addons: [{ folder, toc, files: [{ path, size, sha256 }], notices }] }. */
function shippedPack() {
  if (!packPromise) {
    const loading = (async () => {
      const r = await siteFetch(siteUrl('index.json'), { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const pack = await r.json();
      if (!pack || typeof pack.version !== 'string' || !Array.isArray(pack.addons)) throw new Error('not a pack list');
      return pack;
    })();
    packPromise = loading;
    loading.catch(() => {
      if (packPromise === loading) packPromise = null;
    });
  }
  return packPromise.catch((e) => {
    console.warn('addons: the list of addons that come with the game could not be read:', e && e.message ? e.message : e);
    return { version: '', addons: [] };
  });
}

async function summary() {
  const state = await readState();
  const pack = await shippedPack();
  const addons = addonRows({
    yours: await yourAddons(state),
    shipped: pack.addons.map((a) => ({ folder: a.folder, fields: a.toc || {} })),
    disabled: state.disabled,
  });
  return { addons, termsAccepted: state.termsAccepted || null };
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** One shipped addon's files out of private storage, fetching from the site what is not there yet. */
async function shippedFiles(pack, folder, onProgress) {
  const addon = pack.addons.find((a) => a.folder === folder);
  const shipped = await (await rootDir()).getDirectoryHandle(SHIPPED, { create: true });
  const older = [];
  for await (const [name] of shipped.entries()) if (name !== pack.version) older.push(name);
  for (const name of older) await removeEntry(shipped, name); // an earlier pack's files
  const base = await (await shipped.getDirectoryHandle(pack.version, { create: true })).getDirectoryHandle(folder, { create: true });
  const dirs = new Map([['', base]]);
  const dirFor = async (parts) => {
    const key = parts.join('/');
    if (!dirs.has(key)) dirs.set(key, await (await dirFor(parts.slice(0, -1))).getDirectoryHandle(parts[parts.length - 1], { create: true }));
    return dirs.get(key);
  };
  const out = [];
  const wanted = [];
  for (const f of addon.files) {
    const parts = f.path.split('/');
    const dir = await dirFor(parts.slice(0, -1));
    const name = parts[parts.length - 1];
    let file = null;
    try {
      file = await (await dir.getFileHandle(name)).getFile();
    } catch (e) {
      file = null;
    }
    if (file && file.size === f.size) out.push({ path: `${folder}/${f.path}`, file });
    else wanted.push({ f, dir, name });
  }
  let done = addon.files.length - wanted.length;
  const report = () => { if (onProgress) onProgress({ folder, done, total: addon.files.length }); };
  report();
  const fetchOne = async ({ f, dir, name }) => {
    const r = await siteFetch(siteUrl(`${folder}/${f.path}`));
    if (!r.ok) throw new Error(`${f.path}: HTTP ${r.status}`);
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength !== f.size) throw new Error(`${f.path}: ${bytes.byteLength} bytes, expected ${f.size}`);
    if (f.sha256 && crypto.subtle && hex(await crypto.subtle.digest('SHA-256', bytes)) !== f.sha256) throw new Error(`${f.path}: not the file the site lists`);
    await writeFile(dir, name, bytes);
    out.push({ path: `${folder}/${f.path}`, file: await (await dir.getFileHandle(name)).getFile() });
    done++;
    report();
  };
  const pool = Array.from({ length: Math.min(6, wanted.length) }, async () => {
    while (wanted.length) await fetchOne(wanted.shift());
  });
  await Promise.all(pool);
  return out;
}

async function storedFiles(dir, prefix, out, depth = 0) {
  for await (const [name, handle] of dir.entries()) {
    if (!plainName(name)) continue;
    if (handle.kind === 'directory') {
      if (depth < MAX_DEPTH) await storedFiles(handle, `${prefix}/${name}`, out, depth + 1);
    } else if (out.length < MAX_FILES) out.push({ path: `${prefix}/${name}`, file: await handle.getFile() });
  }
  return out;
}

// ---- adding ----

/** The folder to search, and what to call it in a message, for whatever the player gave. */
async function folderOf(source) {
  const archive = (f) => f && typeof f.name === 'string' && typeof f.slice === 'function' && !f.webkitRelativePath && /\.(zip|7z|rar)$/i.test(f.name);
  if (source && source.kind === 'directory' && typeof source.entries === 'function') return { folder: handleFolder(source), label: source.name };
  let items = null;
  if (source && typeof source.slice === 'function' && typeof source.name === 'string') items = [source]; // one File
  else if (source && typeof source[Symbol.iterator] === 'function') items = Array.from(source);
  if (!items || !items.length) throw new Error('Choose an addon folder, or a .zip archive of one.');
  if (items.length === 1 && archive(items[0])) {
    if (!/\.zip$/i.test(items[0].name)) throw new Error(NO_7Z_RAR);
    return { folder: treeOf(await unzip(items[0])), label: items[0].name };
  }
  const entries = [];
  for (const item of items) {
    if (!item) continue;
    if (item.file && typeof item.path === 'string') entries.push([item.path.replace(/\\/g, '/'), item.file]);
    else if (typeof item.name === 'string' && typeof item.slice === 'function') entries.push([item.webkitRelativePath || item.name, item]);
  }
  if (entries.length === 1 && !entries[0][0].includes('/')) {
    throw new Error(/\.(7z|rar)$/i.test(entries[0][0]) ? NO_7Z_RAR : 'Choose an addon folder, or a .zip archive of one.');
  }
  const root = treeOf(entries);
  // The files of one picked folder all begin with its name: that folder is what was chosen.
  if (root.files.size === 0 && root.dirs.size === 1) {
    const only = root.dirs.values().next().value;
    return { folder: only, label: only.name };
  }
  return { folder: root, label: 'what you chose' };
}

async function copyTree(folder, dest, budget, depth, label) {
  if (depth > MAX_DEPTH) throw new Error(`${label}: folders nested too deep for an addon`);
  const { files, dirs } = await folder.list();
  for (const [name, get] of files) {
    if (!plainName(name)) continue;
    if (--budget.files < 0) throw new Error(`${label}: too many files for an addon`);
    await writeFile(dest, name, await get());
  }
  for (const [name, sub] of dirs) {
    if (!plainName(name)) continue;
    await copyTree(sub, await dest.getDirectoryHandle(name, { create: true }), budget, depth + 1, label);
  }
}

/** Move a stored tree into another stored folder (file by file; copied where a browser cannot move). */
async function moveTree(from, to) {
  for await (const [name, handle] of from.entries()) {
    if (handle.kind === 'directory') await moveTree(handle, await to.getDirectoryHandle(name, { create: true }));
    else if (typeof handle.move === 'function') await handle.move(to);
    else await writeFile(to, name, await handle.getFile());
  }
}

/** Put one addon folder among the player's own; one already there under the same name is replaced. */
async function install(folder, state) {
  const name = folder.name;
  if (!plainName(name)) throw new Error(`${name || 'That folder'}: not a name an addon folder can have`);
  const root = await rootDir();
  // Copied aside first, so a copy that fails leaves the addon that was there, and the game
  // never sees half an addon.
  await removeEntry(root, INCOMING);
  const incoming = await (await root.getDirectoryHandle(INCOMING, { create: true })).getDirectoryHandle(name, { create: true });
  try {
    await copyTree(folder, incoming, { files: MAX_FILES }, 0, name);
  } catch (e) {
    await removeEntry(root, INCOMING);
    throw e;
  }
  const yours = await root.getDirectoryHandle(YOURS, { create: true });
  state.pending = [...state.pending.filter((n) => n.toLowerCase() !== name.toLowerCase()), name];
  await writeState(state);
  const old = [];
  for await (const [existing, handle] of yours.entries()) if (handle.kind === 'directory' && existing.toLowerCase() === name.toLowerCase()) old.push(existing);
  for (const existing of old) await removeEntry(yours, existing);
  await moveTree(incoming, await yours.getDirectoryHandle(name, { create: true }));
  await removeEntry(root, INCOMING);
  state.pending = state.pending.filter((n) => n.toLowerCase() !== name.toLowerCase());
  await writeState(state);
  return name;
}

// ---- what the tab calls ----

/** The addons and whether the licensing notice was accepted (an ISO date, or null). */
export function listAddons() {
  return serial(summary);
}

/** The tab's licensing notice: accepted once before addons can be added, switched or removed. */
export function acceptAddonTerms() {
  return serial(async () => {
    const state = await readState();
    if (!state.termsAccepted) {
      state.termsAccepted = new Date().toISOString();
      await writeState(state);
    }
    return summary();
  });
}

/** Turn an addon on or off. The game loads the ones that are on at its next interface load. */
export function setAddonEnabled(folder, on) {
  return serial(async () => {
    const state = await requireTerms();
    state.disabled = state.disabled.filter((n) => n.toLowerCase() !== String(folder).toLowerCase());
    if (!on) state.disabled.push(String(folder));
    await writeState(state);
    return summary();
  });
}

/**
 * Add the addons in what the player chose: a FileSystemDirectoryHandle, the Files of a folder
 * input or a drop (a FileList, or an array of Files or of { path, file }), or one .zip File. An
 * addon is a folder holding a .toc file of the same name; the folder itself, the folders inside
 * it, or one level further down are looked at. One already there under the same name is replaced.
 * Resolves to the list plus `added`, the titles of what was added.
 */
export function addAddons(source) {
  return serial(async () => {
    const state = await requireTerms();
    const { folder, label } = await folderOf(source);
    const found = await findAddonFolders(folder);
    if (!found.length) throw new Error(`No addon in ${label}: an addon is a folder holding a .toc file of the same name.`);
    const names = [];
    for (const addon of found) names.push(await install(addon, state));
    const list = await summary();
    const title = (name) => (list.addons.find((a) => a.source === 'yours' && a.folder === name) || { title: name }).title;
    return { ...list, added: names.map(title) };
  });
}

/** Remove one of the player's own addons. */
export function removeAddon(folder) {
  return serial(async () => {
    const state = await requireTerms();
    const mine = (await yourAddons(state)).find((a) => a.folder.toLowerCase() === String(folder).toLowerCase());
    if (!mine) throw new Error(`${folder} is not one of your addons`);
    await removeEntry(await (await rootDir()).getDirectoryHandle(YOURS, { create: true }), mine.folder);
    return summary();
  });
}

/**
 * The files of every addon that is on, as [{ path, file }] with path "<Addon>/<...>": what the
 * game data reader serves as the game's AddOns folder. The shipped ones are fetched from the
 * site on first use and kept. An addon whose files cannot be fetched is left out, and the
 * returned array's `problems` says so. options.onProgress({ folder, done, total }).
 */
export function getAddonFiles({ onProgress } = {}) {
  return serial(async () => {
    const pack = await shippedPack();
    const { addons } = await summary();
    const out = [];
    const problems = [];
    for (const a of addons) {
      if (!a.enabled) continue;
      try {
        if (a.source === 'yours') {
          const dir = await (await (await rootDir()).getDirectoryHandle(YOURS)).getDirectoryHandle(a.folder);
          await storedFiles(dir, a.folder, out);
        } else {
          out.push(...(await shippedFiles(pack, a.folder, onProgress)));
        }
      } catch (e) {
        problems.push(`${a.title}: ${e && e.message ? e.message : e}`);
      }
    }
    out.problems = problems;
    return out;
  });
}

/**
 * Tell the running game to load its interface again, so a change in the tab applies now. Only
 * while a character is in the world; resolves to whether it was told.
 */
export async function reloadGameInterface() {
  const game = globalThis.wenilla;
  if (!game || !game.state || !game.state.session || game.state.session.state !== 'inworld') return false;
  game.lua('ReloadUI()');
  return true;
}

/**
 * Before the game client starts: forget its own per-character addon on/off lists, so that the
 * tab is the only place addons are turned on and off.
 */
export function forgetClientAddonLists() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(CLIENT_ADDON_STATE_PREFIX)) localStorage.removeItem(key);
  } catch (e) {
    /* no saved files yet */
  }
}
