// Packs the four SQLite databases for the site: db/world.sqlite.gz, characters, realmd, logs and
// db/manifest.json. The world database is the content (classic-db); the other three are empty
// templates a new world starts from.
//
//   node tools/pack-db.mjs --src <dir with classicmangos.sqlite, classiccharacters.sqlite,
//                                 classicrealmd.sqlite, classiclogs.sqlite> --out <site>/db
//
// The source files are not changed: each is copied, cleaned, compacted, then gzipped.
// Needs Node 22.5 or newer (node:sqlite).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  if (i < 0 || !args[i + 1]) throw new Error(`missing --${name}`);
  return path.resolve(args[i + 1]);
};
const src = opt('src');
const out = opt('out');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'electrode-web-db-'));
fs.mkdirSync(out, { recursive: true });

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);

function prepare(name, from, clean) {
  const file = path.join(tmp, `${name}.sqlite`);
  fs.copyFileSync(path.join(src, from), file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE');
  clean?.(db);
  // Large pages: in a browser every page read crosses between threads, so fewer and bigger is faster.
  db.exec('PRAGMA page_size=65536');
  db.exec('VACUUM');
  const check = db.prepare('PRAGMA integrity_check').get();
  db.close();
  if (Object.values(check)[0] !== 'ok') throw new Error(`${name}: integrity check failed`);
  return file;
}

const files = {
  world: prepare('world', 'classicmangos.sqlite'),
  // No characters, no accounts: only the tables and the version rows the server checks.
  characters: prepare('characters', 'classiccharacters.sqlite', (db) => {
    for (const t of tables(db)) if (!/_db_version$|^character_db_version$/.test(t)) db.exec(`DELETE FROM "${t}"`);
  }),
  realmd: prepare('realmd', 'classicrealmd.sqlite', (db) => {
    // Accounts and everything recorded about them go; the chat filter's word lists stay.
    for (const t of tables(db)) if (!/db_version$/.test(t) && !t.startsWith('antispam_')) db.exec(`DELETE FROM "${t}"`);
    // The client asks its own page for the world port; the address is only a label here.
    db.prepare('INSERT INTO realmlist (id, name, address, port, icon, realmflags, timezone, allowedSecurityLevel, population, realmbuilds) VALUES (1, ?, ?, 8085, 1, 0, 1, 0, 0, ?)')
      .run('Electrode', '127.0.0.1', '5875');
  }),
  logs: prepare('logs', 'classiclogs.sqlite', (db) => {
    for (const t of tables(db)) if (!/db_version$/.test(t)) db.exec(`DELETE FROM "${t}"`);
  }),
};

const manifest = { version: '', files: {} };
const hash = createHash('sha256');
for (const [name, file] of Object.entries(files)) {
  const bytes = fs.readFileSync(file);
  hash.update(bytes);
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(out, `${name}.sqlite.gz`), gz);
  manifest.files[name] = { url: `${name}.sqlite.gz`, bytes: bytes.length, gzBytes: gz.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  console.log(`${name}: ${bytes.length} bytes, ${gz.length} gzipped`);
}
manifest.version = hash.digest('hex').slice(0, 16);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`manifest version ${manifest.version} -> ${out}`);
