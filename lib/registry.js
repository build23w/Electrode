// The official worlds: the worlds/ folder of the WoW Electrode repository on GitLab, the same list
// the desktop app shows under Servers. Each file is one world its founder made permanent, signed
// by the founder; nothing in it is trusted unsigned, so every file is checked here again:
// the genesis record's signature and world id, and the founder's signature over the whole entry.
//
// Read through GitLab's API (it allows requests from other sites). The last good list is kept in
// this browser, so the tab has something to show while GitLab is unreachable or limiting requests.

export const REGISTRY_REPO = 'https://gitlab.com/garydev00/wow-electrode';
const DIR = 'worlds';
const MAX_ENTRY_BYTES = 16 * 1024;
const STORE = 'electrode:registry';
const FRESH_MS = 10 * 60 * 1000;

const api = () => {
  const u = new URL(REGISTRY_REPO);
  return `${u.origin}/api/v4/projects/${encodeURIComponent(u.pathname.replace(/^\/|\/$/g, ''))}/repository`;
};
const isWorldFile = (name) => /^[0-9a-f]{64}\.json$/.test(name);

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));
const bytesToHex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const utf8 = (s) => new TextEncoder().encode(s);

/** Stable canonical JSON: sorted keys, no whitespace (the form that is hashed and signed). */
export function canonicalJson(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}

async function verifyEd25519(publicKeyHex, message, signatureHex) {
  const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), message);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A key as the app shows it: base32, the first 32 characters in groups of four. */
export function fingerprint(publicKeyHex) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of hexToBytes(publicKeyHex)) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.slice(0, 32).match(/.{4}/g).join(' ');
}

const canonName = (s) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Checks one entry; resolves with the world it describes, or throws why not. */
export async function verifyEntry(entry, fileName) {
  if (!entry || entry.v !== 1 || entry.t !== 'permanent-world') throw new Error('not a permanent-world entry (v 1)');
  const g = entry.genesis;
  if (!g || (g.v !== undefined && g.v !== 1) || !/^[0-9a-f]{64}$/.test(g.founder || '')) throw new Error('genesis: bad record');
  if (typeof g.string !== 'string' || canonName(g.string) !== g.string) throw new Error('genesis: string is not canonical');
  if (g.parent) throw new Error('a layer cannot be made permanent');
  const body = utf8(canonicalJson({ v: 1, t: 'genesis', string: g.string, founder: g.founder, created: g.created, nonce: g.nonce, ruleset: g.ruleset, parent: g.parent || null }));
  if (!(await verifyEd25519(g.founder, body, g.sig))) throw new Error('genesis: bad signature');
  const signed = new Uint8Array(body.length + 64);
  signed.set(body);
  signed.set(hexToBytes(g.sig), body.length);
  const worldHex = bytesToHex(await crypto.subtle.digest('SHA-256', signed));
  if (g.worldId && g.worldId !== worldHex) throw new Error('genesis: worldId mismatch');
  if (fileName !== `${worldHex}.json`) throw new Error(`the file must be named ${worldHex}.json`);
  const { sig, ...unsigned } = entry;
  if (typeof sig !== 'string' || !(await verifyEd25519(g.founder, utf8(canonicalJson(unsigned)), sig))) throw new Error("the entry is not signed by the world's founder");
  // The world's settings: its signed setting when the entry carries one for this world, else the genesis rules.
  const ruleset = entry.config && entry.config.world === worldHex && entry.config.ruleset ? entry.config.ruleset : g.ruleset;
  return { worldHex, string: g.string, founderHex: g.founder, created: g.created, ruleset: { ...ruleset }, description: typeof entry.description === 'string' ? entry.description.slice(0, 280) : '' };
}

/** Every file of the registry, [{ name, text }]: the valid worlds, one per name (the earliest founded wins). */
export async function verifyRegistry(files) {
  const ok = [];
  const errors = [];
  for (const f of files) {
    try {
      if (utf8(f.text).length > MAX_ENTRY_BYTES) throw new Error(`larger than ${MAX_ENTRY_BYTES} bytes`);
      ok.push(await verifyEntry(JSON.parse(f.text), f.name));
    } catch (e) {
      errors.push({ file: f.name, error: e.message });
    }
  }
  const byName = new Map();
  for (const w of ok.sort((a, b) => a.created.localeCompare(b.created) || a.worldHex.localeCompare(b.worldHex))) {
    if (byName.has(w.string)) errors.push({ file: `${w.worldHex}.json`, error: `"${w.string}" is already a permanent world` });
    else byName.set(w.string, w);
  }
  return { worlds: [...byName.values()], errors };
}

async function get(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch {
    throw new Error('could not reach GitLab');
  }
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after')) || 600;
    throw new Error(`GitLab is limiting requests from this network for ${Math.ceil(after / 60)} min`);
  }
  if (!res.ok) throw new Error(`GitLab did not serve the list (HTTP ${res.status})`);
  return res;
}

async function fetchFiles() {
  const listing = await (await get(`${api()}/tree?path=${DIR}&ref=main&per_page=100`)).json();
  const names = listing.filter((e) => e.type === 'blob' && isWorldFile(e.name)).map((e) => e.name);
  return Promise.all(names.map(async (name) => ({ name, text: await (await get(`${api()}/files/${encodeURIComponent(`${DIR}/${name}`)}/raw?ref=main`)).text() })));
}

function saved() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

/**
 * The official worlds. Resolves with { worlds, errors, error, fetchedAt }: `error` says why GitLab
 * could not be read this time (the worlds are then the list saved in this browser, if any).
 * `force` reads GitLab even when the saved list is recent.
 */
export async function loadRegistry({ force = false } = {}) {
  const kept = saved();
  let files = kept?.files || [];
  let fetchedAt = kept?.at || null;
  let error = null;
  if (force || !kept || Date.now() - kept.at > FRESH_MS) {
    try {
      files = await fetchFiles();
      fetchedAt = Date.now();
      try {
        localStorage.setItem(STORE, JSON.stringify({ at: fetchedAt, files }));
      } catch { /* not kept */ }
    } catch (e) {
      error = e.message;
    }
  }
  let checked;
  try {
    checked = await verifyRegistry(files);
  } catch (e) {
    // No Ed25519 in this browser's crypto: the list cannot be checked, so it is not shown.
    return { worlds: [], errors: [], error: `this browser cannot check the list's signatures (${e.message})`, fetchedAt };
  }
  return { ...checked, error, fetchedAt };
}
