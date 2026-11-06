// The launcher page is the desktop app's own launcher (index.html, theme.css, launcher.js). On
// the desktop its commands go to the app's main process; here this module answers them, with the
// same names and the same state shape, from what a browser tab can do:
//   the world server runs in a worker of this tab (lib/server.js), the game files are read where
//   they are (lib/gamefiles.js), other players are reached browser to browser (lib/p2p.js), and
//   the Servers list is the official registry on GitLab (lib/registry.js).
// Every command resolves to { ok, value | error }, as on the desktop.

import { VERSION } from './version.js';
import { gameFilesStatus, linkGameFolder, grantGameFolder, useSessionFiles, forgetGameFolder, getArchiveFiles, removeGameFiles, startServiceWorker, TOTAL_BYTES } from './lib/gamefiles.js';
import { installGameDataReader } from './lib/gamedata-sync.js';
import { WorldServer } from './lib/server.js';
import { installWebSocketShim } from './lib/ws-shim.js';
import { loadIdentity } from './lib/identity.js';
import { WorldHost, WorldGuest, canonName } from './lib/p2p.js';
import { loadRegistry, fingerprint as keyFingerprint, REGISTRY_REPO } from './lib/registry.js';
import { storeCopy, copyInfo } from './lib/copy-store.js';
import { SessionBridge } from './lib/session.js';

const $ = (id) => document.getElementById(id);
const messageOf = (e) => (e && e.message) || String(e);
const query = new URLSearchParams(location.search);
// A second identity in the same browser, for trying two players on one computer.
const profile = (query.get('profile') || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
// Development: other trackers than the public ones (the local one of tools/dev-server.mjs).
const trackers = query.get('trackers') ? query.get('trackers').split(',') : undefined;
const DEFAULT_CAP = 100;
// What the game's login screen shows as the place it connects to (it would show the page's host name).
const LOGIN_LABEL = 'Asmongold';
// The realm's name in the game: the world's own string, as in the desktop app; 'Electrode' when playing alone.
const realmOf = (name) => (name ? canonName(name).replace(/["\\]/g, '').slice(0, 32) : 'Electrode');

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`electrode:${key}${profile ? ':' + profile : ''}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`electrode:${key}${profile ? ':' + profile : ''}`, JSON.stringify(value));
    } catch { /* not kept */ }
  },
};

// ---- state, as the launcher renders it ----------------------------------------------------------

const state = {
  phase: 'idle', error: '', busy: false, blocked: '',
  gameFolder: '', gameFolderStatus: '', gameImport: null,
  extraction: '', database: '', servers: '',
  peer: '', account: '', bind: 'this tab', myLevel: 0, peers: 0, peersList: [],
  world: null, string: '', invite: '', candidates: [],
  ipNoticeAccepted: store.get('notice') === true, gameFilesAccepted: store.get('notice') === true,
  nativeGame: false, notifications: false, setup: null,
  worlds: [], permanent: [], permanentError: null, permanentRequests: {},
};
const logs = [];
const listeners = { state: [], log: [], update: [] };
const snapshot = () => JSON.parse(JSON.stringify(state));
function set(patch) {
  Object.assign(state, patch);
  const s = snapshot();
  for (const fn of listeners.state) fn(s);
}
function log(line) {
  logs.push(line);
  if (logs.length > 600) logs.splice(0, 100);
  for (const fn of listeners.log) fn(line);
}
const update = { phase: 'off', why: 'this page is always the current version', current: VERSION };

const command = (fn) => async (...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (e) {
    console.error(e);
    return { ok: false, error: messageOf(e) };
  }
};

let server = null;
let host = null;
let guest = null;
// Where the world is: the server in this tab, or its host. It changes when a world moves to
// another player while the game is open.
let current = null;
// In a named world the game's connections end at this page (lib/session.js), which passes them
// on to wherever the world is, so the game stays in the world while that changes. Alone, the
// game talks to the server in this tab directly.
let session = null;
const link = { connect: (port) => (session ? session.connect(port) : current ? current.connect(port) : deadConnection()) };
function deadConnection() {
  const conn = { onopen: null, ondata: null, onclose: null, open: false, closed: false, send() {}, close() { conn.closed = true; } };
  setTimeout(() => {
    if (conn.closed) return;
    conn.closed = true;
    conn.onclose?.(false);
  }, 0);
  return conn;
}
let reader = null;
let identity = null;
let registry = { worlds: [] };
let filesInfo = { ready: false, needGrant: false };
let data = {}; // world/.extracted.json
let extractor = null;
let dataWaiters = [];

// ---- the game files -------------------------------------------------------------------------

async function refreshFiles() {
  const status = await gameFilesStatus();
  filesInfo = { ready: status.ready, needGrant: !status.ready && status.mode === 'linked' && status.needsPermission && status.sources?.linked !== 'denied' };
  if (status.ready) {
    const where = {
      linked: 'your game folder, read where it is (nothing is copied or uploaded)',
      session: 'the folder you chose, for this visit (this browser cannot remember a folder)',
      copied: `a copy in this browser (${(TOTAL_BYTES / 1e9).toFixed(1)} GB)`,
    }[status.mode] || 'ready';
    set({ gameFolder: where, gameFolderStatus: 'names and sizes match (1.12.1, build 5875)' });
  } else if (filesInfo.needGrant) {
    set({ gameFolder: 'your game folder', gameFolderStatus: 'the browser asks once per visit before this page may read it: click "Use my WoW folder…"' });
  } else {
    set({ gameFolder: '', gameFolderStatus: '' });
  }
  return status.ready;
}

async function afterFolder() {
  if (await refreshFiles()) {
    await reader?.reset().catch(() => {});
    data = await extractionStatus();
    showExtraction();
    startExtraction();
  }
  return snapshot();
}

// Called straight from a click, so the picker and the permission prompt are allowed to open.
function pickFolder() {
  if (state.busy) return Promise.resolve(snapshot());
  if (filesInfo.needGrant) return grantGameFolder().then(afterFolder);
  if (!window.showDirectoryPicker) {
    $('folderInput').click();
    return Promise.resolve(snapshot());
  }
  return window.showDirectoryPicker({ id: 'electrode-game', mode: 'read' }).then(
    async (handle) => {
      try {
        await linkGameFolder(handle);
      } catch (e) {
        if (e.code !== 'unsupported') throw e;
        await useSessionFiles(handle); // the folder cannot be remembered here: this visit only
      }
      return afterFolder();
    },
    () => snapshot() // the player closed the picker
  );
}

// ---- the world data (extraction) --------------------------------------------------------------

const dataReady = () => Boolean(data.dbc && data.maps);
function showExtraction(detail) {
  const text = data.dbc && data.maps && data.vmaps ? 'game tables, terrain and collision data ready'
    : dataReady() ? `game tables and terrain ready; collision data ${extractor ? 'being prepared' : 'not prepared yet'}`
      : extractor ? 'preparing game tables and terrain' : '';
  set({ extraction: detail ? `${text} (${detail})` : text });
}

function extractionStatus() {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./extract-worker.js', import.meta.url), { type: 'module' });
    const done = (value) => {
      w.terminate();
      resolve(value);
    };
    w.onmessage = ({ data: m }) => {
      if (m.type === 'status') done(m.state || {});
      else if (m.type === 'error') done({});
    };
    w.onerror = () => done({});
    w.postMessage({ cmd: 'status' });
  });
}

const STAGE = { dbc: 'game tables', maps: 'terrain', vmaps: 'collision data' };
function startExtraction() {
  if (extractor || !filesInfo.ready) return;
  const stages = ['dbc', 'maps', 'vmaps'].filter((s) => !data[s]);
  if (!stages.length) return;
  extractor = new Worker(new URL('./extract-worker.js', import.meta.url), { type: 'module' });
  const ended = (error) => {
    extractor?.terminate();
    extractor = null;
    if (error) log('extraction: ' + error);
    showExtraction(error ? `stopped: ${error}` : undefined);
    for (const w of dataWaiters.splice(0)) w();
  };
  extractor.onmessage = ({ data: m }) => {
    if (m.type === 'progress') {
      showExtraction(`${STAGE[m.stage] || m.stage}${m.detail ? ': ' + m.detail : ''}${m.total ? `, ${Math.round((m.done / m.total) * 100)}%` : ''}`);
      if (state.setup && !dataReady()) setupStep(m.stage === 'dbc' ? 'tables' : 'terrain', m.total ? m.done / m.total : 0, `${STAGE[m.stage] || m.stage}: ${m.detail || ''}`);
    } else if (m.type === 'done') {
      data[m.stage] = true;
      log(`extraction: ${STAGE[m.stage] || m.stage} ready`);
      showExtraction();
      if (dataReady()) for (const w of dataWaiters.splice(0)) w();
    } else if (m.type === 'finished') {
      data = { ...data, ...(m.state || {}) };
      ended();
    } else if (m.type === 'error') ended(m.message);
  };
  extractor.onerror = (e) => ended(e.message || 'the extraction worker failed to load');
  showExtraction();
  getArchiveFiles().then((files) => extractor?.postMessage({ cmd: 'run', stages, files }), (e) => ended(messageOf(e)));
}

// ---- the loading card ---------------------------------------------------------------------------

const STEPS = [
  ['network', 'Finding the world', 9], ['tables', 'Game tables', 4], ['terrain', 'Terrain', 14],
  ['database', 'World database', 10], ['server', 'World server', 22], ['game', 'Game client', 20],
];
let setupStart = 0;
let setupTimer = 0;
function setupBegin(skip) {
  setupStart = Date.now();
  set({ setup: { label: 'Starting…', percent: 0, elapsed: 0, secondsLeft: 0, steps: STEPS.filter(([id]) => !skip.includes(id)).map(([id, label, weight]) => ({ id, label, weight, state: '', part: 0 })) } });
  clearInterval(setupTimer);
  setupTimer = setInterval(() => state.setup && setupStep(), 1000);
}
function setupStep(id, part = 0, label) {
  const u = state.setup;
  if (!u) return;
  if (id) {
    let before = true;
    for (const st of u.steps) {
      if (st.id === id) {
        st.state = 'active';
        st.part = Math.max(0, Math.min(1, part));
        before = false;
      } else if (before) {
        st.state = 'done';
        st.part = 1;
      }
    }
    if (label) u.label = label;
  }
  const total = u.steps.reduce((sum, st) => sum + st.weight, 0);
  const done = u.steps.reduce((sum, st) => sum + st.weight * (st.state === 'done' ? 1 : st.part), 0);
  u.percent = Math.min(99, Math.round((done / total) * 100));
  u.elapsed = Math.round((Date.now() - setupStart) / 1000);
  u.secondsLeft = u.percent > 3 ? Math.round((u.elapsed * (100 - u.percent)) / u.percent) : 0;
  set({ setup: u });
}
function setupEnd() {
  clearInterval(setupTimer);
  set({ setup: null });
}

// ---- worlds this browser knows -----------------------------------------------------------------

async function roomHex(name) {
  const bytes = new TextEncoder().encode('wow-electrode-web/v1/room/' + canonName(name));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
const records = () => store.get('worlds', []);
function remember(record) {
  const all = records().filter((w) => w.hex !== record.hex);
  all.unshift(record);
  store.set('worlds', all);
}
function listWorlds() {
  const current = state.world?.hex;
  return records().map((w) => ({
    hex: w.hex, string: w.string, created: w.created, founderHex: w.founderHex || null,
    founder: false, // "Make permanent" belongs to the desktop app, where a world has a signed record
    permanent: registry.worlds.some((p) => p.worldHex === w.hex), joined: true,
    hosting: current === w.hex && !!host, playing: current === w.hex && state.phase === 'playing',
    copy: w.hosted ? 'its characters are kept in this browser' : w.copy ? 'this browser keeps a copy of it' : 'kept by the player who runs it',
  }));
}

// A world's rules as the server's settings (the desktop app's mapping).
const RULES = {
  xpKill: 'Rate.XP.Kill', xpQuest: 'Rate.XP.Quest', xpExplore: 'Rate.XP.Explore',
  dropItemPoor: 'Rate.Drop.Item.Poor', dropItemNormal: 'Rate.Drop.Item.Normal', dropItemUncommon: 'Rate.Drop.Item.Uncommon',
  dropItemRare: 'Rate.Drop.Item.Rare', dropItemEpic: 'Rate.Drop.Item.Epic', dropItemLegendary: 'Rate.Drop.Item.Legendary',
  dropItemArtifact: 'Rate.Drop.Item.Artifact', dropItemReferenced: 'Rate.Drop.Item.Referenced', dropMoney: 'Rate.Drop.Money',
  honor: 'Rate.Honor', reputationGain: 'Rate.Reputation.Gain', restInGame: 'Rate.Rest.InGame',
  restOfflineInTavern: 'Rate.Rest.Offline.InTavernOrCity', restOfflineInWilderness: 'Rate.Rest.Offline.InWilderness',
  maxPlayerLevel: 'MaxPlayerLevel', startPlayerLevel: 'StartPlayerLevel', startPlayerMoney: 'StartPlayerMoney', maxPlayers: 'PlayerLimit',
};
function settingsOf(ruleset = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ruleset)) if (RULES[k] && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[RULES[k]] = String(v);
  return out;
}

// ---- the Servers list: the official registry, and who plays there ---------------------------------

const population = (online, cap) => (online / cap >= 1 ? 'Full' : online / cap >= 0.7 ? 'High' : online / cap >= 0.3 ? 'Medium' : 'Low');
const counts = new Map(); // world hex -> { online, cap, at }
let visible = [];

function listPermanent() {
  return registry.worlds.map((w) => {
    const cap = w.ruleset.maxPlayers || DEFAULT_CAP;
    const mine = state.world?.hex === w.worldHex && host ? { online: host.players + 1, cap } : null;
    const seen = mine || counts.get(w.worldHex);
    return {
      hex: w.worldHex, string: w.string, founder: keyFingerprint(w.founderHex), founderHex: w.founderHex, description: w.description,
      population: seen ? population(seen.online, seen.cap) : null, online: seen ? seen.online : null, cap: seen ? seen.cap : null,
      rates: { xpKill: w.ruleset.xpKill, dropItemNormal: w.ruleset.dropItemNormal, dropMoney: w.ruleset.dropMoney, maxPlayerLevel: w.ruleset.maxPlayerLevel },
    };
  });
}

async function refreshRegistry(force) {
  const r = await loadRegistry({ force });
  registry = r;
  for (const e of r.errors || []) log(`permanent worlds: ignored ${e.file}: ${e.error}`);
  if (r.error) log(`permanent worlds: ${r.error}`);
  set({ permanent: listPermanent(), permanentError: r.error || null, worlds: listWorlds() });
  countVisible();
}

// Who plays in the worlds on screen: asked of each world's host, browser to browser.
let counting = false;
let countAgain = false;
async function countVisible() {
  if (!state.ipNoticeAccepted) return;
  if (counting) {
    countAgain = true; // the list on screen changed meanwhile
    return;
  }
  counting = true;
  countAgain = false;
  try {
    await Promise.all(visible.map(async (hex) => {
      const w = registry.worlds.find((x) => x.worldHex === hex);
      const known = counts.get(hex);
      if (!w || (known && Date.now() - known.at < 45000)) return;
      const cap = w.ruleset.maxPlayers || DEFAULT_CAP;
      const seen = await WorldGuest.peek(w.string, { trackers }).catch(() => null);
      // A world nobody runs right now is not offline: it has 0 players, and whoever joins runs it.
      counts.set(hex, { online: seen ? seen.online : 0, cap: seen ? seen.cap : cap, at: Date.now() });
      set({ permanent: listPermanent() });
    }));
  } finally {
    counting = false;
  }
  if (countAgain) countVisible();
}
setInterval(() => document.visibilityState === 'visible' && state.phase !== 'playing' && countVisible(), 60000);

// ---- starting a world, joining one, and the game ------------------------------------------------

function showGame() {
  document.body.classList.add('playing');
  document.body.classList.remove('show-launcher');
  $('benilla').focus();
}

function setChip() {
  $('chip').textContent = host ? `${host.name}: running here, ${host.players} other player${host.players === 1 ? '' : 's'}`
    : guest ? `${guest.name}: joined` : '';
  if (host) set({ peers: host.players, peersList: [...host.peers].filter((p) => p.account).map((p) => ({ account: p.account.user, level: 0, online: true })), permanent: listPermanent() });
}

// The client's saved settings live in localStorage, one entry per file. Mark the 1.12 license
// screens as read and start in a window, as the desktop app does.
function seedClientConfig() {
  try {
    const key = 'benilla:/benilla-config/config.toml';
    let text = localStorage.getItem(key) || '[cvars]\n';
    if (!/^\[cvars\]/m.test(text)) text = '[cvars]\n' + text;
    for (const k of ['readEULA', 'readTOS']) {
      const re = new RegExp('^' + k + '\\s*=.*$', 'mi');
      text = re.test(text) ? text.replace(re, k + ' = "1"') : text.replace(/^\[cvars\]\n?/m, '[cvars]\n' + k + ' = "1"\n');
    }
    if (!/^gxWindow\s*=/mi.test(text)) text = text.replace(/^\[cvars\]\n?/m, '[cvars]\ngxWindow = "1"\n');
    localStorage.setItem(key, text);
  } catch (e) {
    console.warn('could not seed the client settings', e);
  }
}

// The files of every addon that is on, for the game (shipped ones are fetched once and kept).
async function addonFiles() {
  try {
    const { getAddonFiles } = await import('./lib/addons.js');
    const files = await getAddonFiles();
    for (const problem of files.problems || []) log('addons: ' + (problem.message || problem));
    return files;
  } catch (e) {
    log('addons: ' + messageOf(e));
    return [];
  }
}

async function startReader() {
  // Addons are switched in the launcher only: the client's own per-character lists start empty.
  await import('./lib/addons.js').then((m) => m.forgetClientAddonLists(), () => {});
  const addons = await addonFiles();
  if (reader) await reader.reset({ addons });
  else reader = await installGameDataReader({ addons });
  if (reader.ready?.error) throw new Error(reader.ready.error);
}

// `begun`: called once the server has started loading (a host announces the world then).
// `warm`: the server this browser kept warm for the world (see "the warm standby"): it only has
// to take the world over.
async function startWorldHere(worldKey, settings, extra = {}, begun = null, warm = null) {
  if (!warm && !dataReady()) {
    if (!extractor) startExtraction();
    if (!extractor) throw new Error('The world data could not be prepared from the game files.');
    setupStep('tables', 0, 'Preparing the world data from your game files…');
    if (carrying) carry('It carries on from this browser: preparing the world data…');
    await new Promise((resolve) => dataWaiters.push(resolve));
    if (!dataReady()) throw new Error('The world data could not be prepared from the game files.');
  }
  setupStep('database', 0, 'Loading the world database…');
  set({ database: 'loading', servers: 'starting' });
  server = warm || new WorldServer();
  server.addEventListener('status', (e) => {
    const text = e.detail;
    if (carrying) carry(`It carries on from this browser: ${text.replace(/…$/, '').toLowerCase()}…`);
    if (/database/i.test(text)) setupStep('database', (Number(/(\d+)%/.exec(text)?.[1]) || 0) / 100, text);
    else setupStep('server', /Starting the world/.test(text) ? 0.15 : 0, text);
  });
  let lines = 0;
  server.addEventListener('log', (e) => {
    for (const line of e.detail) if (line.trim()) log(line);
    lines += e.detail.length;
    if (!server.ready) setupStep('server', Math.min(0.97, 0.15 + lines / 700));
  });
  server.addEventListener('error', (e) => log('error: ' + messageOf(e.detail)));
  server.addEventListener('saved', (e) => {
    $('saved').textContent = 'saved ' + new Date(e.detail).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
  const starting = warm
    ? server.takeover({ owner: extra.owner, admin: extra.admin })
    : server.start({ world: worldKey, settings, fsStats: query.has('fsstats'), store: profile, ...extra });
  starting.catch(() => {});
  if (begun) await begun();
  const account = await starting;
  set({ database: 'ready' });
  return account;
}

async function startClient(account, realm) {
  setupStep('game', 0, 'Opening the game…');
  await startReader();
  installWebSocketShim(link);
  seedClientConfig();
  window.__wenilla_env = { user: account.user, pass: account.pass, realm, host: LOGIN_LABEL, readeula: '1', readtos: '1' };
  showGame();
  const [{ default: init }, { bind }, { boot }] = await Promise.all([
    import('./client/wenilla.js'),
    import('./client/wasi_stubs.js'),
    import('./client/boot.js'),
  ]);
  import('./client/platform.js')
    .then(({ installFullscreenToggle }) => installFullscreenToggle($('fs'), { focusTarget: $('benilla') }))
    .catch((e) => console.warn('platform.js:', e));
  import('./client/bridge.js').catch((e) => console.warn('bridge.js:', e));
  const w = await boot(init);
  bind(w.memory);
}

// `name`: null to play alone, else the world's name (a room of the player's, or an official world).
async function enter(name) {
  if (state.phase === 'playing') {
    showGame();
    return snapshot();
  }
  if (state.busy) return snapshot();
  if (!filesInfo.ready) throw new Error('Add your game files first.');
  set({ busy: true, phase: 'starting', error: '', string: name ? canonName(name) : '' });
  // The first two steps only show while the world data is still being made from the game files.
  setupBegin([...(name ? [] : ['network']), ...(dataReady() ? ['tables', 'terrain'] : [])]);
  try {
    identity = identity || (await loadIdentity(profile));
    set({ peer: identity.id });
    let account;
    if (name) {
      const canon = canonName(name);
      const official = registry.worlds.find((w) => w.string === canon);
      const hex = official ? official.worldHex : await roomHex(canon);
      setupStep('network', 0.2, `Looking for "${canon}"…`);
      const found = await WorldGuest.find(canon, { identity, trackers, onstatus: (text) => setupStep('network', 0.7, text) });
      const created = records().find((w) => w.hex === hex)?.created || official?.created || new Date().toISOString();
      set({ invite: `${location.origin}${location.pathname}?world=${encodeURIComponent(canon)}` });
      if (found) account = joined(found, canon, hex, official, created);
      else {
        // Nobody runs it right now: it starts here, from what this browser keeps of it (the
        // characters of a world this browser ran or played in), or new.
        setupStep('network', 1, `Nobody is running "${canon}". Starting it here…`);
        account = await hostWorld(canon, hex, official, created);
      }
      session = new SessionBridge({ user: account.user, pass: account.pass, realm: realmOf(canon), log: (line) => log('session: ' + line) });
      session.onstate = (now) => now === 'attached' && carried();
      await session.attach(current, account);
    } else {
      account = await startWorldHere('solo', {});
      session = null;
      current = server;
      set({ world: null, invite: '', servers: 'ready', account: account.user, myLevel: 3, bind: 'this tab' });
    }
    set({ worlds: listWorlds(), permanent: listPermanent() });
    await startClient(account, guest ? guest.realm || realmOf(name) : realmOf(name));
    setupEnd();
    set({ phase: 'playing', busy: false, worlds: listWorlds() });
    setChip();
  } catch (e) {
    console.error(e);
    host?.stop();
    host = null;
    guest?.leave();
    guest = null;
    current = null;
    session = null;
    server?.worker.terminate();
    server = null;
    document.body.classList.remove('playing');
    setupEnd();
    set({ phase: 'error', error: messageOf(e), busy: false, world: null, string: '', servers: 'stopped', database: '', worlds: listWorlds() });
    log('error: ' + messageOf(e));
  }
  return snapshot();
}

function worldGone(text) {
  carrying = false;
  $('carry').classList.add('hidden');
  $('goneText').textContent = text;
  $('gone').classList.remove('hidden');
  set({ phase: 'error', error: text });
}

// ---- a world and its hosts ----------------------------------------------------------------------
// A world outlives the player who runs it. Whoever runs it sends every player in it a copy of its
// characters and accounts at each save. When that player leaves, the others look for the world
// again: the one who has been in it longest starts it from the copy they keep, and the rest join
// them there. The game stays open meanwhile and is signed in again on the new host.

// This tab plays in a world another player runs.
function joined(g, canon, hex, official, created) {
  guest = g;
  current = g;
  g.oncopy = (copy) => keepCopy(hex, canon, copy);
  g.onclose = (leaving) => carryOn(leaving).catch((e) => {
    console.error(e);
    worldGone(messageOf(e));
  });
  if (g.hostChanged) log(`"${canon}" is run by a different player than last time.`);
  setTimeout(reportFit, 1500);
  const before = records().find((w) => w.hex === hex) || {};
  remember({ ...before, hex, string: canon, created, hosted: before.hosted || false, founderHex: official?.founderHex || null });
  set({
    world: { hex, string: canon, founder: official ? keyFingerprint(official.founderHex).slice(0, 9) : g.hostId.slice(0, 9), isFounder: false, created },
    servers: `host ${g.hostId.slice(0, 9)} (${g.kind === 'desktop' ? 'the desktop app' : 'a browser'})`, database: 'remote',
    account: g.account.user, myLevel: 0, peers: 1, bind: 'through its host',
  });
  return g.account;
}

// This tab runs the world and lets other players in. They can find it from the moment it starts
// here: a player who arrives early is let in once the world is up.
async function hostWorld(canon, hex, official, created, warm = null) {
  const ruleset = official ? official.ruleset : {};
  const realm = realmOf(canon);
  // One player, one account in a world: the key's own, whether it runs the world or joins it.
  const account = await startWorldHere(hex, settingsOf(ruleset), { owner: identity.id, admin: !official, realm }, async () => {
    host = new WorldHost({ name: canon, server, identity, trackers, cap: ruleset.maxPlayers || DEFAULT_CAP, realm });
    host.onchange = setChip;
    // A player who just got in receives the world as it is now.
    host.onjoin = () => server && server.ready && server.save();
    if (!(await host.start())) throw new Error('None of the public trackers could be reached, so others could not find this world.');
  }, warm);
  server.addEventListener('saved', () => sendCopy());
  current = server;
  const before = records().find((w) => w.hex === hex) || {};
  // The player who made a room has every command in it; an official world gives its host none.
  const mine = Boolean(before.mine || (server.fresh && !official));
  remember({ ...before, hex, string: canon, created, hosted: true, mine, founderHex: official?.founderHex || null });
  set({
    world: { hex, string: canon, founder: official ? keyFingerprint(official.founderHex).slice(0, 9) : mine ? identity.id.slice(0, 9) : 'another player', isFounder: mine, created },
    servers: 'hosting', account: account.user, myLevel: mine ? 3 : 0, bind: 'this tab', peers: 0,
  });
  return account;
}

// The world as just saved, to the players in it.
let sending = Promise.resolve();
function sendCopy(final = false) {
  sending = sending.then(async () => {
    if (!host || !host.players || !server || !server.ready) return;
    const copy = await server.copy();
    if (copy && host) await host.sendCopy(copy, { final });
  }).catch((e) => log('world copy: ' + messageOf(e)));
  return sending;
}

// The host's copy of the world, kept in this browser.
let keeping = Promise.resolve();
let toldOlder = false;
function keepCopy(hex, canon, copy) {
  // A tab of this same player runs the world: its storage is this one and holds the world already.
  if (guest && guest.hostId === identity.id) return;
  keeping = keeping.then(() => storeCopy(hex, copy, profile)).then((kept) => {
    if (!kept.stored) {
      if (!toldOlder) log(`"${canon}": this browser keeps a later save of this world (save ${kept.have}) than the one its host runs (save ${copy.seq}). The one kept here is not written over.`);
      toldOlder = true;
      return;
    }
    $('saved').textContent = 'copy kept ' + new Date(copy.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (standby) refreshStandby();
    else warmSoon(hex, canon);
    const record = records().find((w) => w.hex === hex);
    if (record && !record.copy) {
      remember({ ...record, copy: true });
      set({ worlds: listWorlds() });
    }
  }).catch((e) => log('world copy: not kept: ' + messageOf(e)));
}

// ---- the warm standby ---------------------------------------------------------------------------
// A player in a world someone else runs keeps a server of that world up in their own browser,
// with the world as the host last sent it and nobody on it. Each copy the host sends goes into
// it as it arrives. When the host goes away, the first player in line does not have to start a
// server: theirs takes the world over at once. Who is first is the host's to say, from what each
// browser can do and how well it is connected (lib/p2p.js).

let standby = null; // { server, hex, ready, bootMs, up: promise, taken }
let warming = 0;

// Whether this browser should ever run a world it only joined: the player can say no
// (electrode:host = false in this browser's storage), and a small device is not asked to.
const mayHostHere = () => store.get('host', true) !== false && (navigator.deviceMemory || 8) >= 4 && (navigator.hardwareConcurrency || 4) >= 4;

function reportFit() {
  if (!guest || !guest.copies) return;
  guest.report({ able: mayHostHere() && dataReady(), ready: Boolean(standby && standby.ready), bootMs: (standby && standby.bootMs) || 0 });
}

function warmSoon(hex, canon) {
  clearTimeout(warming);
  warming = setTimeout(() => {
    if (!guest || standby) return;
    if (state.phase !== 'playing') return warmSoon(hex, canon); // the game starts first
    warmUp(hex, canon);
  }, 6000);
}

function warmUp(hex, canon) {
  if (standby || !guest || !guest.copies || guest.hostId === identity.id || !mayHostHere() || !dataReady()) return reportFit();
  const official = registry.worlds.find((w) => w.string === canon);
  const s = { server: new WorldServer(), hex, ready: false, bootMs: 0, taken: false };
  standby = s;
  s.server.addEventListener('error', (e) => log('standby: ' + messageOf(e.detail)));
  s.up = s.server.standby({ world: hex, settings: settingsOf(official ? official.ruleset : {}), realm: realmOf(canon), store: profile }).then(async (up) => {
    if (standby !== s && !s.taken) return s.server.worker.terminate();
    s.ready = true;
    s.bootMs = up.bootMs;
    log(`"${canon}": this browser keeps the world warm (its server started in ${(up.bootMs / 1000).toFixed(1)} s) and can carry it on at once.`);
    if (!s.taken) {
      if (guest) set({ servers: `host ${guest.hostId.slice(0, 9)} (a browser); kept warm here` });
      await refreshStandby(); // a copy may have come in meanwhile
      reportFit();
    }
  }, (e) => {
    if (standby === s) standby = null;
    s.server.worker.terminate();
    log('standby: ' + messageOf(e));
    reportFit();
  });
}

// The standby takes the copy just stored. A copy that changed something a server only reads as it
// starts (a guild, a group, an auction, a corpse) cannot be taken by a running one: the standby
// is started afresh then.
async function refreshStandby() {
  const s = standby;
  if (!s || !s.ready) return;
  const out = await s.server.adopt();
  if (standby !== s || out.result === 'ok') return;
  if (out.result !== 'stale') log('standby: ' + out.result);
  s.server.worker.terminate();
  standby = null;
  reportFit();
  if (guest) warmUp(s.hex, guest.name);
}

// The server kept warm for this world, for taking it over; null when there is none to use.
async function warmServer(hex) {
  const s = standby;
  standby = null;
  clearTimeout(warming);
  if (!s) return null;
  s.taken = true;
  if (s.hex === hex && !s.ready) await s.up; // it is on its way up: sooner than starting another
  if (s.hex === hex && s.ready) return s.server;
  s.server.worker.terminate();
  return null;
}

function dropStandby() {
  clearTimeout(warming);
  standby?.server.worker.terminate();
  standby = null;
}

// While the world is between hosts the game stays as it is, with a line across the top.
let carrying = false;
function carry(text) {
  carrying = true;
  $('carryText').textContent = text;
  $('carry').classList.remove('hidden');
}
function carried() {
  if (!carrying) return;
  carrying = false;
  $('carry').classList.add('hidden');
}

// The player who ran the world went away. The game keeps its connection, which ends in this page
// (lib/session.js): it is held until the world is somewhere again, and then the character enters
// it there and the game loads the world where the character stood.
async function carryOn(leaving) {
  const was = guest;
  if (!was || !state.world) return;
  const canon = was.name;
  const hex = state.world.hex;
  const created = state.world.created;
  const official = registry.worlds.find((w) => w.string === canon);
  guest = null;
  current = null;
  session?.detach();
  was.leave();
  log(`"${canon}": the player who was running it ${leaving ? 'left' : 'is gone'}.`);
  carry('Looking for it…');
  set({ servers: 'moving to another player', peers: 0 });
  setChip();
  try {
    await keeping; // a copy that was arriving is stored first
    const have = await copyInfo(hex, profile);
    // The first in line carries the world on: at once when the host said it was leaving, after a
    // short look otherwise (only this player's connection may have failed). Each next player
    // gives those before it time to: little when they keep a server warm, more when theirs has
    // to start. Without a copy, or with no place in the line (this browser said it cannot run
    // the world), this tab can only wait for someone else.
    const mayHost = Boolean(have) && was.rank > 0;
    const before = was.rank - 1;
    const wait = !mayHost ? 120000
      : before <= 0 ? (leaving ? 0 : 4000)
      : Math.min(120000, (was.warmAhead > 0 ? 10000 : 30000) + (before - 1) * (was.warmAhead >= before ? 6000 : 15000));
    const found = wait ? await WorldGuest.find(canon, { identity, trackers, timeoutMs: wait }).catch(() => null) : null;
    let account;
    if (found) {
      account = joined(found, canon, hex, official, created);
      log(`"${canon}" is now run by player ${found.hostId.slice(0, 9)}.`);
    } else if (mayHost) {
      const warm = await warmServer(hex);
      carry(warm ? 'It carries on from this browser…' : 'It carries on from this browser: starting its server…');
      log(`"${canon}": carrying it on here from the copy kept in this browser (save ${have.seq})${warm ? ', on the server kept warm for it' : ''}.`);
      try {
        account = await hostWorld(canon, hex, official, created, warm);
      } catch (e) {
        if (!warm) throw e;
        // The warm server could not take the world as it is now: one is started for it.
        log(`standby: ${messageOf(e)}. Starting the world's server afresh.`);
        host?.stop();
        host = null;
        server?.worker.terminate();
        server = null;
        carry('It carries on from this browser: starting its server…');
        account = await hostWorld(canon, hex, official, created, null);
      }
    } else {
      return worldGone(was.kind === 'desktop'
        ? `The player who was running "${canon}" from the desktop app left, and no other player is running it yet. Join it again to carry on.`
        : `The player who was running "${canon}" left before this browser had a copy of the world, and nobody else is running it. Join it again in a moment.`);
    }
    carry('Entering it again…');
    try {
      await session.attach(current, account);
    } catch (e) {
      // The character cannot enter the world as its new host has it (it was made after that
      // host's last copy, say): the game signs in again and shows what is there.
      log(`"${canon}": ${messageOf(e)}. The game signs in again.`);
      session.drop();
      await signInAgain({ user: session.user, pass: session.pass });
    }
    if (session.state === 'attached') carried(); // else when the game has loaded the world
    setTimeout(carried, 60000);
    set({ phase: 'playing', error: '', worlds: listWorlds(), permanent: listPermanent() });
    setChip();
  } catch (e) {
    host?.stop();
    host = null;
    guest?.leave();
    guest = null;
    current = null;
    server?.worker.terminate();
    server = null;
    dropStandby();
    throw e;
  }
}

// The game is at its login screen: sign it in to the world where it is now.
async function signInAgain(account) {
  const game = globalThis.wenilla;
  if (!game) throw new Error('The world moved to another player. Go back to the launcher and join it again.');
  await game.waitFor((s) => s.session && s.session.state === 'login', 30000);
  await game.lua(`DefaultServerLogin(${JSON.stringify(account.user)}, ${JSON.stringify(account.pass)})`);
}

// Saves and stops what runs here, then starts the page afresh.
async function stop() {
  if (state.phase === 'idle') return snapshot();
  set({ busy: true });
  guest?.leave();
  if (server && server.ready) {
    if (host && host.players) {
      // The players in the world get it as it is now and are told this tab is leaving, so one of
      // them carries it on.
      await server.command('saveall').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
      await server.saveNow();
      await sendCopy(true);
    }
    await host?.stop();
    await new Promise((resolve) => {
      server.addEventListener('stopped', resolve, { once: true });
      server.stop();
      setTimeout(resolve, 8000);
    });
  } else host?.stop();
  location.reload();
  return snapshot();
}

async function deleteWorld(hex, confirmed) {
  if (confirmed !== true) throw new Error('not confirmed');
  if (state.world?.hex === hex) throw new Error('Stop playing this world first.');
  store.set('worlds', records().filter((w) => w.hex !== hex));
  if (/^[0-9a-f]{64}$/.test(hex)) {
    const root = await navigator.storage.getDirectory();
    let db = await root.getDirectoryHandle('db').catch(() => null);
    if (profile) db = await db?.getDirectoryHandle('p-' + profile).catch(() => null);
    await db?.removeEntry('w-' + hex, { recursive: true }).catch(() => {});
  }
  const worlds = listWorlds();
  set({ worlds });
  return worlds;
}

// ---- addons (lib/addons.js) ---------------------------------------------------------------------

const addonsModule = () => import('./lib/addons.js');
// After a change the running game gets the new files; it reads them at its next interface load.
async function applyAddons() {
  if (reader) await reader.setAddons(await addonFiles());
}
async function pickAddons(req = {}) {
  const { addAddons } = await addonsModule();
  let source = req.source || null;
  if (!source && req.kind === 'folder') {
    if (window.showDirectoryPicker) source = await window.showDirectoryPicker({ id: 'electrode-addon', mode: 'read' });
    else source = await pickWithInput($('addonFolderInput'));
  } else if (!source) {
    source = (await pickWithInput($('addonArchiveInput')))[0];
  }
  if (!source || (Array.isArray(source) && !source.length)) return (await addonsModule()).listAddons();
  const out = await addAddons(source);
  await applyAddons();
  return out;
}
function pickWithInput(input) {
  return new Promise((resolve) => {
    input.onchange = () => {
      const files = [...input.files];
      input.value = '';
      resolve(files);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}
async function reloadGameInterface() {
  if (state.phase !== 'playing') return false;
  await applyAddons();
  return (await addonsModule()).reloadGameInterface();
}

// What was dropped on the page: a game folder, or (on the AddOns tab) an addon folder or archive.
async function dropped(transfer, onAddons) {
  const item = [...(transfer.items || [])].find((i) => i.kind === 'file');
  const handle = item?.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
  const file = transfer.files[0];
  if (onAddons) return pickAddons({ source: handle && handle.kind === 'directory' ? handle : file });
  if (handle && handle.kind === 'directory') {
    try {
      await linkGameFolder(handle);
    } catch (e) {
      if (e.code !== 'unsupported') throw e;
      await useSessionFiles(handle);
    }
    return afterFolder();
  }
  throw new Error('Drop your game folder here, or use "Use my WoW folder…".');
}

// ---- the commands -----------------------------------------------------------------------------

const unavailable = (what) => command(async () => {
  throw new Error(`${what} is part of the desktop app; it is not in the browser version.`);
});

window.electrode = {
  state: async () => ({ state: snapshot(), logs: logs.slice(), update, version: VERSION }),
  pickFolder: command(pickFolder),
  play: command(() => enter(null)),
  acceptIpNotice: command(async () => {
    store.set('notice', true);
    set({ ipNoticeAccepted: true, gameFilesAccepted: true });
    countVisible();
    return snapshot();
  }),
  join: command((string) => enter(string)),
  choose: unavailable('Choosing between worlds of one name'),
  copyInvite: command(async () => {
    await navigator.clipboard.writeText(state.invite);
    return state.invite;
  }),
  admin: unavailable('The Admin panel'),
  stop: command(stop),
  characters: command(async () => []),
  openLogs: command(async () => {
    $('tabDashboard').click();
    $('log').scrollIntoView({ block: 'center' });
  }),
  addons: command(async () => (await addonsModule()).listAddons()),
  acceptAddonTerms: command(async () => (await addonsModule()).acceptAddonTerms()),
  setAddonEnabled: command(async (folder, on) => {
    const out = await (await addonsModule()).setAddonEnabled(folder, on);
    await applyAddons();
    return out;
  }),
  addAddons: command(pickAddons),
  removeAddon: command(async (folder) => {
    const out = await (await addonsModule()).removeAddon(folder);
    await applyAddons();
    return out;
  }),
  openAddons: unavailable('An AddOns folder on disk'),
  reloadGameInterface: command(reloadGameInterface),
  licenses: unavailable('This list'),
  openLicenses: command(async () => {
    window.open('licenses.html', '_blank', 'noopener');
  }),
  starOnGitLab: command(async () => {
    window.open(REGISTRY_REPO, '_blank', 'noopener');
  }),
  coreStats: command(async () => null),
  gameFilesInfo: command(async () => ({ archives: [] })),
  installGameFiles: unavailable('Installing a copy of the game files'),
  installInternetArchive: unavailable('Install Internet Archive'),
  cancelGameInstall: command(async () => snapshot()),
  useGameFolder: unavailable('Choosing a folder by its path'),
  pathForFile: () => null,
  dropped: command(dropped),
  worlds: command(async () => listWorlds()),
  permanentRefresh: command(() => refreshRegistry(true)),
  permanentVisible: command(async (hexes) => {
    visible = hexes || [];
    countVisible();
  }),
  permanentRequest: unavailable('Making a world permanent'),
  deleteWorld: command(deleteWorld),
  setNotifications: command(async () => snapshot()),
  updateCheck: command(async () => update),
  updateInstall: command(async () => {
    location.reload();
  }),
  updateNotes: command(async () => {
    window.open(REGISTRY_REPO, '_blank', 'noopener');
  }),
  onState: (fn) => listeners.state.push(fn),
  onLog: (fn) => listeners.log.push(fn),
  onUpdate: (fn) => listeners.update.push(fn),
  // For the console: electrode.debug.server.command('server info') runs a command in a world this tab runs.
  debug: {
    get server() { return server; },
    get host() { return host; },
    get guest() { return guest; },
    get session() { return session; },
    get standby() { return standby; },
    copyInfo: (hex) => copyInfo(hex, profile),
  },
};

// ---- the page's own controls (not part of the desktop launcher) --------------------------------

$('folderInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) useSessionFiles(files).then(afterFolder, (err) => log('error: ' + messageOf(err)));
});
$('toLauncher').addEventListener('click', () => document.body.classList.add('show-launcher'));
$('goneBack').addEventListener('click', () => location.reload());

// A tab can go away without warning: store the characters whenever it is hidden or left.
const saveNow = () => {
  if (server && server.ready) server.save();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});
window.addEventListener('pagehide', () => {
  saveNow();
  host?.stop(); // the players in this tab's world are told it is leaving: one of them carries the world on
});
// Others are playing in this tab's world: ask before it closes under them.
window.addEventListener('beforeunload', (e) => {
  if (host && host.players > 0) e.preventDefault();
});

// ---- start --------------------------------------------------------------------------------------

async function start() {
  const invited = query.get('world');
  if (invited) $('string').value = invited;
  const missing = [];
  if (!('serviceWorker' in navigator)) missing.push('service workers');
  if (!navigator.storage || !navigator.storage.getDirectory) missing.push('private file storage');
  if (typeof DecompressionStream !== 'function') missing.push('stream decompression');
  if (missing.length) {
    set({ blocked: `This browser lacks ${missing.join(', ')}, which the game and its world server need. A current Chrome or Edge on a desktop computer has them.` });
    return;
  }
  const sw = await startServiceWorker();
  if (sw.reloading) return;
  if (!sw.controlled || !sw.isolated) {
    set({ blocked: 'The page could not be isolated, which the game and its world server need for threads. Reload the page; a private window or a blocked service worker can cause this.' });
    return;
  }
  navigator.storage.persist?.().catch(() => {});
  set({ worlds: listWorlds() });
  refreshRegistry(false).catch((e) => log('permanent worlds: ' + messageOf(e)));
  if (await refreshFiles()) {
    data = await extractionStatus();
    showExtraction();
    startExtraction();
  }
}

// The launcher's own script, unchanged in what it does, runs once the commands above exist.
const launcher = document.createElement('script');
launcher.src = 'launcher.js';
launcher.onload = () => start().catch((e) => {
  console.error(e);
  set({ blocked: messageOf(e) });
});
document.body.appendChild(launcher);
