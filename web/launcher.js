// The launcher's script: the desktop app's own (its src/renderer/app.js), with these changes for a
// browser tab: what is dropped on the page is handed over as it is (a page has no file paths), an
// invite link is this page's own, and
// a few sentences say "this browser" where the app says "this computer". bridge.js answers the
// window.electrode commands it calls.
const $ = (id) => document.getElementById(id);
const logEl = $('log');
let state = null;
const installing = (s) => !!(s?.gameImport && !['done', 'error', 'cancelled'].includes(s.gameImport.phase));
const filesReady = (s) => !!s.gameFolder && /^(verified build |names and sizes match)/.test(s.gameFolderStatus || '');

function appendLog(line) {
  logEl.textContent += line + '\n';
  if (logEl.textContent.length > 60000) logEl.textContent = logEl.textContent.slice(-40000);
  logEl.scrollTop = logEl.scrollHeight;
}

/** One line of the Launch readiness list: 'ok', 'busy', 'bad' or '' (not started), and a few words. */
function ready(id, cls, text) {
  const li = $(id);
  li.className = cls;
  li.lastElementChild.textContent = text;
  li.lastElementChild.title = text;
}
// What the graphics check found (at the end of this file), for the readiness list.
let gpu = { cls: 'busy', text: 'checking…' };

/** The readiness list: the same facts as the Dashboard's rows, each as one state. */
function renderReadiness(s) {
  ready('readyGpu', gpu.cls, gpu.text);
  ready('readyFiles', filesReady(s) ? 'ok' : installing(s) ? 'busy' : 'bad', filesReady(s) ? 'Ready' : installing(s) ? 'Installing…' : s.gameFolder ? 'Not verified' : 'Needed');
  const db = s.database || '';
  ready('readyDb', !db ? '' : /^(ready|this computer|remote)$/.test(db) ? 'ok' : 'busy', !db ? '—' : db === 'ready' ? 'Ready' : db === 'this computer' ? 'On this computer' : db === 'remote' ? "On the host" : db);
  const sv = s.servers || '';
  const up = sv === 'ready' || sv === 'hosting' || /^host .*\(tunnel\)$/.test(sv);
  ready('readyWorld', !sv || sv === 'stopped' ? '' : up ? 'ok' : 'busy', !sv || sv === 'stopped' ? '—' : sv === 'ready' ? 'Online' : sv === 'hosting' ? 'You host it' : up ? 'Through its host' : sv);
  const shared = !!(s.world || s.string);
  ready('readyPeers', !shared ? '' : s.peers > 0 ? 'ok' : 'busy', !shared ? (s.phase === 'playing' ? 'Solo' : '—') : s.peers > 0 ? `${s.peers} connected` : 'Looking…');
}

function render(s) {
  state = s;
  $('phase').textContent = s.phase + (s.error ? ` — ${s.error}` : '');
  // The arc in the top bar and the dot beside the phase: off, carrying current while something starts, steady in play.
  document.body.dataset.live = s.phase === 'playing' ? 'on' : s.phase === 'error' ? 'error' : s.phase === 'idle' || s.phase === 'choose' ? '' : 'busy';
  renderReadiness(s);
  $('folder').textContent = s.gameFolder || 'not chosen yet: add your game files above';
  $('folderStatus').textContent = s.gameFolderStatus || '';
  $('folderStatus').className = filesReady(s) ? 'ok' : 'bad';
  $('extraction').textContent = s.extraction || '—';
  $('database').textContent = s.database || '—';
  $('servers').textContent = s.servers || '—';
  $('peer').textContent = s.peer; $('account').textContent = s.account; $('bind').textContent = s.bind; $('level').textContent = s.myLevel; $('peers').textContent = s.peers;
  $('world').textContent = s.world ? `"${s.world.string}" · founder ${s.world.founder}${s.world.isFounder ? ' (you)' : ''} · created ${s.world.created.slice(0, 10)}` : (s.string ? `"${s.string}" — looking for peers…` : '—');
  $('invite').textContent = s.invite || '—';
  $('peersList').textContent = (s.peersList || []).length ? s.peersList.map((p) => `${p.account} level ${p.level}${p.online ? '' : ' (offline)'}`).join(' · ') : '—';
  $('copyInvite').classList.toggle('hidden', !s.invite);
  // The notice at the top: the IP note and the game files ownership, accepted together.
  const accepted = s.ipNoticeAccepted && s.gameFilesAccepted;
  $('ipNotice').classList.toggle('hidden', accepted);
  // The profile's ports could not be had at start (src/world/loopback.js): no world can start; say why.
  $('startupProblem').classList.toggle('hidden', !s.blocked);
  $('startupText').textContent = s.blocked || '';
  const inWorld = s.phase === 'playing' && !!s.world;
  $('join').disabled = s.busy || !filesReady(s) || !accepted || inWorld || !!s.blocked;
  $('join').title = inWorld ? `You are in "${s.world.string}": Stop first to join another world` : !accepted ? 'Read and accept the note at the top first' : '';
  $('play').disabled = s.busy || !filesReady(s) || (!s.gameFilesAccepted && s.phase !== 'playing') || !!s.blocked;
  $('play').title = !s.gameFilesAccepted && s.phase !== 'playing' ? 'Read and accept the note at the top first' : '';
  $('play').textContent = s.phase === 'playing' ? 'Back to the game' : installing(s) ? 'Installing files…' : s.busy ? 'Starting…' : 'Play solo';
  $('stop').disabled = s.busy || s.phase === 'idle';
  // The switch belongs to the native game window; the browser window (Linux) has its own bell.
  $('notifyRow').classList.toggle('hidden', !s.nativeGame);
  $('notifyToggle').textContent = s.notifications ? 'On' : 'Off';
  $('notifyToggle').setAttribute('aria-pressed', String(!!s.notifications));
  renderWorlds(s);
  renderPermanent(s);
  if (lists.tab === 'addons') renderAddons();
  renderSetup(s.setup);
  renderUpdate();
  // The game files card: until a game folder is in place and checked.
  const haveFiles = filesReady(s);
  $('gameFiles').classList.toggle('hidden', haveFiles && !(s.gameImport && s.gameImport.phase !== 'done'));
  const busyImport = installing(s);
  for (const id of ['gfUseFolder', 'gfArchive', 'gfFolder', 'pick']) $(id).disabled = busyImport || s.busy;
  for (const b of $('gfFound').querySelectorAll('button')) b.disabled = busyImport || s.busy;
  $('gfProgressWrap').classList.toggle('hidden', !busyImport);
  if (busyImport && !['starting', 'reading', 'cancelling'].includes(s.gameImport.phase)) $('gfProgress').value = s.gameImport.percent;
  else $('gfProgress').removeAttribute('value');
  $('gfCancel').disabled = s.gameImport?.phase === 'cancelling';
  $('gfStatus').textContent = s.gameImport ? (s.gameImport.phase === 'error' ? `Could not install: ${s.gameImport.text}` : `${busyImport ? 'Installing: ' : ''}${s.gameImport.text}`) : (s.gameFolder && !haveFiles ? `${s.gameFolder}: ${s.gameFolderStatus}` : '');
  $('gfStatus').className = s.gameImport && s.gameImport.phase === 'error' ? 'bad' : 'k';
  $('chooser').classList.toggle('hidden', s.phase !== 'choose');
  if (s.phase === 'choose') {
    $('candidates').innerHTML = '';
    for (const c of s.candidates) {
      const d = document.createElement('div');
      d.className = 'cand';
      d.innerHTML = `<div><b>${c.mine ? 'your world' : 'founder ' + c.founder}</b>${c.remembered ? ' · you played here before' : ''} · created ${c.created.slice(0, 10)} · ${c.peers} peer(s) online${c.host ? ' · has a host' : ''}</div><div class="k">XP ×${c.ruleset.xpKill}, drops ×${c.ruleset.dropItemNormal}, money ×${c.ruleset.dropMoney}, max level ${c.ruleset.maxPlayerLevel}</div>`;
      const b = document.createElement('button'); b.textContent = 'Join this one'; b.className = 'primary';
      b.onclick = () => window.electrode.choose(c.hex).then(show);
      d.appendChild(b);
      $('candidates').appendChild(d);
    }
  }
}

/** "45 s", "2 min 05 s". */
const dur = (sec) => (sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s`);

/** The loading bar while a world gets ready (session.js, setup-progress.js). */
function renderSetup(u) {
  $('setupCard').classList.toggle('hidden', !u);
  if (!u) return;
  const ready = u.label === 'Ready';
  const firstTime = u.steps.some((x) => x.id === 'terrain' || x.id === 'archives' || x.id === 'template');
  $('setupTitle').textContent = ready ? 'Ready' : firstTime ? 'Building your world for the first time' : 'Starting your world';
  $('setupBar').value = u.percent;
  $('setupPct').textContent = `${u.percent}%`;
  $('setupLabel').textContent = ready ? 'Opening the game…' : u.label;
  $('setupTime').textContent = ready ? '' : `${dur(u.elapsed)} · ${u.secondsLeft > 0 ? `about ${dur(u.secondsLeft)} left` : 'almost done'}`;
  $('setupNote').textContent = firstTime && !ready ? 'This happens once on this computer: maps from your game files and the world database. Later starts take seconds.' : '';
  const list = $('setupSteps');
  list.replaceChildren(...u.steps.map((x) => { const li = document.createElement('li'); li.className = x.state; li.textContent = x.label; return li; }));
}

// --- app updates (main/updater.js): the version, and a card while one downloads or waits --------
let update = null;
let restarting = false;
/** The version in the launcher's bottom-right corner: which build this player runs. */
function showVersion(v) { if (v) $('cornerVersion').textContent = `v${v}`; }
function renderUpdate(u = update) {
  update = u;
  if (!u) return;
  const cur = `v${u.current}`, next = u.version ? `v${u.version}` : '';
  $('appVersion').textContent = cur;
  showVersion(u.current);
  $('version').textContent = {
    off: `${cur} · ${u.why}`,
    idle: cur,
    checking: `${cur} · checking for updates…`,
    latest: `${cur} · up to date${u.checkedAt ? ` (checked ${ago(Date.parse(u.checkedAt))})` : ''}`,
    downloading: `${cur} · ${next} downloading, ${u.percent}%`,
    ready: `${cur} · ${next} is ready: it installs when you quit`,
    error: `${cur} · could not check for updates: ${u.error}`,
  }[u.phase] || cur;
  $('version').className = u.phase === 'error' ? 'bad' : u.phase === 'ready' ? 'ok' : '';
  $('updateCheck').classList.toggle('hidden', u.phase === 'off');
  $('updateCheck').disabled = u.phase === 'checking' || u.phase === 'downloading';
  $('updateCheck').textContent = u.phase === 'error' ? 'Try again' : 'Check for updates';
  // The card: while a new version downloads, and once it is ready.
  const shown = u.phase === 'downloading' || u.phase === 'ready';
  $('updateCard').classList.toggle('hidden', !shown);
  if (!shown) return;
  const ready = u.phase === 'ready';
  $('updateTitle').textContent = ready ? `WoW Electrode ${next} is ready` : `WoW Electrode ${next} is downloading`;
  $('updateFrom').textContent = `you have ${cur}`;
  $('updateBarWrap').classList.toggle('hidden', ready);
  $('updateBar').value = u.percent;
  $('updatePct').textContent = `${u.percent}%`;
  const hosting = (state?.worlds || []).some((w) => w.hosting);
  const playing = state?.phase === 'playing';
  $('updateText').textContent = !ready
    ? 'It downloads in the background, so you can keep playing. Once it is done you can restart into it, or it installs the next time you quit.'
    : hosting ? 'You host your world: Restart and update hands it to another player\'s copy first, as quitting does, then installs the update and opens the new version. Or keep playing: it installs when you quit.'
      : playing ? 'Restart and update closes the game, installs the update and opens the new version. Or keep playing: it installs when you quit.'
        : 'Restart and update installs it and opens the new version. Otherwise it installs the next time you quit.';
  $('updateInstall').classList.toggle('hidden', !ready);
  $('updateInstall').disabled = restarting;
  $('updateInstall').textContent = restarting ? 'Restarting…' : 'Restart and update';
}
$('updateCheck').onclick = () => window.electrode.updateCheck().then((r) => { if (r.ok === false) appendLog('error: ' + r.error); else renderUpdate(r.value); });
$('updateNotes').onclick = () => window.electrode.updateNotes().then((r) => { if (r.ok === false) appendLog('error: ' + r.error); });
$('updateInstall').onclick = () => {
  restarting = true;
  renderUpdate();
  window.electrode.updateInstall().then((r) => { if (r.ok === false) { restarting = false; appendLog('error: ' + r.error); renderUpdate(); } });
};

// --- the tabbed lists: Servers (permanent worlds) and My worlds ---------------------------------
const SERVERS_PAGE = 8, MINE_PAGE = 6;
const lists = { tab: 'servers', serversPage: 0, minePage: 0, visible: null, request: null };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** Prev / "page 2 of 5" / Next under a list; nothing when it all fits on one page. */
function renderPager(box, page, pages, go) {
  box.textContent = '';
  if (pages <= 1) return;
  const prev = el('button', '', 'Prev'), next = el('button', '', 'Next');
  prev.disabled = page === 0; next.disabled = page >= pages - 1;
  prev.onclick = () => go(page - 1); next.onclick = () => go(page + 1);
  box.append(prev, el('span', '', `page ${page + 1} of ${pages}`), next);
}

// The launcher's modules, one tab each; only the selected one is on the page.
const TABS = [['dashboard', 'tabDashboard', 'paneDashboard'], ['servers', 'tabServers', 'paneServers'], ['mine', 'tabMine', 'paneMine'], ['addons', 'tabAddons', 'paneAddons']];
function selectTab(tab) {
  lists.tab = tab;
  for (const [t, btn, pane] of TABS) {
    $(btn).setAttribute('aria-selected', String(t === tab));
    $(btn).tabIndex = t === tab ? 0 : -1;
    $(pane).classList.toggle('hidden', t !== tab);
  }
  try { localStorage.setItem('electrode.tab', tab); } catch { /* not kept */ }
  // The log grew while hidden: show its latest lines.
  if (tab === 'dashboard') logEl.scrollTop = logEl.scrollHeight;
  if (state) { renderPermanent(state); renderWorlds(state); }
  if (tab === 'addons') loadAddons();
}

/** Join for a listed world: "Open game" for the world being played, off while another one is open. */
function joinButton(s, worldHex, string, founderHex, label = 'Join') {
  const here = s.world?.hex === worldHex && s.phase === 'playing';
  const other = !here && s.phase === 'playing' && !!s.world;
  const b = el('button', 'primary', here ? 'Open game' : label);
  b.disabled = s.busy || !filesReady(s) || !(s.ipNoticeAccepted && s.gameFilesAccepted) || other || !!s.blocked;
  b.title = s.blocked ? 'The game cannot start on this computer right now: see the note at the top' : other ? `You are in "${s.world.string}": Stop first to join another world` : !(s.ipNoticeAccepted && s.gameFilesAccepted) ? 'Read and accept the note at the top first' : '';
  b.onclick = () => (here ? window.electrode.play() : window.electrode.join(string, { founderKey: founderHex })).then(show);
  return b;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

/**
 * Servers: the permanent-world list (main/permanent.js), searched and paged. Only the page on screen
 * gets its population read (DHT lookups per world), so a long list stays cheap.
 */
function renderPermanent(s) {
  const all = (s.permanent || []).slice().sort((a, b) => a.string.localeCompare(b.string));
  const q = $('serverSearch').value.trim().toLowerCase();
  const list = q ? all.filter((w) => w.string.includes(q) || (w.description || '').toLowerCase().includes(q)) : all;
  $('serversCount').textContent = all.length ? String(all.length) : '';
  const pages = Math.max(1, Math.ceil(list.length / SERVERS_PAGE));
  lists.serversPage = Math.min(lists.serversPage, pages - 1);
  const page = list.slice(lists.serversPage * SERVERS_PAGE, (lists.serversPage + 1) * SERVERS_PAGE);
  $('serversNote').textContent = s.permanentError && all.length ? `Not refreshed: ${s.permanentError}. Showing the list saved on this computer; it refreshes by itself.` : '';
  const box = $('permanentList');
  box.textContent = '';
  if (!page.length) {
    const d = el('div', 'k small', s.permanentError && !all.length ? `Could not load the list (${s.permanentError}). It tries again by itself.` : q ? `No server matches "${q}".` : 'No permanent worlds yet.');
    d.style.padding = '8px 0';
    box.appendChild(d);
  }
  for (const w of page) {
    const d = el('div', 'cand perm-row');
    const t = el('div');
    // A world is never shown as offline: its population now, 0 when nobody plays (whoever joins hosts it).
    const pop = el('span', `pop pop-${w.population || 'checking'}`, w.population || (s.ipNoticeAccepted ? 'checking…' : 'unknown'));
    pop.title = w.cap ? `${w.online ?? 0} of ${w.cap} players` : '';
    const players = w.population && w.cap ? `${w.online ?? 0}/${w.cap} players · ` : '';
    t.append(el('b', '', `"${w.string}" `), pop, el('div', 'k small', `${players}founder ${w.founder.slice(0, 9)}… · XP ×${w.rates.xpKill}, drops ×${w.rates.dropItemNormal}, money ×${w.rates.dropMoney}, max level ${w.rates.maxPlayerLevel}`));
    if (w.description) t.appendChild(el('div', 'desc', w.description));
    d.append(t, joinButton(s, w.hex, w.string, w.founderHex));
    box.appendChild(d);
  }
  renderPager($('serversPager'), lists.serversPage, pages, (p) => { lists.serversPage = p; renderPermanent(state); });
  // Tell the app which worlds are on screen (none while My worlds is open).
  const visible = (lists.tab === 'servers' ? page.map((w) => w.hex) : []).join();
  if (visible !== lists.visible) { lists.visible = visible; window.electrode.permanentVisible(visible ? visible.split(',') : []); }
}

/** A founder's permanency request, as its row shows it. */
function requestLine(w, r) {
  if (!r) return null;
  if (w.permanent && !r.update) return { cls: 'ok', text: 'Merged: listed under Servers.' };
  return { cls: 'k', text: `Merge request page opened ${ago(Date.parse(r.at))}. ${r.update ? 'Its file is updated once a maintainer merges it.' : 'It shows under Servers once a maintainer merges it.'}` };
}

/** My worlds: the worlds this client joined (each with a copy here), then other worlds it founded. */
function renderWorlds(s) {
  const worlds = s.worlds || [];
  $('worldsCount').textContent = `${worlds.filter((w) => w.joined).length} of 3`;
  $('mineCount').textContent = worlds.length ? String(worlds.length) : '';
  const pages = Math.max(1, Math.ceil(worlds.length / MINE_PAGE));
  lists.minePage = Math.min(lists.minePage, pages - 1);
  const box = $('worlds');
  box.textContent = '';
  if (!worlds.length) { const d = el('div', 'k small', 'You have not joined or founded a world yet.'); d.style.padding = '8px 0'; box.appendChild(d); }
  for (const w of worlds.slice(lists.minePage * MINE_PAGE, (lists.minePage + 1) * MINE_PAGE)) {
    const d = el('div', 'cand perm-row');
    const t = el('div');
    t.appendChild(el('b', '', `"${w.string}"`));
    if (w.permanent) t.appendChild(el('span', 'tag gold', 'permanent'));
    if (w.founder) t.appendChild(el('span', 'tag', 'founded by you'));
    t.appendChild(el('div', 'k small', w.joined
      ? `${w.hosting ? 'you host it' : w.playing ? 'playing' : 'not playing'} · copy: ${w.copy}`
      : `founded ${w.created.slice(0, 10)} · no copy on this computer`));
    const line = w.founder && requestLine(w, (s.permanentRequests || {})[w.hex]);
    if (line) t.appendChild(el('div', `req ${line.cls}`, line.text));
    const acts = el('div', 'acts');
    if (w.founder) {
      const p = el('button', '', w.permanent ? 'Update settings…' : 'Make permanent…');
      p.disabled = !!w.nameTaken;
      p.title = w.nameTaken ? `"${w.string}" is already another world's permanent name` : w.permanent ? "Open a merge request that updates its file with the world's current settings" : 'Open a merge request that lists this world under Servers for every player';
      p.onclick = () => openRequest(w);
      acts.appendChild(p);
    }
    acts.appendChild(joinButton(s, w.hex, w.string, w.founderHex, 'Play'));
    if (w.joined) {
      const del = el('button', '', 'Delete');
      del.disabled = w.playing;
      del.title = w.playing ? 'Stop playing this world first' : 'Remove this world, and its characters if it ran here, from this browser';
      // A second step, in the launcher, against a misclick (lists.confirmDelete survives re-renders).
      del.onclick = () => { lists.confirmDelete = w.hex; renderWorlds(state); };
      acts.appendChild(del);
    }
    d.append(t, acts);
    box.appendChild(d);
    if (lists.confirmDelete === w.hex) box.appendChild(deleteConfirm(w));
  }
  renderPager($('worldsPager'), lists.minePage, pages, (p) => { lists.minePage = p; renderWorlds(state); });
  if (lists.request && !worlds.some((w) => w.hex === lists.request.hex && w.founder)) closeRequest();
  if (lists.confirmDelete && !worlds.some((w) => w.hex === lists.confirmDelete && w.joined && !w.playing)) lists.confirmDelete = null;
}

/** The confirmation under a world's row before its copy is deleted. */
function deleteConfirm(w) {
  const box = el('div', 'confirm');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', `Delete "${w.string}"`);
  box.append(el('b', '', `Delete "${w.string}" from this browser?`),
    el('p', '', 'The world is taken off this list. If it ran in this browser, its characters and accounts are deleted with it, for good. You can join or start it again later by typing its name.'));
  const acts = el('div', 'confirm-acts');
  const yes = el('button', 'danger', 'Delete');
  const no = el('button', '', 'Cancel');
  no.onclick = () => { lists.confirmDelete = null; renderWorlds(state); };
  yes.onclick = () => {
    yes.disabled = no.disabled = true;
    window.electrode.deleteWorld(w.hex, true).then((r) => {
      lists.confirmDelete = null;
      if (r.ok === false) appendLog('error: ' + r.error); else renderWorlds({ ...state, worlds: r.value });
    });
  };
  acts.append(yes, no);
  box.appendChild(acts);
  setTimeout(() => no.focus(), 0);
  return box;
}

// --- the AddOns tab: the game's addons, turned on and off here only (src/world/addons.js) --------
const ADDONS_PAGE = 8;
const addonsView = { list: null, page: 0, confirm: null, note: '', bad: false, showTerms: false };
// The licensing notice gates the tab: nothing can be added, switched or removed before it is accepted.
const termsAccepted = () => !!addonsView.list?.termsAccepted;
const TERMS_FIRST = 'Accept the addon licensing notice above first.';
const applyHint = () => (state?.phase === 'playing' ? '. Reload the game interface to apply it now.' : '. It applies the next time the game opens.');

function setAddons(r, note) {
  if (r.ok === false) Object.assign(addonsView, { note: r.error, bad: true });
  else { addonsView.list = r.value; if (note !== undefined) Object.assign(addonsView, { note, bad: false }); }
  renderAddons();
}
function loadAddons() { window.electrode.addons().then((r) => setAddons(r)); }
function addAddons(req) {
  Object.assign(addonsView, { note: 'Adding…', bad: false });
  renderAddons();
  window.electrode.addAddons(req).then((r) => setAddons(r, r.ok && r.value.added ? `Added ${r.value.added.join(', ')}${applyHint()}` : ''));
}

function renderAddons() {
  const all = addonsView.list?.addons || [];
  $('addonsCount').textContent = all.length ? String(all.length) : '';
  const q = $('addonSearch').value.trim().toLowerCase();
  const shown = q ? all.filter((a) => `${a.title} ${a.folder} ${a.notes} ${a.author}`.toLowerCase().includes(q)) : all;
  const pages = Math.max(1, Math.ceil(shown.length / ADDONS_PAGE));
  addonsView.page = Math.min(addonsView.page, pages - 1);
  const box = $('addonList');
  box.textContent = '';
  if (addonsView.list && !shown.length) { const d = el('div', 'k small', q ? 'No addon matches.' : 'No addons yet: add a folder or an archive.'); d.style.padding = '8px 0'; box.appendChild(d); }
  for (const a of shown.slice(addonsView.page * ADDONS_PAGE, (addonsView.page + 1) * ADDONS_PAGE)) {
    const d = el('div', `cand perm-row${a.enabled ? '' : ' addon-off'}`);
    const t = el('div');
    t.appendChild(el('b', '', a.title));
    if (a.version && !a.title.includes(a.version)) t.appendChild(el('span', 'tag', /^v/i.test(a.version) ? a.version : `v${a.version}`));
    t.appendChild(a.source === 'shipped' ? el('span', 'tag gold', 'comes with the game') : el('span', 'tag', a.replacesShipped ? 'yours, replaces the one that comes with the game' : 'yours'));
    if (a.interface && a.interface !== '11200') {
      const tag = el('span', 'tag bad', `made for ${a.interface}`);
      tag.title = 'This addon names another game version than 1.12 (11200): the game may skip it, or it may not work.';
      t.appendChild(tag);
    }
    t.appendChild(el('div', 'desc', [a.notes, a.author && `by ${a.author}`, `folder ${a.folder}`].filter(Boolean).join(' · ')));
    const acts = el('div', 'acts');
    const tog = el('button', 'toggle', a.enabled ? 'On' : 'Off');
    tog.setAttribute('aria-pressed', String(a.enabled));
    tog.setAttribute('aria-label', `${a.title}: ${a.enabled ? 'on' : 'off'}`);
    tog.title = !termsAccepted() ? TERMS_FIRST : a.enabled ? 'The game loads it. Click to turn it off.' : 'The game does not load it. Click to turn it on.';
    tog.disabled = !termsAccepted();
    tog.onclick = () => { tog.disabled = true; window.electrode.setAddonEnabled(a.folder, !a.enabled).then((r) => setAddons(r, `${a.title} turned ${a.enabled ? 'off' : 'on'}${applyHint()}`)); };
    acts.appendChild(tog);
    if (a.source === 'yours') {
      const confirming = addonsView.confirm === a.folder;
      const rm = el('button', '', confirming ? 'Confirm remove' : 'Remove');
      rm.title = termsAccepted() ? 'Removes this addon from this browser' : TERMS_FIRST;
      rm.disabled = !termsAccepted();
      rm.onclick = () => {
        if (!confirming) { addonsView.confirm = a.folder; renderAddons(); return; }
        addonsView.confirm = null;
        window.electrode.removeAddon(a.folder).then((r) => setAddons(r, `${a.title} removed${applyHint()}`));
      };
      acts.appendChild(rm);
    }
    d.append(t, acts);
    box.appendChild(d);
  }
  renderPager($('addonsPager'), addonsView.page, pages, (p) => { addonsView.page = p; renderAddons(); });
  $('addonsNote').textContent = addonsView.note;
  $('addonsNote').className = `small ${addonsView.bad ? 'bad' : 'k'}`;
  const accepted = termsAccepted();
  $('addonTerms').classList.toggle('hidden', accepted && !addonsView.showTerms);
  $('addonTermsActs').classList.toggle('hidden', accepted);
  $('addonTermsDone').classList.toggle('hidden', !accepted);
  if (accepted) {
    $('addonTermsDate').textContent = new Date(addonsView.list.termsAccepted).toLocaleDateString();
    $('addonTermsShow').textContent = addonsView.showTerms ? 'Hide it' : 'Read it again';
  }
  for (const id of ['addonSearch', 'addonAddFolder', 'addonAddArchive', 'addonOpenFolder']) { $(id).disabled = !accepted; $(id).title = accepted ? '' : TERMS_FIRST; }
  $('addonDrop').textContent = accepted ? 'or drop an addon folder or a .zip of one on this tab' : 'Accept the notice above to add addons.';
  $('addonReload').disabled = !accepted || state?.phase !== 'playing';
}
$('addonSearch').oninput = () => { addonsView.page = 0; renderAddons(); };
$('addonAddFolder').onclick = () => addAddons({ kind: 'folder' });
$('addonAddArchive').onclick = () => addAddons({ kind: 'archive' });
$('addonOpenFolder').onclick = () => window.electrode.openAddons();
$('addonLicenses').onclick = () => window.electrode.openLicenses();
$('addonAccept').onclick = () => { $('addonAccept').disabled = true; window.electrode.acceptAddonTerms().then((r) => setAddons(r, r.ok ? 'Accepted. You can add addons, turn them on or off, and remove them.' : undefined)).finally(() => { $('addonAccept').disabled = false; }); };
$('addonTermsShow').onclick = () => { addonsView.showTerms = !addonsView.showTerms; renderAddons(); };
$('addonReload').onclick = () => window.electrode.reloadGameInterface().then((r) => {
  Object.assign(addonsView, r.ok === false ? { note: r.error, bad: true } : { note: r.value ? 'The game interface reloaded with the addons that are on.' : 'Enter the world in the game window first: the addons load with it.', bad: false });
  renderAddons();
});

// --- permanency requests: a merge request on GitLab, opened pre-loaded with the signed file ------
function openRequest(w) {
  lists.request = { hex: w.hex };
  $('permTitle').textContent = w.permanent ? `Send the current settings of "${w.string}"` : `Make "${w.string}" permanent`;
  $('permText').textContent = (w.permanent
    ? "Opens a merge request on GitLab that updates the world's file in the WoW Electrode repository with its current settings, admins and the description below, signed with your key."
    : "Opens a merge request on GitLab with the world's file, signed with your key: its name, founder, admins, settings and the description below. Sign in to GitLab (a free account), click Commit changes, then Create merge request. CI checks the file and a maintainer merges it; then the world shows under Servers for every player and its name always means this world.")
    + ' Everything in the file becomes public, so keep personal details out of the description.';
  $('permSend').textContent = 'Open merge request';
  $('permStatus').textContent = ''; $('permStatus').className = 'k small';
  $('permForm').classList.remove('hidden');
  $('permDesc').focus();
}
function closeRequest() { lists.request = null; $('permForm').classList.add('hidden'); }

$('permSend').onclick = async () => {
  const req = lists.request;
  if (!req) return;
  $('permSend').disabled = true;
  try {
    const r = await window.electrode.permanentRequest(req.hex, $('permDesc').value);
    if (r.ok === false) { $('permStatus').className = 'bad small'; $('permStatus').textContent = r.error; return; }
    $('permStatus').className = 'ok small';
    $('permStatus').textContent = r.value.prefilled
      ? 'GitLab is open in your browser with the file and its commit message filled in (the file is on your clipboard too). Commit it there, then create the merge request.'
      : 'GitLab is open in your browser and the file is on your clipboard: paste it into the empty file, commit, then create the merge request.';
  } finally { $('permSend').disabled = false; }
};
$('permCancel').onclick = closeRequest;
for (const [t, btn] of TABS) {
  $(btn).onclick = () => selectTab(t);
  $(btn).onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.findIndex(([x]) => x === lists.tab);
    const [next, nextBtn] = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next); $(nextBtn).focus();
  };
}
$('serverSearch').oninput = () => { lists.serversPage = 0; if (state) renderPermanent(state); };

async function refreshFound() {
  const r = await window.electrode.gameFilesInfo();
  const box = $('gfFound');
  box.textContent = '';
  if (!r.ok || !r.value.archives.length) return;
  for (const a of r.value.archives) {
    const d = document.createElement('div');
    d.className = 'cand found-row';
    const t = document.createElement('span'); t.textContent = `Found ${a.name} (${(a.bytes / 1e9).toFixed(1)} GB)`;
    const b = document.createElement('button'); b.textContent = 'Install this';
    b.disabled = installing(state) || !!state?.busy;
    b.onclick = () => window.electrode.installGameFiles({ path: a.path }).then(show);
    d.append(t, b); box.appendChild(d);
  }
}

const show = (r) => { if (!r) return; if (r.ok === false) appendLog('error: ' + r.error); else if (r.value && r.value.phase) render(r.value); };

function parseInvite(text) {
  const t = text.trim();
  // An invite link carries the string in its address (this page's links as ?world=, the app's as ?s=).
  try {
    const u = new URL(t);
    const string = u.searchParams.get('world') || u.searchParams.get('s');
    if (string) return { string };
  } catch { /* not a link: a plain string */ }
  return { string: t };
}

// The client draws with WebGPU (DirectX 12 underneath on Windows, Vulkan on Linux): ask it here, the
// same way the game page does.
(async () => {
  const linux = /linux/i.test(navigator.platform);
  let text = 'WebGPU ready';
  let ok = true;
  try {
    if (!navigator.gpu) { ok = false; text = 'no WebGPU on this computer'; }
    else {
      const a = await navigator.gpu.requestAdapter();
      if (!a) { ok = false; text = 'no graphics adapter supports WebGPU'; }
      // A CPU stand-in (no usable GPU driver): the game starts but runs far too slowly to play.
      else if (a.isFallbackAdapter || a.info?.architecture === 'swiftshader') { ok = false; text = 'only software rendering (no graphics driver for WebGPU)'; }
      else if (a.info && a.info.vendor) text = `WebGPU ready (${a.info.vendor}${a.info.architecture ? ' ' + a.info.architecture : ''})`;
    }
  } catch (e) { ok = false; text = `WebGPU failed: ${e.message}`; }
  if (!ok) text += linux
    ? ': use a browser with WebGPU, and install or update the graphics driver (Vulkan: Mesa for AMD and Intel, the NVIDIA driver for NVIDIA); the game cannot be drawn without it'
    : ': use a browser with WebGPU (a current Chrome or Edge), and update the graphics driver; the game cannot be drawn without it';
  $('gpu').textContent = text;
  $('gpu').className = 'v ' + (ok ? 'ok' : 'bad');
  gpu = { cls: ok ? 'ok' : 'bad', text: ok ? 'Ready' : 'Cannot draw the game' };
  if (state) renderReadiness(state);
})();

window.electrode.onState(render);
window.electrode.onLog(appendLog);
window.electrode.onUpdate(renderUpdate);
$('acceptNotice').onclick = () => window.electrode.acceptIpNotice().then(show);
$('join').onclick = () => { const { string, founderKey, peers } = parseInvite($('string').value); if (string) window.electrode.join(string, { founderKey, peers }).then(show); };
$('string').onkeydown = (e) => { if (e.key === 'Enter') $('join').click(); };
$('play').onclick = () => window.electrode.play().then(show);
$('pick').onclick = () => window.electrode.pickFolder().then(show);
$('stop').onclick = () => window.electrode.stop().then(show);
$('notifyToggle').onclick = () => window.electrode.setNotifications(!(state && state.notifications)).then(show);
$('logs').onclick = () => window.electrode.openLogs();
$('licenses').onclick = () => window.electrode.openLicenses();
$('star').onclick = () => window.electrode.starOnGitLab();
$('gfUseFolder').onclick = () => window.electrode.pickFolder().then(show);
$('gfArchive').onclick = () => window.electrode.installInternetArchive().then(show);
$('gfFolder').onclick = () => window.electrode.installGameFiles({ kind: 'folder' }).then(show);
$('gfCancel').onclick = () => window.electrode.cancelGameInstall().then(show);
// Drop a WoW folder (used in place) or an archive (installed) anywhere on the window.
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (!e.dataTransfer.files.length) return;
  // On the AddOns tab a drop is an addon to add.
  if (lists.tab === 'addons') {
    if (!termsAccepted()) { Object.assign(addonsView, { note: TERMS_FIRST, bad: true }); renderAddons(); return; }
    Object.assign(addonsView, { note: 'Adding…', bad: false });
    renderAddons();
    window.electrode.dropped(e.dataTransfer, true).then((r) => setAddons(r, r.ok && r.value.added ? `Added ${r.value.added.join(', ')}${applyHint()}` : ''));
    return;
  }
  if (installing(state) || state?.busy) return;
  window.electrode.dropped(e.dataTransfer, false).then(show);
});
refreshFound();
$('copyInvite').onclick = () => window.electrode.copyInvite().then((r) => appendLog(r.ok ? 'invite link copied: ' + r.value : 'error: ' + r.error));
$('permRefresh').onclick = () => { $('permRefresh').disabled = true; window.electrode.permanentRefresh().then((r) => { if (r.ok === false) appendLog('error: ' + r.error); }).finally(() => { $('permRefresh').disabled = false; }); };
let savedTab = null;
try { savedTab = localStorage.getItem('electrode.tab'); } catch { /* not kept */ }
selectTab(TABS.some(([t]) => t === savedTab) ? savedTab : 'dashboard');
window.electrode.state().then(({ state: s, logs, update: u, version }) => { showVersion(version); render(s); renderUpdate(u); for (const l of logs) appendLog(l); });
