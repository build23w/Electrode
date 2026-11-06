// Starts the wasm world server under Node on real extracted data and SQLite databases, and checks
// that it answers: world start, a console command, an account, a database snapshot, and the first
// step of a login on the in-page transport. No browser involved.
//
//   node server/test/run-node.mjs --server <dir with mangosd.js> --data <dir with dbc/ and maps/>
//        --db <dir with classicmangos.sqlite, classiccharacters.sqlite, classicrealmd.sqlite, classiclogs.sqlite>
//        [--work <scratch dir>] [--keep-running]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const serverDir = path.resolve(opt('server'));
const dataDir = path.resolve(opt('data'));
const dbSrc = path.resolve(opt('db'));
const work = path.resolve(opt('work', fs.mkdtempSync(path.join(os.tmpdir(), 'electrode-web-'))));
const keepRunning = args.includes('--keep-running');

fs.mkdirSync(path.join(work, 'db'), { recursive: true });
fs.mkdirSync(path.join(work, 'snapshot'), { recursive: true });
const names = { world: 'classicmangos', characters: 'classiccharacters', realmd: 'classicrealmd', logs: 'classiclogs' };
for (const [to, from] of Object.entries(names)) fs.copyFileSync(path.join(dbSrc, `${from}.sqlite`), path.join(work, 'db', `${to}.sqlite`));

function setKeys(text, pairs) {
  let out = text;
  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${key} = ${value}`) : `${out}\n${key} = ${value}\n`;
  }
  return out;
}
const template = fs.readFileSync(path.join(serverDir, 'mangosd.conf.dist'), 'utf8');
const noFile = {};
for (const m of template.matchAll(/^([A-Za-z.]*LogFile)\s*=/gm)) noFile[m[1]] = '""';
const conf = setKeys(template, {
  ...noFile,
  LoginDatabaseInfo: '"/db/realmd.sqlite"', WorldDatabaseInfo: '"/db/world.sqlite"',
  CharacterDatabaseInfo: '"/db/characters.sqlite"', LogsDatabaseInfo: '"/db/logs.sqlite"',
  DataDir: '"/data"', LogsDir: '"/logs"', BindIP: '"127.0.0.1"', WorldServerPort: '8085',
  'Console.Enable': '0', 'Ra.Enable': '0', 'SOAP.Enabled': '0', MaxCoreStuckTime: '0',
  'Network.Threads': '1', 'MapUpdate.Threads': '2',
  'vmap.enableLOS': fs.existsSync(path.join(dataDir, 'vmaps')) ? '1' : '0',
  'vmap.enableHeight': fs.existsSync(path.join(dataDir, 'vmaps')) ? '1' : '0',
  'mmap.enabled': '0', LogLevel: '1', LogColors: '""', ShowProgressBars: '0',
});

const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
const waiters = new Map();
let Module;
let nextTag = 1;
const received = new Map(); // connection id -> chunks

function command(text) {
  return new Promise((resolve) => {
    const tag = nextTag++;
    waiters.set(tag, resolve);
    Module.ccall('electrode_command', null, ['number', 'string'], [tag, text]);
  });
}
let snapshotDone;

const pageNet = {
  data(id, bytes) {
    (received.get(id) || received.set(id, []).get(id)).push(Buffer.from(bytes));
  },
  closed(id) {
    console.log(`[test] server closed connection ${id}`);
  },
  event(name, detail) {
    if (name === 'ready') ready().catch((e) => { console.error(e); process.exit(1); });
    else if (name === 'command') {
      const a = detail.indexOf('\n'), b = detail.indexOf('\n', a + 1);
      waiters.get(Number(detail.slice(0, a)))?.({ ok: detail.slice(a + 1, b) === 'ok', text: detail.slice(b + 1) });
    } else if (name === 'snapshot') snapshotDone?.(detail === 'ok');
    else if (name === 'stopped') { console.log(`[test] stopped at ${since()}`); setTimeout(() => process.exit(0), 200); }
  },
};

async function ready() {
  console.log(`[test] world ready at ${since()}, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  const info = await command('server info');
  console.log('[test] server info:', info.ok, info.text.trim().split('\n')[0]);
  const made = await command('account create WEBTEST WEBTESTPW');
  console.log('[test] account create:', made.ok, made.text.trim());
  const gm = await command('account set gmlevel WEBTEST 3');
  console.log('[test] account gmlevel:', gm.ok, gm.text.trim());

  const ok = await new Promise((resolve) => { snapshotDone = resolve; Module._electrode_snapshot(); });
  const snap = ['characters', 'realmd'].map((n) => { try { return fs.statSync(path.join(work, 'snapshot', `${n}.sqlite`)).size; } catch { return -1; } });
  console.log(`[test] snapshot ${ok ? 'ok' : 'failed'}: characters ${snap[0]} bytes, realmd ${snap[1]} bytes`);

  // First step of a login: the logon challenge for the new account must be answered.
  const id = Module._electrode_open(3724);
  const user = Buffer.from('WEBTEST');
  const body = Buffer.concat([
    Buffer.from('WoW\0'), Buffer.from([1, 12, 1]), Buffer.from([0xf3, 0x16]), // 1.12.1 build 5875
    Buffer.from('68x\0'), Buffer.from('niW\0'), Buffer.from('SUne'),
    Buffer.from([0, 0, 0, 0]), Buffer.from([127, 0, 0, 1]), Buffer.from([user.length]), user,
  ]);
  const head = Buffer.alloc(4);
  head[0] = 0; head[1] = 3; head.writeUInt16LE(body.length, 2);
  const packet = Buffer.concat([head, body]);
  Module.ccall('electrode_data', null, ['number', 'array', 'number'], [id, packet, packet.length]);
  await new Promise((r) => setTimeout(r, 1500));
  const answer = Buffer.concat(received.get(id) || []);
  console.log(`[test] login port: connection ${id}, challenge answer ${answer.length} bytes, command ${answer[0]}, result ${answer[2]}`);
  Module._electrode_close(id);
  const worldId = Module._electrode_open(8085);
  await new Promise((r) => setTimeout(r, 500));
  const hello = Buffer.concat(received.get(worldId) || []);
  console.log(`[test] world port: connection ${worldId}, first packet ${hello.length} bytes`);
  Module._electrode_close(worldId);

  const pass = info.ok && made.ok && ok && snap[0] > 0 && snap[1] > 0 && answer.length >= 100 && answer[0] === 0 && answer[2] === 0 && hello.length > 0;
  console.log(pass ? '[test] PASS' : '[test] FAIL');
  process.exitCode = pass ? 0 : 1;
  if (!keepRunning) Module._electrode_stop();
}

const require = createRequire(import.meta.url);
const createMangosd = require(path.join(serverDir, 'mangosd.js'));
Module = await createMangosd({
  pageNet,
  print: (line) => console.log(line ? `${since().padStart(7)}  ${line}` : line),
  printErr: (line) => console.error(line),
  locateFile: (f) => path.join(serverDir, f),
});
const FS = Module.FS;
for (const d of ['/db', '/data', '/etc', '/logs', '/snapshot']) FS.mkdir(d);
FS.mount(Module.NODEFS, { root: path.join(work, 'db') }, '/db');
FS.mount(Module.NODEFS, { root: path.join(work, 'snapshot') }, '/snapshot');
FS.mount(Module.NODEFS, { root: dataDir }, '/data');
FS.writeFile('/etc/mangosd.conf', conf);
const anticheat = path.join(serverDir, 'anticheat.conf.dist');
if (fs.existsSync(anticheat)) FS.writeFile('/etc/anticheat.conf', fs.readFileSync(anticheat, 'utf8').replace(/^Enable = 1/m, 'Enable = 0'));
FS.chdir('/etc');
console.log(`[test] module loaded at ${since()}, starting the world`);
Module.callMain(['-c', '/etc/mangosd.conf']);
