// Who a player is to the worlds they play in: an ECDSA P-256 key pair made in this browser and
// kept in IndexedDB. The private key cannot be exported. A host knows a player by the public key
// and gives the same account back to whoever proves they hold it.

const DB = 'electrode-identity';
const STORE = 'keys';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const text = (s) => new TextEncoder().encode(s);

export const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toHex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** The short name of a public key (its raw form, base64): 20 hex characters of its SHA-256. */
export async function fingerprint(publicKeyBase64) {
  return toHex(await crypto.subtle.digest('SHA-256', fromBase64(publicKeyBase64))).slice(0, 20);
}

/**
 * This browser's identity, made on first use. `profile` names a second identity in the same
 * browser (for trying two players on one computer).
 * Resolves with { publicKey (base64), id (fingerprint), sign(message) -> base64 }.
 */
export async function loadIdentity(profile = '') {
  const slot = 'identity' + (profile ? ':' + profile : '');
  let pair = await idb('readonly', (s) => s.get(slot));
  if (!pair) {
    pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
    await idb('readwrite', (s) => s.put(pair, slot));
  }
  const publicKey = toBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey,
    id: await fingerprint(publicKey),
    sign: async (message) => toBase64(await crypto.subtle.sign(SIGN, pair.privateKey, text(message))),
  };
}

/** Whether `signature` (base64) over `message` was made by the holder of `publicKeyBase64`. */
export async function verify(publicKeyBase64, signature, message) {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(publicKeyBase64), ALG, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, fromBase64(signature), text(message));
  } catch {
    return false;
  }
}
