// Compares two folders file by file (SHA-256). Prints what is missing, extra or different.
//   node extract/test/compare-dirs.mjs <expected> <actual> [--hashes <file>]
// --hashes writes "sha256  relative/path" lines for <expected> (for comparing against a browser run).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const hi = args.indexOf('--hashes');
const hashesOut = hi >= 0 ? args.splice(hi, 2)[1] : null;
const [a, b] = args;

function walk(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const fa = walk(a).sort();
if (hashesOut) fs.writeFileSync(hashesOut, fa.map((f) => `${sha(path.join(a, f))}  ${f}`).join('\n') + '\n');
if (!b) {
  console.log(`${fa.length} files hashed`);
  process.exit(0);
}
const fb = new Set(walk(b));
let missing = 0, different = 0, same = 0, bytes = 0;
for (const f of fa) {
  if (!fb.has(f)) { if (++missing <= 10) console.log(`missing: ${f}`); continue; }
  fb.delete(f);
  const pa = path.join(a, f);
  if (sha(pa) === sha(path.join(b, f))) { same++; bytes += fs.statSync(pa).size; }
  else if (++different <= 10) console.log(`different: ${f}`);
}
let extra = 0;
for (const f of fb) if (++extra <= 10) console.log(`extra: ${f}`);
console.log(`${fa.length} expected files: ${same} identical (${(bytes / 1048576).toFixed(1)} MB), ${different} different, ${missing} missing, ${extra} extra`);
process.exit(different || missing || extra ? 1 : 0);
