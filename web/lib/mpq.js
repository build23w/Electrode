// Read-only MPQ reader for the 1.12.1 archive set, and the patch chain over it.
//
// A classic script (service worker: importScripts) that also loads in Node (tests). It mirrors
// the native client's reader: format V1 headers, files stored whole or in zlib sectors, no
// encrypted or single-unit files. Anything else is an error, never a guess.
//
// A source is { name, size, read(offset, length) -> Promise<Uint8Array> } and must return exactly
// `length` bytes or throw.

(function (root) {
  'use strict';

  const SIGNATURE = 0x1a51504d; // "MPQ\x1A"
  const USERDATA_SIGNATURE = 0x1b51504d; // "MPQ\x1B"

  const FLAG_IMPLODE = 0x00000100;
  const FLAG_COMPRESS = 0x00000200;
  const FLAG_ENCRYPTED = 0x00010000;
  const FLAG_SINGLE_UNIT = 0x01000000;
  const FLAG_DELETE_MARKER = 0x02000000;
  const FLAG_EXISTS = 0x80000000;

  const HASH_EMPTY = 0xffffffff;
  const HASH_DELETED = 0xfffffffe;

  const HASH_TABLE_OFFSET = 0x000;
  const HASH_NAME_A = 0x100;
  const HASH_NAME_B = 0x200;
  const HASH_FILE_KEY = 0x300;

  // Mount order of the base archives, lowest priority first. base.MPQ is never mounted.
  const VANILLA_BASE_ORDER = [
    'dbc.MPQ', 'speech.MPQ', 'fonts.MPQ', 'interface.MPQ', 'misc.MPQ',
    'sound.MPQ', 'wmo.MPQ', 'terrain.MPQ', 'texture.MPQ', 'model.MPQ',
  ];

  class MpqError extends Error {
    // kind: 'missing' (not in the chain, or deleted by a patch), 'notfound', 'unsupported',
    // 'decompress', 'corrupt', 'notmpq', 'io'
    constructor(kind, message) {
      super(message);
      this.name = 'MpqError';
      this.kind = kind;
    }
  }

  // ---- Storm crypto: one 0x500-entry table for the name hash and the table decryption ----

  const CRYPT = (() => {
    const table = new Uint32Array(0x500);
    let seed = 0x00100001;
    for (let i1 = 0; i1 < 0x100; i1++) {
      for (let i2 = 0; i2 < 5; i2++) {
        seed = (seed * 125 + 3) % 0x2aaaab;
        const t1 = (seed & 0xffff) << 16;
        seed = (seed * 125 + 3) % 0x2aaaab;
        const t2 = seed & 0xffff;
        table[i1 + i2 * 0x100] = (t1 | t2) >>> 0;
      }
    }
    return table;
  })();

  const utf8 = new TextEncoder();

  // The client's string hash over the name's bytes: '/' reads as '\', only a-z are uppercased.
  function hashBytes(bytes, kind) {
    let seed1 = 0x7fed7fed;
    let seed2 = 0xeeeeeeee;
    for (let i = 0; i < bytes.length; i++) {
      let ch = bytes[i];
      if (ch === 0x2f) ch = 0x5c;
      else if (ch >= 0x61 && ch <= 0x7a) ch -= 0x20;
      seed1 = (CRYPT[kind + ch] ^ (seed1 + seed2)) >>> 0;
      seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
    }
    return seed1;
  }

  function hashString(name, kind) {
    return hashBytes(utf8.encode(name), kind);
  }

  // The three hashes that locate a name in any archive.
  function nameHashes(name) {
    const bytes = utf8.encode(name);
    return {
      slot: hashBytes(bytes, HASH_TABLE_OFFSET),
      a: hashBytes(bytes, HASH_NAME_A),
      b: hashBytes(bytes, HASH_NAME_B),
    };
  }

  function decryptBlock(words, key) {
    if (key === 0) return;
    let seed = 0xeeeeeeee;
    for (let i = 0; i < words.length; i++) {
      seed = (seed + CRYPT[0x400 + (key & 0xff)]) >>> 0;
      const ch = (words[i] ^ (key + seed)) >>> 0;
      words[i] = ch;
      key = ((((~key << 21) >>> 0) + 0x11111111) | (key >>> 11)) >>> 0;
      seed = (ch + seed + (seed << 5) + 3) >>> 0;
    }
  }

  // ---- inflate (RFC 1950 / 1951), bounded: stops once `want` bytes are out ----

  const LEN_BASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
  const LEN_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
  const DIST_BASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
  const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
  const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

  const FAST_BITS = 11;
  const FAST_SIZE = 1 << FAST_BITS;
  const FAST_MASK = FAST_SIZE - 1;

  function rev16(n) {
    n = ((n & 0xaaaa) >>> 1) | ((n & 0x5555) << 1);
    n = ((n & 0xcccc) >>> 2) | ((n & 0x3333) << 2);
    n = ((n & 0xf0f0) >>> 4) | ((n & 0x0f0f) << 4);
    return ((n & 0xff00) >>> 8) | ((n & 0x00ff) << 8);
  }

  // A canonical Huffman decoder: a 9-bit direct table, longer codes by range.
  function Huffman() {
    this.fast = new Uint16Array(FAST_SIZE);
    this.firstcode = new Int32Array(17);
    this.maxcode = new Int32Array(17);
    this.firstsymbol = new Int32Array(17);
    this.size = new Uint8Array(288);
    this.value = new Uint16Array(288);
  }

  const scratchSizes = new Int32Array(17);
  const scratchNext = new Int32Array(17);

  function buildHuffman(h, lengths, off, num) {
    const sizes = scratchSizes;
    const next = scratchNext;
    sizes.fill(0);
    h.fast.fill(0);
    h.size.fill(0);
    for (let i = 0; i < num; i++) sizes[lengths[off + i]]++;
    sizes[0] = 0;
    let code = 0;
    let k = 0;
    for (let i = 1; i < 16; i++) {
      if (sizes[i] > (1 << i)) return false;
      next[i] = code;
      h.firstcode[i] = code;
      h.firstsymbol[i] = k;
      code += sizes[i];
      if (sizes[i] && code - 1 >= (1 << i)) return false;
      h.maxcode[i] = code << (16 - i);
      code <<= 1;
      k += sizes[i];
    }
    h.maxcode[16] = 0x10000;
    for (let i = 0; i < num; i++) {
      const s = lengths[off + i];
      if (!s) continue;
      const c = next[s] - h.firstcode[s] + h.firstsymbol[s];
      h.size[c] = s;
      h.value[c] = i;
      if (s <= FAST_BITS) {
        const fastv = (s << 9) | i;
        for (let j = rev16(next[s]) >>> (16 - s); j < FAST_SIZE; j += 1 << s) h.fast[j] = fastv;
      }
      next[s]++;
    }
    return true;
  }

  const FIXED_LIT = new Huffman();
  const FIXED_DIST = new Huffman();
  (() => {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144);
    l.fill(9, 144, 256);
    l.fill(7, 256, 280);
    l.fill(8, 280, 288);
    buildHuffman(FIXED_LIT, l, 0, 288);
    const d = new Uint8Array(32).fill(5);
    buildHuffman(FIXED_DIST, d, 0, 32);
  })();

  const dynLit = new Huffman();
  const dynDist = new Huffman();
  const dynCl = new Huffman();
  const dynLengths = new Uint8Array(288 + 32 + 137);
  const dynClLengths = new Uint8Array(19);

  // The decoder's place in its input, shared by the helpers below. One stream at a time.
  const Z = { src: null, pos: 0, end: 0, bitbuf: 0, bitcnt: 0, over: 0, endOfBlock: false };

  const truncated = () => new MpqError('decompress', 'zlib: unexpected end of stream');
  const corrupt = (what) => new MpqError('decompress', 'zlib: ' + what);

  // Top the bit buffer up. Past the end of the input it feeds zero bytes and counts them.
  // The buffer never holds more than 31 bits, so it stays a non-negative 32-bit integer.
  function zfill() {
    const src = Z.src;
    const end = Z.end;
    let pos = Z.pos;
    let bitbuf = Z.bitbuf;
    let bitcnt = Z.bitcnt;
    while (bitcnt <= 23) {
      if (pos < end) bitbuf |= src[pos++] << bitcnt;
      else Z.over++;
      bitcnt += 8;
    }
    Z.pos = pos;
    Z.bitbuf = bitbuf;
    Z.bitcnt = bitcnt;
  }

  function zbits(n) {
    if (Z.bitcnt < n) zfill();
    const v = Z.bitbuf & ((1 << n) - 1);
    Z.bitbuf >>= n;
    Z.bitcnt -= n;
    return v;
  }

  // A code longer than the direct table, from the next 16 bits: (symbol << 4) | length, or -1.
  function longCode(h, low16) {
    const k = rev16(low16);
    let s = FAST_BITS + 1;
    while (k >= h.maxcode[s]) s++;
    if (s >= 16) return -1;
    const idx = (k >>> (16 - s)) - h.firstcode[s] + h.firstsymbol[s];
    if (idx < 0 || idx >= 288 || h.size[idx] !== s) return -1;
    return (h.value[idx] << 4) | s;
  }

  function zdecode(h) {
    if (Z.bitcnt < 16) zfill();
    const b = h.fast[Z.bitbuf & FAST_MASK];
    let s;
    let v;
    if (b) {
      s = b >>> 9;
      v = b & 511;
    } else {
      const c = longCode(h, Z.bitbuf & 0xffff);
      if (c < 0) return -1;
      s = c & 15;
      v = c >>> 4;
    }
    Z.bitbuf >>= s;
    Z.bitcnt -= s;
    return v;
  }

  // The symbols of one compressed block, with the decoder's state in locals. Returns the new
  // output position; Z.endOfBlock says whether the block ended or the output is full.
  function inflateBlock(lit, dist, out, op, outStart, outEnd) {
    const src = Z.src;
    const end = Z.end;
    const litFast = lit.fast;
    const distFast = dist.fast;
    let pos = Z.pos;
    let bitbuf = Z.bitbuf;
    let bitcnt = Z.bitcnt;
    let over = Z.over;
    let endOfBlock = false;
    for (;;) {
      if (bitcnt < 16) {
        while (bitcnt <= 23) {
          if (pos < end) bitbuf |= src[pos++] << bitcnt;
          else over++;
          bitcnt += 8;
        }
      }
      let z;
      let b = litFast[bitbuf & FAST_MASK];
      if (b) {
        const s = b >>> 9;
        bitbuf >>= s;
        bitcnt -= s;
        z = b & 511;
      } else {
        const c = longCode(lit, bitbuf & 0xffff);
        if (c < 0) throw corrupt('bad code');
        bitbuf >>= c & 15;
        bitcnt -= c & 15;
        z = c >>> 4;
      }
      if (over !== 0 && bitcnt < over << 3) throw truncated();
      if (z < 256) {
        out[op++] = z;
        if (op === outEnd) break;
        continue;
      }
      if (z === 256) {
        endOfBlock = true;
        break;
      }
      z -= 257;
      if (z >= 29) throw corrupt('bad length code');
      let len = LEN_BASE[z];
      const le = LEN_EXTRA[z];
      if (le !== 0) {
        if (bitcnt < le) {
          while (bitcnt <= 23) {
            if (pos < end) bitbuf |= src[pos++] << bitcnt;
            else over++;
            bitcnt += 8;
          }
        }
        len += bitbuf & ((1 << le) - 1);
        bitbuf >>= le;
        bitcnt -= le;
      }
      if (bitcnt < 16) {
        while (bitcnt <= 23) {
          if (pos < end) bitbuf |= src[pos++] << bitcnt;
          else over++;
          bitcnt += 8;
        }
      }
      b = distFast[bitbuf & FAST_MASK];
      if (b) {
        const s = b >>> 9;
        bitbuf >>= s;
        bitcnt -= s;
        z = b & 511;
      } else {
        const c = longCode(dist, bitbuf & 0xffff);
        if (c < 0) throw corrupt('bad distance code');
        bitbuf >>= c & 15;
        bitcnt -= c & 15;
        z = c >>> 4;
      }
      if (z >= 30) throw corrupt('bad distance code');
      let d = DIST_BASE[z];
      const de = DIST_EXTRA[z];
      if (de !== 0) {
        if (bitcnt < de) {
          while (bitcnt <= 23) {
            if (pos < end) bitbuf |= src[pos++] << bitcnt;
            else over++;
            bitcnt += 8;
          }
        }
        d += bitbuf & ((1 << de) - 1);
        bitbuf >>= de;
        bitcnt -= de;
      }
      if (over !== 0 && bitcnt < over << 3) throw truncated();
      if (op - outStart < d) throw corrupt('distance before the start');
      let n = outEnd - op;
      if (len < n) n = len;
      let from = op - d;
      if (n > 24 && d >= n) {
        out.copyWithin(op, from, from + n);
        op += n;
      } else {
        for (let i = 0; i < n; i++) out[op++] = out[from++];
      }
      if (op === outEnd) break;
    }
    Z.pos = pos;
    Z.bitbuf = bitbuf;
    Z.bitcnt = bitcnt;
    Z.over = over;
    Z.endOfBlock = endOfBlock;
    return op;
  }

  // Inflate the zlib stream src[pos..end) into out[outPos..outPos+want). Returns the bytes
  // written, which is less than `want` only when the stream ends early. The checksum trailer is
  // not read: the caller's size check and the bounded output are the contract here.
  function inflateZlib(src, pos, end, out, outPos, want) {
    if (end - pos < 2) throw new MpqError('decompress', 'zlib: truncated header');
    const cmf = src[pos];
    const flg = src[pos + 1];
    if ((cmf & 0x0f) !== 8 || (cmf >>> 4) > 7 || ((cmf << 8) | flg) % 31 !== 0) throw new MpqError('decompress', 'zlib: bad header');
    if (flg & 0x20) throw new MpqError('decompress', 'zlib: preset dictionary');

    Z.src = src;
    Z.pos = pos + 2;
    Z.end = end;
    Z.bitbuf = 0;
    Z.bitcnt = 0;
    Z.over = 0;
    const outStart = outPos;
    const outEnd = outPos + want;
    try {
      for (;;) {
        const last = zbits(1);
        const type = zbits(2);
        if (Z.over && Z.bitcnt < Z.over << 3) throw truncated();
        if (type === 0) {
          // Stored: drop to a byte boundary, hand the unread whole bytes back to the input, then
          // LEN and its complement straight from it.
          const whole = Z.bitcnt - (Z.bitcnt & 7);
          let at = Z.pos - ((whole >>> 3) - Z.over);
          Z.bitbuf = 0;
          Z.bitcnt = 0;
          Z.over = 0;
          if (at + 4 > end) throw truncated();
          const len = src[at] | (src[at + 1] << 8);
          const nlen = src[at + 2] | (src[at + 3] << 8);
          at += 4;
          if (nlen !== (len ^ 0xffff)) throw corrupt('stored block length');
          if (at + len > end) throw truncated();
          const n = Math.min(len, outEnd - outPos);
          out.set(src.subarray(at, at + n), outPos);
          outPos += n;
          Z.pos = at + len;
          if (outPos === outEnd) return outPos - outStart;
        } else if (type === 1 || type === 2) {
          let lit = FIXED_LIT;
          let dist = FIXED_DIST;
          if (type === 2) {
            const hlit = zbits(5) + 257;
            const hdist = zbits(5) + 1;
            const hclen = zbits(4) + 4;
            dynClLengths.fill(0);
            for (let i = 0; i < hclen; i++) dynClLengths[CL_ORDER[i]] = zbits(3);
            if (!buildHuffman(dynCl, dynClLengths, 0, 19)) throw corrupt('code lengths');
            const total = hlit + hdist;
            let n = 0;
            while (n < total) {
              const c = zdecode(dynCl);
              if (c < 0 || c >= 19) throw corrupt('code lengths');
              if (c < 16) {
                dynLengths[n++] = c;
                continue;
              }
              let fillv = 0;
              let rep;
              if (c === 16) {
                if (n === 0) throw corrupt('code lengths');
                rep = zbits(2) + 3;
                fillv = dynLengths[n - 1];
              } else if (c === 17) rep = zbits(3) + 3;
              else rep = zbits(7) + 11;
              if (total - n < rep) throw corrupt('code lengths');
              dynLengths.fill(fillv, n, n + rep);
              n += rep;
            }
            if (Z.over && Z.bitcnt < Z.over << 3) throw truncated();
            if (!buildHuffman(dynLit, dynLengths, 0, hlit)) throw corrupt('literal codes');
            if (!buildHuffman(dynDist, dynLengths, hlit, hdist)) throw corrupt('distance codes');
            lit = dynLit;
            dist = dynDist;
          }
          outPos = inflateBlock(lit, dist, out, outPos, outStart, outEnd);
          if (!Z.endOfBlock) return outPos - outStart;
        } else {
          throw corrupt('bad block type');
        }
        if (last) return outPos - outStart;
      }
    } finally {
      Z.src = null;
    }
  }

  // ---- one archive ----

  function u32le(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  }

  function toWords(bytes) {
    const n = bytes.length >>> 2;
    const words = new Uint32Array(n);
    for (let i = 0; i < n; i++) words[i] = u32le(bytes, i * 4);
    return words;
  }

  async function readExact(source, offset, length) {
    if (length === 0) return new Uint8Array(0);
    let bytes;
    try {
      bytes = await source.read(offset, length);
    } catch (e) {
      throw new MpqError('io', `${source.name}: ${e && e.message ? e.message : e}`);
    }
    if (bytes.length !== length) throw new MpqError('io', `${source.name}: short read at ${offset}`);
    return bytes;
  }

  // The header's offset: the first 512-aligned signature, or where a user-data header points.
  async function findHeader(source) {
    // 1.12 archives start with the header; look there before scanning.
    if (source.size >= 4 && u32le(await readExact(source, 0, 4), 0) === SIGNATURE) return 0;
    const CHUNK = 1 << 20;
    for (let base = 0; base + 4 <= source.size; base += CHUNK) {
      const len = Math.min(CHUNK, source.size - base);
      const buf = await readExact(source, base, len);
      for (let o = 0; o + 4 <= len; o += 512) {
        const sig = u32le(buf, o);
        if (sig === SIGNATURE) return base + o;
        if (sig === USERDATA_SIGNATURE) {
          const rest = await readExact(source, base + o + 4, 8);
          return base + o + u32le(rest, 4);
        }
      }
    }
    throw new MpqError('notmpq', `${source.name}: not an MPQ archive`);
  }

  async function readTable(source, pos, count, keyName, what) {
    const avail = Math.max(0, source.size - pos);
    if (count * 16 > avail) throw new MpqError('corrupt', `${source.name}: ${what} larger than the archive`);
    const words = toWords(await readExact(source, pos, count * 16));
    decryptBlock(words, hashString(keyName, HASH_FILE_KEY));
    return words;
  }

  class Archive {
    constructor(source, archiveOffset, sectorSize, hashTable, blockTable) {
      this.source = source;
      this.name = source.name;
      this.archiveOffset = archiveOffset;
      this.sectorSize = sectorSize;
      this.hashTable = hashTable; // 4 words an entry: name A, name B, locale, block index
      this.hashCount = hashTable.length >>> 2;
      this.blockTable = blockTable; // 4 words an entry: position, stored size, size, flags
      this.blockCount = blockTable.length >>> 2;
    }

    static async open(source) {
      const archiveOffset = await findHeader(source);
      const hdr = await readExact(source, archiveOffset, 32);
      const shift = hdr[14] | (hdr[15] << 8);
      if (shift > 23) throw new MpqError('corrupt', `${source.name}: block size shift ${shift}`);
      const hashTable = await readTable(source, archiveOffset + u32le(hdr, 16), u32le(hdr, 24), '(hash table)', 'hash table');
      const blockTable = await readTable(source, archiveOffset + u32le(hdr, 20), u32le(hdr, 28), '(block table)', 'block table');
      return new Archive(source, archiveOffset, 512 * 2 ** shift, hashTable, blockTable);
    }

    // The block index for a name's hashes, or -1.
    find(h) {
      const len = this.hashCount;
      if (len === 0) return -1;
      const table = this.hashTable;
      const start = (h.slot & (len - 1)) >>> 0;
      for (let i = 0; i < len; i++) {
        const o = ((start + i) % len) * 4;
        const block = table[o + 3];
        if (block === HASH_EMPTY) return -1;
        if (block === HASH_DELETED) continue;
        if (table[o] === h.a && table[o + 1] === h.b) return block < this.blockCount ? block : -1;
      }
      return -1;
    }

    contains(h) {
      return this.find(h) >= 0;
    }

    isDeleteMarker(h) {
      const b = this.find(h);
      return b >= 0 && (this.blockTable[b * 4 + 3] & FLAG_DELETE_MARKER) !== 0;
    }

    // Why a present entry cannot be read, as an MpqError, or null when it can.
    refusal(block, name) {
      const flags = this.blockTable[block * 4 + 3];
      if ((flags & FLAG_EXISTS) === 0) return new MpqError('notfound', `file not in archive: ${name}`);
      if (flags & FLAG_DELETE_MARKER) return new MpqError('notfound', `file not in archive: ${name}`);
      if (flags & FLAG_ENCRYPTED) return new MpqError('unsupported', `encrypted file ${name}`);
      if (flags & FLAG_SINGLE_UNIT) return new MpqError('unsupported', `single-unit file ${name}`);
      return null;
    }

    async readFile(name, hashes) {
      const h = hashes || nameHashes(name);
      const block = this.find(h);
      if (block < 0) throw new MpqError('notfound', `file not in archive: ${name}`);
      const refused = this.refusal(block, name);
      if (refused) throw refused;

      const source = this.source;
      const base = this.archiveOffset + this.blockTable[block * 4];
      const size = this.blockTable[block * 4 + 2];
      const flags = this.blockTable[block * 4 + 3];
      const avail = Math.max(0, source.size - base);

      if ((flags & (FLAG_COMPRESS | FLAG_IMPLODE)) === 0) {
        if (size > avail) throw new MpqError('corrupt', `${name}: stored size (${size}) larger than the archive`);
        return readExact(source, base, size);
      }
      const implodeOnly = (flags & FLAG_IMPLODE) !== 0 && (flags & FLAG_COMPRESS) === 0;

      // Sectored: sector_count + 1 offsets, measured from the file's first byte.
      const sectorSize = this.sectorSize;
      const sectorCount = Math.ceil(size / sectorSize);
      const otabLen = sectorCount + 1;
      const otabBytes = otabLen * 4;
      if (otabBytes > avail) throw new MpqError('corrupt', `${name}: sector offset table (${otabLen} entries) larger than the archive`);
      // The block table's stored size normally spans the offset table and every sector: one read
      // then, instead of two. The offsets still decide; a span past it is read on its own.
      const stored = this.blockTable[block * 4 + 1];
      const whole = stored >= otabBytes && stored <= avail ? await readExact(source, base, stored) : null;
      const offsets = toWords(whole ? whole.subarray(0, otabBytes) : await readExact(source, base, otabBytes));
      const out = new Uint8Array(size);
      if (sectorCount === 0) return out;

      // Validate every sector before reading, then fetch the whole span once.
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i < sectorCount; i++) {
        const start = offsets[i];
        const end = offsets[i + 1];
        if (end < start) throw new MpqError('decompress', `${name}: sector ${i} offsets reversed`);
        const compLen = end - start;
        if (compLen > avail) throw new MpqError('corrupt', `${name}: sector ${i} length (${compLen}) larger than the archive`);
        if (compLen === 0) throw new MpqError('corrupt', `${name}: sector ${i} is empty`);
        if (start < lo) lo = start;
        if (end > hi) hi = end;
      }
      if (hi > avail) throw new MpqError('io', `${name}: sector data past the end of the archive`);
      let raw = whole;
      let rawBase = 0;
      if (!whole || hi > stored) {
        raw = await readExact(source, base + lo, hi - lo);
        rawBase = lo;
      }

      for (let i = 0; i < sectorCount; i++) {
        const want = Math.min(size - i * sectorSize, sectorSize);
        const start = offsets[i] - rawBase;
        const compLen = offsets[i + 1] - offsets[i];
        const at = i * sectorSize;
        if (compLen >= want) {
          // A sector that would not shrink is stored as it is.
          out.set(raw.subarray(start, start + want), at);
          continue;
        }
        if (implodeOnly) throw new MpqError('unsupported', `${name}: sector codec 0x08 not yet implemented`);
        const method = raw[start];
        if (method !== 0x02) throw new MpqError('unsupported', `${name}: sector codec 0x${method.toString(16).toUpperCase().padStart(2, '0')} not yet implemented`);
        let got;
        try {
          got = inflateZlib(raw, start + 1, start + compLen, out, at, want);
        } catch (e) {
          if (e instanceof MpqError) throw new MpqError('decompress', `${name}: ${e.message}`);
          throw e;
        }
        if (got !== want) throw new MpqError('decompress', `${name}: sector ${i} inflates to ${got} bytes, not ${want}`);
      }
      return out;
    }
  }

  // ---- the patch chain ----

  function asciiLower(s) {
    return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  }

  function equalsIgnoreAsciiCase(a, b) {
    return a.length === b.length && asciiLower(a) === asciiLower(b);
  }

  // patch-?.MPQ: exactly one character between "patch-" and ".mpq", any case.
  function isPatchGlobMatch(name) {
    const lower = asciiLower(name);
    if (!lower.startsWith('patch-') || !lower.endsWith('.mpq')) return false;
    return Array.from(lower.slice(6, -4)).length === 1;
  }

  function compareCodePoints(a, b) {
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
      const x = ia.next();
      const y = ib.next();
      if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
      const d = x.value.codePointAt(0) - y.value.codePointAt(0);
      if (d) return d;
    }
  }

  // Ascending priority: the base archives, patch.MPQ, each patch-?.MPQ by case-folded name,
  // then speech2.MPQ. Names come back as found.
  function mountOrder(dirNames) {
    const names = dirNames.slice().sort(compareCodePoints);
    const find = (want) => names.find((n) => equalsIgnoreAsciiCase(n, want));
    const order = [];
    for (const b of VANILLA_BASE_ORDER) {
      const f = find(b);
      if (f !== undefined) order.push(f);
    }
    const patch = find('patch.MPQ');
    if (patch !== undefined) order.push(patch);
    const patches = names.filter(isPatchGlobMatch).map((n) => [asciiLower(n), n]);
    patches.sort((x, y) => compareCodePoints(x[0], y[0]));
    for (const p of patches) order.push(p[1]);
    const speech2 = find('speech2.MPQ');
    if (speech2 !== undefined) order.push(speech2);
    return order;
  }

  // Whitespace as the native reader trims it (the Unicode White_Space set).
  function isSpace(c) {
    return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }

  function trimSpace(s) {
    let a = 0;
    let b = s.length;
    while (a < b && isSpace(s.charCodeAt(a))) a++;
    while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
    return a === 0 && b === s.length ? s : s.slice(a, b);
  }

  const lossyUtf8 = new TextDecoder('utf-8', { ignoreBOM: true });

  class Chain {
    constructor(archives) {
      this.archives = archives; // ascending priority: later archives win
      this.indexBytes = null;
    }

    // `sources` is every file of the Data folder; the chain mounts the ones it knows.
    static async open(sources) {
      const byName = new Map(sources.map((s) => [s.name, s]));
      const order = mountOrder(sources.map((s) => s.name));
      if (order.length === 0) throw new MpqError('notmpq', 'no known vanilla MPQs found');
      const archives = [];
      for (const name of order) archives.push(await Archive.open(byName.get(name)));
      return new Chain(archives);
    }

    // The highest-priority archive with an entry for the name, a delete marker included.
    resolve(h) {
      for (let i = this.archives.length - 1; i >= 0; i--) {
        if (this.archives[i].contains(h)) return this.archives[i];
      }
      return null;
    }

    contains(name) {
      const h = nameHashes(name);
      const a = this.resolve(h);
      return a !== null && !a.isDeleteMarker(h);
    }

    // The archive a read would use; throws 'missing' for a name not in the chain or deleted.
    archiveFor(name, h) {
      const a = this.resolve(h);
      if (a === null) throw new MpqError('missing', `file not in patch chain: ${name}`);
      if (a.isDeleteMarker(h)) throw new MpqError('missing', `file deleted from patch chain: ${name} (tombstoned by ${a.name})`);
      return a;
    }

    async read(name) {
      const h = nameHashes(name);
      return this.archiveFor(name, h).readFile(name, h);
    }

    // What a read would answer, without reading: 'ok', or the MpqError it would throw up front.
    probe(name) {
      const h = nameHashes(name);
      let a;
      try {
        a = this.archiveFor(name, h);
      } catch (e) {
        return e;
      }
      return a.refusal(a.find(h), name) || 'ok';
    }

    // The chain's named files: the union of every archive's (listfile), first spelling kept.
    async list() {
      const seen = new Set();
      const out = [];
      for (const archive of this.archives) {
        let listfile;
        try {
          listfile = await archive.readFile('(listfile)');
        } catch (e) {
          continue;
        }
        for (const raw of lossyUtf8.decode(listfile).split(/[;\r\n]/)) {
          const name = trimSpace(raw);
          if (name === '') continue;
          const key = asciiLower(name.replace(/\//g, '\\'));
          if (seen.has(key)) continue;
          seen.add(key);
          const h = nameHashes(name);
          const a = this.resolve(h);
          if (a !== null && !a.isDeleteMarker(h)) out.push(name);
        }
      }
      return out;
    }

    // The list as the JSON array the client fetches, built once.
    async indexJson() {
      if (!this.indexBytes) this.indexBytes = utf8.encode(JSON.stringify(await this.list()));
      return this.indexBytes;
    }
  }

  // ---- the /data URL scheme ----

  function hexValue(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x37;
    if (c >= 0x61 && c <= 0x66) return c - 0x57;
    return -1;
  }

  // A URL path's text: percent-decoded as bytes, read as UTF-8.
  function percentDecode(tail) {
    const src = utf8.encode(tail);
    const out = new Uint8Array(src.length);
    let n = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === 0x25 && i + 2 < src.length) {
        const hi = hexValue(src[i + 1]);
        const lo = hexValue(src[i + 2]);
        if (hi >= 0 && lo >= 0) {
          out[n++] = (hi << 4) | lo;
          i += 2;
          continue;
        }
      }
      out[n++] = src[i];
    }
    return lossyUtf8.decode(out.subarray(0, n));
  }

  // The chain name for the path after "/data/": decoded, with '/' turned into '\'.
  function nameFromPath(tail) {
    return percentDecode(tail).replace(/\//g, '\\');
  }

  // The client's encoding of a name as one URL component (as encodeURIComponent).
  function encodeName(name) {
    return encodeURIComponent(name);
  }

  function contentType(name) {
    const dot = name.lastIndexOf('.');
    const ext = asciiLower(dot >= 0 ? name.slice(dot + 1) : name);
    if (ext === 'blp') return 'image/x-blp';
    if (ext === 'mp3') return 'audio/mpeg';
    return 'application/octet-stream';
  }

  function blobSource(name, blob) {
    return {
      name,
      size: blob.size,
      read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    };
  }

  // What the host's two route families answer, as { status, body, type, cache } with a null body
  // where there is none. A name the chain lacks, or a file that cannot be read, throws the
  // MpqError; statusOf turns it into the route's status. `shared` marks a body that is kept
  // for the next answer too, so a caller must not hand its buffer away.
  const CACHE_FILE = 'private, max-age=31536000, immutable';
  const CACHE_INDEX = 'private, max-age=86400';

  async function dataRoute(chain, method, pathname, indexBytes) {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: null };
    if (pathname === '/data/__index') {
      const bytes = await (indexBytes ? indexBytes(chain) : chain.indexJson());
      return { status: 200, body: method === 'HEAD' ? null : bytes, type: 'application/json', cache: CACHE_INDEX, shared: true };
    }
    const tail = pathname.slice('/data/'.length);
    if (tail === '') return { status: 404, body: null };
    const name = nameFromPath(tail);
    const type = contentType(name);
    if (method === 'HEAD') {
      const probe = chain.probe(name);
      if (probe !== 'ok') throw probe;
      return { status: 200, body: null, type, cache: CACHE_FILE };
    }
    return { status: 200, body: await chain.read(name), type, cache: CACHE_FILE };
  }

  // ---- the /addons URL scheme: the game's AddOns folder ----

  // A walk stops at this many files or this depth: a folder that large is not an addon.
  const ADDON_MAX_FILES = 50000;
  const ADDON_MAX_DEPTH = 24;

  // A name the client can ask for: not empty, "." or "..", and no separator or drive colon.
  function plainName(name) {
    return name !== '' && name !== '.' && name !== '..' && !/[\\/:]/.test(name);
  }

  function comparePaths(a, b) {
    const x = a.split('/');
    const y = b.split('/');
    for (let i = 0; i < x.length && i < y.length; i++) {
      const d = compareCodePoints(x[i], y[i]);
      if (d) return d;
    }
    return x.length - y.length;
  }

  // The folder the game sees, from [{ path, file }] with paths "<Addon>/<...>" in forward
  // slashes. An addon's folder name, in any case, belongs to the first spelling listed; the
  // listing is every file, one path a line, folder by folder in name order.
  function addonFolder(list) {
    const owners = new Map(); // the folder name in lower case -> the spelling that owns it
    const files = new Map(); // path -> file
    for (const item of list || []) {
      if (!item || typeof item.path !== 'string' || !item.file) continue;
      const parts = item.path.split('/');
      if (parts.length < 2 || parts.length - 2 > ADDON_MAX_DEPTH || !parts.every(plainName)) continue;
      const key = parts[0].toLowerCase();
      if (!owners.has(key)) owners.set(key, parts[0]);
      if (owners.get(key) !== parts[0] || files.has(item.path)) continue;
      files.set(item.path, item.file);
    }
    const paths = Array.from(files.keys()).sort(comparePaths);
    for (const extra of paths.splice(ADDON_MAX_FILES)) files.delete(extra);
    return { owners, files, paths, listing: utf8.encode(paths.join('\n')) };
  }

  // One file of the folder by its "<Addon>/<path>", the addon's name in any case; null for
  // anything else.
  function addonFile(folder, rel) {
    const parts = rel.split('/');
    if (parts.length < 2 || !parts.every(plainName)) return null;
    const owner = folder.owners.get(parts[0].toLowerCase());
    if (owner === undefined) return null;
    parts[0] = owner;
    return folder.files.get(parts.join('/')) || null;
  }

  // GET/HEAD /addons/__index and /addons/<path>. `folder` is addonFolder()'s result, or null
  // for an empty AddOns folder; `read(file)` gives a file's bytes. The query "xhr" asks for one
  // space in front of the body: a client that takes the body as text one character per byte
  // would otherwise have a leading byte-order mark decoded away.
  async function addonsRoute(method, pathname, query, folder, read) {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: null };
    const head = method === 'HEAD';
    if (pathname === '/addons/__index') {
      return { status: 200, body: head ? null : folder ? folder.listing : new Uint8Array(0), type: 'text/plain; charset=utf-8', cache: 'no-store', shared: true };
    }
    const file = folder ? addonFile(folder, percentDecode(pathname.slice('/addons/'.length))) : null;
    if (!file) return { status: 404, body: null };
    const answer = { status: 200, body: null, type: 'application/octet-stream', cache: 'no-store' };
    if (head) return answer;
    const bytes = await read(file);
    if (query === 'xhr') {
      answer.body = new Uint8Array(bytes.length + 1);
      answer.body[0] = 0x20;
      answer.body.set(bytes, 1);
    } else {
      answer.body = bytes;
    }
    return answer;
  }

  function statusOf(error) {
    return error instanceof MpqError && error.kind === 'missing' ? 404 : 500;
  }

  const api = {
    Archive, Chain, MpqError, VANILLA_BASE_ORDER,
    hashString, nameHashes, mountOrder, inflateZlib, nameFromPath, encodeName, contentType, blobSource,
    dataRoute, addonsRoute, addonFolder, addonFile, plainName, statusOf,
  };
  root.ElectrodeMpq = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
