// Local development server. Serves the site the way a static host does: plain files, no special
// headers, under a base path (a project site lives below the origin's root, while the game client
// asks for /data and /ws at the root, so the base path matters).
//
//   node tools/dev-server.mjs [--port 8430] [--base /Electrode/] [--built <dir>] [--testfiles <dir>]
//
// --built      a second folder looked up after web/ (compiled files: client, server, extractors, databases)
// --testfiles  a folder served at /__testfiles/ so a test page can copy game archives into the
//              browser's storage without a folder picker. Development only; never part of the site.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(opt('port', process.env.PORT || 8430));
let base = opt('base', '/Electrode/');
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';
const roots = [path.resolve(here, '..', 'web')];
const built = opt('built', process.env.ELECTRODE_WEB_BUILT || '');
if (built) roots.push(path.resolve(built));
const testfiles = opt('testfiles', process.env.ELECTRODE_WEB_TESTFILES || '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function inside(root, rel) {
  const full = path.resolve(root, '.' + path.sep + rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

function send(req, res, file, stat) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, stat.size - Number(range[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

function lookup(rootList, rel) {
  for (const root of rootList) {
    const full = inside(root, rel);
    if (!full) continue;
    try {
      let stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const index = path.join(full, 'index.html');
        stat = fs.statSync(index);
        return { file: index, stat };
      }
      return { file: full, stat };
    } catch {
      /* next root */
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/') {
    res.writeHead(302, { Location: base });
    return res.end();
  }
  if (testfiles && pathname.startsWith('/__testfiles/')) {
    const rel = pathname.slice('/__testfiles/'.length);
    if (rel === '') {
      const names = fs.readdirSync(testfiles).filter((n) => fs.statSync(path.join(testfiles, n)).isFile());
      const body = JSON.stringify(names.map((n) => ({ name: n, size: fs.statSync(path.join(testfiles, n)).size })));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      return res.end(body);
    }
    const hit = lookup([path.resolve(testfiles)], rel);
    if (hit) return send(req, res, hit.file, hit.stat);
    res.writeHead(404);
    return res.end();
  }
  if (!pathname.startsWith(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  const hit = lookup(roots, pathname.slice(base.length));
  if (hit) return send(req, res, hit.file, hit.stat);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// ---- a local tracker, for trying two players without the public ones ---------------------------
// ws://localhost:<port>/__tracker speaks the WebTorrent tracker's announce messages: it passes
// offers to other peers of a topic and answers back. Development only.

const swarms = new Map(); // info_hash -> Map(peer_id -> send)

function trackerMessage(send, text, onGone) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (m.action !== 'announce' || typeof m.info_hash !== 'string' || typeof m.peer_id !== 'string') return;
  const swarm = swarms.get(m.info_hash) || swarms.set(m.info_hash, new Map()).get(m.info_hash);
  if (m.event === 'stopped') {
    swarm.delete(m.peer_id);
    return;
  }
  if (!swarm.has(m.peer_id)) onGone(() => swarm.delete(m.peer_id));
  swarm.set(m.peer_id, send);
  if (m.answer && m.to_peer_id) {
    swarm.get(m.to_peer_id)?.(JSON.stringify({ action: 'announce', info_hash: m.info_hash, peer_id: m.peer_id, offer_id: m.offer_id, answer: m.answer }));
    return;
  }
  send(JSON.stringify({ action: 'announce', info_hash: m.info_hash, interval: 60, complete: 0, incomplete: swarm.size }));
  const others = [...swarm.entries()].filter(([id]) => id !== m.peer_id);
  (m.offers || []).slice(0, others.length).forEach((o, i) => {
    others[i][1](JSON.stringify({ action: 'announce', info_hash: m.info_hash, peer_id: m.peer_id, offer_id: o.offer_id, offer: o.offer }));
  });
}

server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] !== '/__tracker' || !req.headers['sec-websocket-key']) return socket.destroy();
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const CRLF = String.fromCharCode(13, 10);
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join(CRLF));
  const cleanups = [];
  const send = (text) => {
    const body = Buffer.from(text);
    const head = body.length < 126 ? Buffer.from([0x81, body.length])
      : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
        : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); return b; })()]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, body]));
  };
  let buffered = Buffer.alloc(0);
  let parts = [];
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const fin = buffered[0] & 0x80;
      const opcode = buffered[0] & 0x0f;
      const masked = buffered[1] & 0x80;
      let length = buffered[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        at = 10;
      }
      const need = at + (masked ? 4 : 0) + length;
      if (buffered.length < need) return;
      const mask = masked ? buffered.subarray(at, at + 4) : null;
      const payload = Buffer.from(buffered.subarray(at + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffered = buffered.subarray(need);
      if (opcode === 8) return socket.end();
      if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 1 || opcode === 0) {
        parts.push(payload);
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          trackerMessage(send, text, (fn) => cleanups.push(fn));
        }
      }
    }
  });
  const gone = () => cleanups.splice(0).forEach((fn) => fn());
  socket.on('close', gone);
  socket.on('error', gone);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${roots.join(' + ')} at http://localhost:${port}${base}`);
  if (testfiles) console.log(`test archives from ${testfiles} at /__testfiles/`);
});
