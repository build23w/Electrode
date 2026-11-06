// A player's copy of a world it plays in: the characters and accounts as the host last saved them,
// kept in this browser in the same place and form a world that runs here keeps its own
// (db/w-<world id>/, see server-worker.js). If the host goes away, the world can be started here
// from it.

const text = (value) => new TextEncoder().encode(JSON.stringify(value));

// `store`: the same name the world server of this tab is started with (a second player's worlds
// in one browser are kept apart).
async function folder(worldHex, store, create) {
  const root = await navigator.storage.getDirectory();
  let db = await root.getDirectoryHandle('db', { create });
  if (store) db = await db.getDirectoryHandle('p-' + store, { create });
  return db.getDirectoryHandle('w-' + worldHex, { create });
}

async function readJson(dir, name) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  } catch {
    return null;
  }
}

async function write(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  await out.write(bytes);
  await out.close();
}

/** What this browser holds of a world: { seq, at } or null. */
export async function copyInfo(worldHex, store) {
  try {
    const state = await readJson(await folder(worldHex, store, false), 'state.json');
    return state && state.slot !== undefined ? { seq: state.seq || 0, at: state.savedAt || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the host's copy: { seq, at, names, files: { characters, realmd } }. The files go to the
 * slot that is not current, and state.json turns to it only once both are written.
 * Resolves { stored: true, seq, at }, or { stored: false, have } when this browser already holds a
 * later save of the world than the host runs: that one is not written over.
 */
let storing = Promise.resolve();
export function storeCopy(worldHex, copy, store) {
  storing = storing.catch(() => {}).then(async () => {
    const dir = await folder(worldHex, store, true);
    const state = (await readJson(dir, 'state.json')) || {};
    if (state.slot !== undefined && (state.seq || 0) > copy.seq) return { stored: false, have: state.seq };
    const slot = state.slot === 0 ? 1 : 0;
    await write(dir, `characters.${slot}.sqlite`, copy.files.characters);
    await write(dir, `realmd.${slot}.sqlite`, copy.files.realmd);
    // The account this browser used when it ran the world itself is not part of a copy.
    await write(dir, 'state.json', text({ slot, seq: copy.seq, savedAt: copy.at, names: copy.names || {} }));
    return { stored: true, seq: copy.seq, at: copy.at };
  });
  return storing;
}
