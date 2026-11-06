// Checks the session bridge (web/lib/session.js) against the real world server under Node: a
// scripted game signs in to the bridge, makes a character and enters the world; then the world's
// connections are cut, as when its host goes away, and the bridge is attached again. The game's
// own connection must stay open throughout, it must be told to load the world (not to sign in
// again), and the world's packets must flow to it afterwards.
//
//   node server/test/session-node.mjs --server <dir with mangosd.js> --data <dir with dbc/ and maps/>
//        --db <dir with the four .sqlite databases> [--work <scratch dir>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { SessionBridge, OP, Half, Inbox, clientPacket, internals } from '../../web/lib/session.js';

const { signIn, worldProof, concat, u32 } = internals;
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const serverDir = path.resolve(opt('server'));
const dataDir = path.resolve(opt('data'));
const dbSrc = path.resolve(opt('db'));
const work = path.resolve(opt('work', fs.mkdtempSync(path.join(os.tmpdir(), 'electrode-web-'))));

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
  'vmap.enableLOS': '0', 'vmap.enableHeight': '0', 'mmap.enabled': '0',
  LogLevel: '1', LogColors: '""', ShowProgressBars: '0', 'Page.RealmName': '"bridge test"',
});

const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
const say = (text) => console.log(`[test ${since().padStart(7)}] ${text}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waiters = new Map();
let Module;
let nextTag = 1;
const conns = new Map(); // the server's connection id -> the connection object
const hooks = {};
const snapshot = () => new Promise((resolve) => {
  hooks.snapshot = resolve;
  Module._electrode_snapshot();
});
const adopt = () => new Promise((resolve) => {
  hooks.adopted = resolve;
  Module._electrode_adopt(1);
});

function command(text) {
  return new Promise((resolve) => {
    const tag = nextTag++;
    waiters.set(tag, resolve);
    Module.ccall('electrode_command', null, ['number', 'string'], [tag, text]);
  });
}

// A world as the bridge is given one: connections to the server, all of which `cut()` closes at
// once, as a host that goes away does.
function makeWorld() {
  const mine = new Set();
  return {
    connect(port) {
      const id = Module._electrode_open(port);
      const conn = { onopen: null, ondata: null, onclose: null, closed: false };
      conn.send = (bytes) => {
        if (conn.closed) return;
        for (let off = 0; off < bytes.length; off += 32768) {
          const part = bytes.subarray(off, Math.min(bytes.length, off + 32768));
          Module.ccall('electrode_data', null, ['number', 'array', 'number'], [id, part, part.length]);
        }
      };
      conn.close = () => {
        if (conn.closed) return;
        conn.closed = true;
        conns.delete(id);
        mine.delete(conn);
        Module._electrode_close(id);
      };
      conn.cut = () => {
        if (conn.closed) return;
        conn.close();
        conn.onclose?.(true);
      };
      conns.set(id, conn);
      mine.add(conn);
      setTimeout(() => conn.onopen?.(), 0);
      return conn;
    },
    cut() {
      for (const conn of [...mine]) conn.cut();
    },
  };
}

const pageNet = {
  data(id, bytes) {
    conns.get(id)?.ondata?.(new Uint8Array(bytes));
  },
  closed(id) {
    const conn = conns.get(id);
    if (!conn) return;
    conns.delete(id);
    conn.closed = true;
    conn.onclose?.(true);
  },
  event(name, detail) {
    if (name === 'ready') run().then((pass) => finish(pass), (e) => { console.error(e); finish(false); });
    else if (name === 'command') {
      const a = detail.indexOf('\n'), b = detail.indexOf('\n', a + 1);
      waiters.get(Number(detail.slice(0, a)))?.({ ok: detail.slice(a + 1, b) === 'ok', text: detail.slice(b + 1) });
    } else if (name === 'snapshot') hooks.snapshot?.(detail === 'ok');
    else if (name === 'adopted') hooks.adopted?.(detail.slice(detail.indexOf('\n') + 1));
    else if (name === 'stopped') setTimeout(() => process.exit(process.exitCode || 0), 200);
  },
};

function finish(pass) {
  console.log(pass ? '[test] PASS' : '[test] FAIL');
  process.exitCode = pass ? 0 : 1;
  Module._electrode_stop();
  setTimeout(() => process.exit(process.exitCode), 8000);
}

// ---- the game's part ---------------------------------------------------------------------------

// The game's world connection through the bridge: packets by opcode, with what arrived kept.
function gameWorld(bridge, user, key) {
  const conn = bridge.connect(8085);
  const inbox = new Inbox();
  const game = { conn, closed: false, seen: [], waiting: [], toWorld: new Half(key), fromWorld: new Half(key) };
  conn.ondata = (bytes) => inbox.push(bytes);
  conn.onclose = () => {
    game.closed = true;
    inbox.end();
  };
  const cstr = (s) => concat(new TextEncoder().encode(s), Uint8Array.of(0));
  game.send = (opcode, body = new Uint8Array(0)) => conn.send(clientPacket(opcode, body, game.toWorld));
  // Resolves with the body of the next packet with this opcode (among those not yet taken).
  game.expect = (opcode, ms = 20000) => new Promise((resolve, reject) => {
    const hit = game.seen.findIndex((p) => p.opcode === opcode);
    if (hit >= 0) return resolve(game.seen.splice(hit, 1)[0].body);
    const timer = setTimeout(() => reject(new Error(`no packet 0x${opcode.toString(16)} within ${ms} ms`)), ms);
    game.waiting.push({ opcode, resolve: (body) => { clearTimeout(timer); resolve(body); } });
  });
  game.start = async () => {
    await new Promise((resolve) => { conn.onopen = resolve; });
    const hello = await inbox.read(8);
    const seed = crypto.getRandomValues(new Uint8Array(4));
    // One addon in the list, as the stock client sends.
    const addons = concat(cstr('Blizzard_AuctionUI'), Uint8Array.of(1), u32(0x4c1c776d), u32(0));
    const packed = new Uint8Array(zlib.deflateSync(addons));
    conn.send(clientPacket(OP.CMSG_AUTH_SESSION, concat(u32(5875), u32(0), cstr(user), seed, worldProof(user, seed, hello.subarray(4, 8), key), u32(addons.length), packed), null));
    (async () => {
      for (;;) {
        const h = game.fromWorld.decrypt(await inbox.read(4));
        const packet = { opcode: h[2] | (h[3] << 8), body: await inbox.read(((h[0] << 8) | h[1]) - 2) };
        const w = game.waiting.findIndex((x) => x.opcode === packet.opcode);
        if (w >= 0) game.waiting.splice(w, 1)[0].resolve(packet.body);
        else game.seen.push(packet);
      }
    })().catch(() => {});
  };
  return game;
}

const check = (ok, what) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) throw new Error(what);
};

async function run() {
  say('world ready');
  // The account as its host knows it, and as the game was told: the two passwords differ, as they
  // do after the world has moved to another host.
  const made = await command('account create BRIDGER HOSTPASS1');
  check(made.ok, 'account created on the world');
  const bridge = new SessionBridge({ user: 'BRIDGER', pass: 'GAMEPASS', realm: 'bridge test', log: say });
  const states = [];
  bridge.onstate = (s) => states.push(s);
  const first = makeWorld();
  await bridge.attach(first, { user: 'BRIDGER', pass: 'HOSTPASS1' });

  // The game signs in to the bridge, with what it was told.
  const wrong = await signIn(bridge, 'BRIDGER', 'NOTTHIS', true).then(() => 'let in', (e) => e.message);
  check(/refused/.test(wrong), `a wrong password is refused by the bridge (${wrong})`);
  const signed = await signIn(bridge, 'BRIDGER', 'GAMEPASS', true);
  check(signed.key.length === 40, 'the game signed in to the bridge');
  const listed = new TextDecoder().decode(signed.realms);
  check(listed.includes('bridge test'), 'the realm list is the world\'s own');

  const game = gameWorld(bridge, 'BRIDGER', signed.key);
  await game.start();
  const auth = await game.expect(OP.SMSG_AUTH_RESPONSE);
  check(auth[0] === 0x0c, 'the world let the game in through the bridge');
  await game.expect(OP.SMSG_ADDON_INFO);

  game.send(OP.CMSG_CHAR_ENUM);
  check((await game.expect(OP.SMSG_CHAR_ENUM))[0] === 0, 'no characters yet');
  // name, race human, class warrior, gender, skin, face, hair style, hair colour, facial hair, outfit
  game.send(OP.CMSG_CHAR_CREATE, concat(new TextEncoder().encode('Bridget\0'), Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0, 0)));
  check((await game.expect(OP.SMSG_CHAR_CREATE))[0] === 0x2e, 'character created');
  game.send(OP.CMSG_CHAR_ENUM);
  const list = await game.expect(OP.SMSG_CHAR_ENUM);
  check(list[0] === 1, 'one character listed');
  const guid = list.slice(1, 9);

  game.send(OP.CMSG_PLAYER_LOGIN, guid);
  const place = await game.expect(OP.SMSG_LOGIN_VERIFY_WORLD);
  check(place.length === 20 && bridge.inWorld, 'the character is in the world');
  game.send(OP.CMSG_JOIN_CHANNEL, new TextEncoder().encode('testchannel\0\0'));
  const joined = await game.expect(OP.SMSG_CHANNEL_NOTIFY);
  check(joined[0] === 0x02, 'joined a chat channel');
  await wait(1500);
  await command('saveall');
  await wait(500);

  // The host goes away: every connection to the world closes.
  say('cutting the world\'s connections');
  game.seen.length = 0;
  bridge.detach();
  first.cut();
  await wait(1000);
  check(!game.closed, 'the game\'s connection stayed open');
  check(states.at(-1) === 'detached', 'the bridge says the game is waiting');
  game.send(OP.CMSG_PING, concat(u32(77), u32(20)));
  const pong = await game.expect(OP.SMSG_PONG, 3000);
  check(pong[0] === 77, 'the game\'s ping is answered while there is no world');
  // The player walks on meanwhile: 12 yards along x.
  const f = (b, at) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(at, true);
  const walked = place.slice(4, 20);
  new DataView(walked.buffer).setFloat32(0, f(place, 4) + 12, true);
  game.send(OP.MSG_MOVE_HEARTBEAT, concat(u32(0), u32(500000), walked, u32(0)));

  // The world is somewhere again (the same server here, with a new password as a new host sets).
  await command('account set password BRIDGER HOSTPASS2 HOSTPASS2');
  const second = makeWorld();
  const moved = bridge.attach(second, { user: 'BRIDGER', pass: 'HOSTPASS2' });
  const pending = await game.expect(OP.SMSG_TRANSFER_PENDING);
  const arrive = await game.expect(OP.SMSG_NEW_WORLD);
  await moved;
  check(pending.length === 4 && arrive.length === 20, 'the game is told to load the world, not to sign in');
  const same = (a, b) => a.slice(0, 4).every((v, i) => v === b[i]);
  check(same(arrive, place), 'on the same map');
  const far = Math.hypot(f(arrive, 4) - f(place, 4), f(arrive, 8) - f(place, 8), f(arrive, 12) - f(place, 12));
  check(far < 5, `where the character stood (${far.toFixed(2)} yards off)`);
  check(!game.closed && states.includes('moving'), 'the game\'s connection is still the same one');
  await wait(500);
  check(!game.seen.some((p) => p.opcode !== OP.SMSG_TRANSFER_PENDING && p.opcode !== OP.SMSG_NEW_WORLD), 'nothing of the new world reaches the game before it has loaded');

  // The game has loaded: it gets the world as its new host sends it.
  game.send(OP.MSG_MOVE_WORLDPORT_ACK);
  await wait(2500);
  const got = new Set(game.seen.map((p) => p.opcode));
  check(got.has(0x0a9) || got.has(0x1f6), 'the world\'s objects reach the game after it has loaded');
  check(!got.has(OP.SMSG_AUTH_RESPONSE) && !got.has(OP.SMSG_ADDON_INFO) && !got.has(OP.SMSG_LOGIN_VERIFY_WORLD), 'no second sign-in is shown to the game');
  check(!game.seen.some((p) => p.opcode === OP.SMSG_CHANNEL_NOTIFY && p.body[0] === 0x02), 'its chat channel was joined again without telling it');
  check(states.at(-1) === 'attached', 'the bridge says the game is in the world again');
  const put = game.seen.find((p) => p.opcode === OP.MSG_MOVE_TELEPORT_ACK);
  check(put && Math.abs(f(put.body, put.body.length - 20) - f(walked, 0)) < 0.01, 'the game is put where the player walked to meanwhile');
  const online = await command('account onlinelist');
  check(/Bridget/.test(online.text), 'the world has the character online');
  game.seen.length = 0;
  game.send(OP.CMSG_PING, concat(u32(78), u32(20)));
  check((await game.expect(OP.SMSG_PONG, 5000))[0] === 78, 'the game talks to the new world');
  // Something only a player in a chat channel can do: the list of who is in it.
  game.send(0x09a, new TextEncoder().encode('testchannel\0'));
  await game.expect(0x09b, 5000);
  check(true, 'and is in its chat channel there');

  // From the character screen: the world moves, and the game's next request goes to the new host.
  game.send(0x04b); // CMSG_LOGOUT_REQUEST
  await game.expect(OP.SMSG_LOGOUT_COMPLETE, 30000);
  check(!bridge.inWorld, 'back at the character screen');
  bridge.detach();
  second.cut();
  await wait(500);
  game.send(OP.CMSG_CHAR_ENUM);
  await wait(300);
  const third = makeWorld();
  await bridge.attach(third, { user: 'BRIDGER', pass: 'HOSTPASS2' });
  const after = await game.expect(OP.SMSG_CHAR_ENUM);
  check(after[0] === 1, 'a request made between hosts is answered by the new one');
  // guid, name, race, class, gender, skin, face, hair style, hair colour, facial hair, level, zone, map, x…
  let at = 9;
  while (after[at] !== 0) at++;
  const savedX = f(after, at + 1 + 9 + 8);
  check(Math.abs(savedX - f(walked, 0)) < 1, `and the world has the character where the player walked to (x ${savedX.toFixed(1)}, was ${f(place, 4).toFixed(1)})`);
  check(!game.closed, 'the game\'s connection never closed');

  // A running server takes the world as it was saved elsewhere, without starting again.
  check(await snapshot(), 'the world saved, with one character');
  const saved = ['characters', 'realmd'].map((n) => fs.readFileSync(path.join(work, 'snapshot', `${n}.sqlite`)));
  game.send(OP.CMSG_CHAR_CREATE, concat(new TextEncoder().encode('Secondo\0'), Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0, 0)));
  check((await game.expect(OP.SMSG_CHAR_CREATE))[0] === 0x2e, 'a second character made after that save');
  fs.writeFileSync(path.join(work, 'db', 'incoming-characters.sqlite'), saved[0]);
  fs.writeFileSync(path.join(work, 'db', 'incoming-realmd.sqlite'), saved[1]);
  check((await adopt()) === 'busy', 'a server somebody is on does not take another save');
  bridge.drop();
  third.cut();
  await wait(1500);
  check((await adopt()) === 'ok', 'with nobody on it, it takes the save');
  check(!fs.existsSync(path.join(work, 'db', 'incoming-characters.sqlite')), 'and the files it was given are gone');
  await bridge.attach(makeWorld(), { user: 'BRIDGER', pass: 'HOSTPASS2' });
  const again = await signIn(bridge, 'BRIDGER', 'GAMEPASS', true);
  const game2 = gameWorld(bridge, 'BRIDGER', again.key);
  await game2.start();
  await game2.expect(OP.SMSG_AUTH_RESPONSE);
  game2.send(OP.CMSG_CHAR_ENUM);
  const now = await game2.expect(OP.SMSG_CHAR_ENUM);
  check(now[0] === 1 && new TextDecoder().decode(now.subarray(9, 16)) === 'Bridget', 'the world is as it was saved: one character');
  game2.send(OP.CMSG_CHAR_CREATE, concat(new TextEncoder().encode('Terzo\0'), Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0, 0)));
  check((await game2.expect(OP.SMSG_CHAR_CREATE))[0] === 0x2e, 'and a new character can be made in it');
  game2.send(OP.CMSG_CHAR_ENUM);
  check((await game2.expect(OP.SMSG_CHAR_ENUM))[0] === 2, 'which is there next to the first');

  // A save in which something differs that the server holds in memory (a guild): it says so.
  bridge.drop();
  await wait(1500);
  const withGuild = path.join(work, 'db', 'incoming-characters.sqlite');
  fs.writeFileSync(withGuild, saved[0]);
  const db = new DatabaseSync(withGuild);
  const columns = db.prepare('PRAGMA table_info(guild)').all();
  db.exec(`INSERT INTO guild (${columns.map((c) => c.name).join(', ')}) VALUES (${columns.map((c) => (c.name === 'guildid' ? '7' : /INT/i.test(c.type) ? '0' : "'x'")).join(', ')})`);
  db.close();
  check((await adopt()) === 'stale', 'a save with a guild this server has not loaded is not taken: it has to start afresh');
  return true;
}

const require = createRequire(import.meta.url);
const createMangosd = require(path.join(serverDir, 'mangosd.js'));
Module = await createMangosd({
  pageNet,
  print: (line) => (/ERROR|rror:/.test(line) ? console.log(`${since().padStart(7)}  ${line}`) : null),
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
say('module loaded, starting the world');
Module.callMain(['-c', '/etc/mangosd.conf']);
