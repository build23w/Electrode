// The slow work on the chosen archives, off the page's thread: copying them into the browser's
// private storage (OPFS; synchronous file handles exist only in a worker and are the fast way
// to write), and the SHA-256 check of files that are read in place.
//
// in:  { type: 'import', dir, stampName, stamp, entries: [{ name, size, expected, sha256, file | url }], verify, force }
//      { type: 'verify', entries: [{ name, size, sha256, file }] }
// out: { type: 'progress', phase, name, bytes, total }, { type: 'done', files, stamp }, { type: 'error', code, message }

'use strict';

const CHUNK = 8 << 20;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// SHA-256 over a stream of chunks (the browser's own digest wants the whole file in memory).
class Sha256 {
  constructor() {
    this.h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Int32Array(64);
    this.buf = new Uint8Array(64);
    this.fill = 0;
    this.length = 0;
  }

  update(data) {
    let i = 0;
    const n = data.length;
    this.length += n;
    if (this.fill) {
      while (i < n && this.fill < 64) this.buf[this.fill++] = data[i++];
      if (this.fill < 64) return;
      this.block(this.buf, 0);
      this.fill = 0;
    }
    for (; i + 64 <= n; i += 64) this.block(data, i);
    while (i < n) this.buf[this.fill++] = data[i++];
  }

  block(p, o) {
    const w = this.w;
    const h = this.h;
    for (let t = 0; t < 16; t++, o += 4) w[t] = (p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3];
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  hex() {
    const bits = this.length * 8;
    const tail = new Uint8Array(((this.fill + 9 + 63) & ~63) - this.fill);
    tail[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const end = tail.length;
    tail[end - 8] = hi >>> 24; tail[end - 7] = hi >>> 16; tail[end - 6] = hi >>> 8; tail[end - 5] = hi;
    tail[end - 4] = lo >>> 24; tail[end - 3] = lo >>> 16; tail[end - 2] = lo >>> 8; tail[end - 1] = lo;
    const length = this.length;
    this.update(tail);
    this.length = length;
    let out = '';
    for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, '0');
    return out;
  }
}

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function* chunksOf(entry) {
  if (entry.file) {
    for (let at = 0; at < entry.file.size; at += CHUNK) {
      yield new Uint8Array(await entry.file.slice(at, at + CHUNK).arrayBuffer());
    }
    return;
  }
  const response = await fetch(entry.url);
  if (!response.ok || !response.body) throw new ImportError('copy', `${entry.name}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

async function run(job) {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(job.dir, { create: true });
  // The set is not complete while it changes: the stamp goes first and comes back last.
  try {
    await folder.removeEntry(job.stampName);
  } catch (e) {
    /* no earlier import */
  }

  const total = job.entries.reduce((sum, e) => sum + e.size, 0);
  let bytes = 0;
  let lastPost = 0;
  const progress = (phase, name, forced) => {
    const now = performance.now();
    if (!forced && now - lastPost < 100) return;
    lastPost = now;
    postMessage({ type: 'progress', phase, name, bytes, total });
  };

  const files = [];
  for (const entry of job.entries) {
    const handle = await folder.getFileHandle(entry.name, { create: true });
    if (typeof handle.createSyncAccessHandle !== 'function') throw new ImportError('unsupported', 'This browser has no synchronous file handles.');
    const access = await handle.createSyncAccessHandle();
    let digest = null;
    try {
      const hasher = job.verify ? new Sha256() : null;
      if (!job.force && access.getSize() === entry.size) {
        // Already here from an earlier import; read it back only when asked to check it.
        if (hasher) {
          const buf = new Uint8Array(CHUNK);
          for (let at = 0; at < entry.size; ) {
            const n = access.read(buf, { at });
            if (n <= 0) throw new ImportError('copy', `${entry.name}: read stopped at ${at}`);
            hasher.update(n === buf.length ? buf : buf.subarray(0, n));
            at += n;
            bytes += n;
            progress('verify', entry.name);
          }
        } else {
          bytes += entry.size;
        }
      } else {
        access.truncate(0);
        let at = 0;
        for await (const chunk of chunksOf(entry)) {
          let written = 0;
          while (written < chunk.length) {
            const n = access.write(written ? chunk.subarray(written) : chunk, { at: at + written });
            if (n <= 0) throw new ImportError('quota', `${entry.name}: the browser stopped the write at ${at + written} bytes (storage full?)`);
            written += n;
          }
          if (hasher) hasher.update(chunk);
          at += chunk.length;
          bytes += chunk.length;
          progress('copy', entry.name);
        }
        access.flush();
        if (at !== entry.size) {
          access.truncate(0);
          throw new ImportError('copy', `${entry.name}: copied ${at} bytes, expected ${entry.size}`);
        }
      }
      if (hasher) {
        digest = hasher.hex();
        if (entry.sha256 && digest !== entry.sha256) {
          access.truncate(0);
          throw new ImportError('verify', `${entry.name}: SHA-256 ${digest.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…`);
        }
      }
    } finally {
      access.close();
    }
    files.push(digest ? { name: entry.name, size: entry.size, sha256: digest } : { name: entry.name, size: entry.size });
    progress('copy', entry.name, true);
  }

  const stamp = { ...job.stamp, importedAt: new Date().toISOString(), verified: Boolean(job.verify), files };
  const stampHandle = await (await folder.getFileHandle(job.stampName, { create: true })).createSyncAccessHandle();
  try {
    stampHandle.truncate(0);
    stampHandle.write(new TextEncoder().encode(JSON.stringify(stamp)), { at: 0 });
    stampHandle.flush();
  } finally {
    stampHandle.close();
  }
  postMessage({ type: 'done', files, stamp });
}

// Hash each file where it is and compare with the expected sums. Nothing is written.
async function verify(job) {
  const total = job.entries.reduce((sum, e) => sum + e.size, 0);
  let bytes = 0;
  let lastPost = 0;
  const files = [];
  for (const entry of job.entries) {
    const hasher = new Sha256();
    for await (const chunk of chunksOf(entry)) {
      hasher.update(chunk);
      bytes += chunk.length;
      const now = performance.now();
      if (now - lastPost >= 100) {
        lastPost = now;
        postMessage({ type: 'progress', phase: 'verify', name: entry.name, bytes, total });
      }
    }
    const digest = hasher.hex();
    if (entry.sha256 && digest !== entry.sha256) {
      throw new ImportError('verify', `${entry.name}: SHA-256 ${digest.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…`);
    }
    files.push({ name: entry.name, size: entry.size, sha256: digest });
  }
  postMessage({ type: 'progress', phase: 'verify', name: '', bytes, total });
  postMessage({ type: 'done', files, stamp: null });
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof importScripts === 'function') {
  self.onmessage = (event) => {
    const job = event.data;
    if (!job || (job.type !== 'import' && job.type !== 'verify')) return;
    (job.type === 'verify' ? verify(job) : run(job)).catch((e) => {
      const quota = e && e.name === 'QuotaExceededError';
      postMessage({ type: 'error', code: quota ? 'quota' : e.code || 'copy', message: quota ? 'The browser ran out of storage for this site.' : String(e && e.message ? e.message : e) });
    });
  };
}

if (typeof module === 'object' && module && module.exports) module.exports = { Sha256 };
