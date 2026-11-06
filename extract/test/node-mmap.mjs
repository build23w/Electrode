// Runs the wasm movement-map generator under Node on real folders, to compare its tiles with a
// native build's. Not part of the site.
//
//   node extract/test/node-mmap.mjs <folder with movemapgen.js, config.json, offmesh.txt> <maps folder> <vmaps folder> <output folder> <job>...
//
// A job is  <map>:<x>:<y>  for one tile, the three numbers of its file name in file order
// (<map %03u><x %02d><y %02d>.mmtile), or  map:<id>  for a whole map with its header. Each job runs
// in a fresh copy of the tool, as on the page. Output goes to <output folder> (the mmaps folder).

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const [tools, maps, vmaps, out, ...jobs] = process.argv.slice(2);
if (!tools || !maps || !vmaps || !out || !jobs.length) {
  console.error('usage: node-mmap.mjs <tools folder> <maps folder> <vmaps folder> <output folder> <map>:<x>:<y> | map:<id> ...');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const { default: create } = await import(pathToFileURL(path.resolve(tools, 'movemapgen.js')).href);
const config = fs.readFileSync(path.join(tools, 'config.json'));
const offmesh = fs.readFileSync(path.join(tools, 'offmesh.txt'));

for (const job of jobs) {
  const lines = [];
  const M = await create({ print: (s) => lines.push(s), printErr: (s) => lines.push(s) });
  M.FS.mkdir('/work');
  for (const [name, root] of [['maps', maps], ['vmaps', vmaps], ['mmaps', out]]) {
    M.FS.mkdir('/work/' + name);
    M.FS.mount(M.NODEFS, { root: path.resolve(root) }, '/work/' + name);
  }
  M.FS.writeFile('/config.json', config);
  M.FS.writeFile('/offmesh.txt', offmesh);
  const args = ['--silent', '--configInputPath', '/config.json', '--offMeshInput', '/offmesh.txt', '--workdir', '/work/', '--threads', '1'];
  const whole = job.startsWith('map:');
  let expect = null;
  if (whole) args.push(job.slice(4));
  else {
    const [map, x, y] = job.split(':').map(Number);
    // The tool's --tile takes the second number of the file name first.
    args.push(String(map), '--tile', `${y},${x}`);
    expect = `${String(map).padStart(3, '0')}${String(x).padStart(2, '0')}${String(y).padStart(2, '0')}.mmtile`;
  }
  const before = new Set(fs.readdirSync(out));
  const t0 = performance.now();
  let code;
  try {
    code = M.callMain(args);
  } catch (e) {
    code = e && e.name === 'ExitStatus' ? e.status : (console.error(e), -1);
  }
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);
  const made = fs.readdirSync(out).filter((n) => !before.has(n));
  const ok = code === 0 && (whole ? made.length > 0 : fs.existsSync(path.join(out, expect)));
  console.log(`${job}: exit ${code}, ${seconds} s, memory ${(M.HEAPU8.length / 1048576).toFixed(0)} MB, ${whole ? `${made.length} new files` : expect + (ok ? '' : ' NOT written')}`);
  if (!ok) console.log(lines.filter((l) => /fail|error|unable|not exist|empty/i.test(l)).slice(0, 8).join('\n'));
}
