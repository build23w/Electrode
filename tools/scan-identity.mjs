#!/usr/bin/env node
// Finds the build machine's identity in files that are about to ship: the user's home path in any
// spelling (C:\Users\<user>, C:/Users/<user>, /home/<user>, /mnt/c/Users/<user>), "<user>@" and
// "@<host>" (accounts that installers name after the user and the machine), in 8-bit and UTF-16
// text. Compilers write source paths into what they build (panic locations, __FILE__, build ids),
// so every binary is read whole. tools/build-site.mjs runs this on the assembled site and refuses it on a hit.
//   node tools/scan-identity.mjs <dir or file>...   (exit 1 on any hit)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What identifies this build machine: the user name and host name as found in paths and accounts. */
export function identityNeedles({ user = os.userInfo().username, host = os.hostname() } = {}) {
  const u = user.toLowerCase();
  const texts = [`users\\${u}`, `users/${u}`, `/home/${u}`, `${u}@localhost`, `${u}@127.0.0.1`];
  // The host as an account's host part (root@host, 'root'@'host'); not bare, where it can be a word.
  const h = host?.toLowerCase();
  if (h && h !== 'localhost') texts.push(`@${h}`, `@'${h}'`, `@"${h}"`, `@\`${h}\``);
  // Matched without regard to case: Windows paths come in every casing.
  return texts.flatMap((t) => [{ text: t, bytes: Buffer.from(t, 'latin1') }, { text: `${t} (UTF-16)`, bytes: Buffer.from(t, 'utf16le') }]);
}

/** ASCII lowercase of a buffer (the needles are lowercase), without touching other bytes. */
function lower(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) { const c = buf[i]; out[i] = c >= 65 && c <= 90 ? c + 32 : c; }
  return out;
}

/** Every file under `roots` with the needles it contains: [{ file, hits: [{ text, count, sample }] }]. */
export function scanIdentity(roots, needles = identityNeedles()) {
  const found = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); return; }
    if (!st.isFile() || st.size === 0) return;
    const buf = lower(fs.readFileSync(p));
    const hits = [];
    for (const n of needles) {
      let count = 0, at = buf.indexOf(n.bytes), first = at;
      while (at >= 0) { count++; at = buf.indexOf(n.bytes, at + n.bytes.length); }
      if (count) {
        const raw = fs.readFileSync(p).subarray(Math.max(0, first - 40), first + n.bytes.length + 60);
        hits.push({ text: n.text, count, sample: raw.toString('latin1').replace(/[^\x20-\x7e]/g, '.') });
      }
    }
    if (hits.length) found.push({ file: p, hits });
  };
  for (const r of roots) walk(r);
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2);
  if (!roots.length) { console.error('usage: node tools/scan-identity.mjs <dir or file>...'); process.exit(2); }
  const found = scanIdentity(roots);
  for (const f of found) for (const h of f.hits) console.log(`${f.file}: ${h.count} × "${h.text}"  e.g. ${h.sample}`);
  console.log(found.length ? `${found.length} file(s) carry the build machine's identity` : 'clean: nothing of the build machine found');
  process.exit(found.length ? 1 : 0);
}
