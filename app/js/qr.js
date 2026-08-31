// QR encoder for invite links. Byte mode, error correction level M,
// versions 1-10 with automatic smallest-fit selection. Output is verified
// byte-for-byte against the Python qrcode library in test/qr.test.mjs, so
// the mask evaluation below mirrors that library's exact scoring order.

// GF(256) with the 0x11d reduction polynomial.
const GF_EXP = new Uint8Array(255);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

// ECC level M block layout per version: groups of [count, totalCw, dataCw].
const RS_M = [
  null,
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
];

const ALIGN_POS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

const G15 = 0x537;
const G18 = 0x1f25;
const G15_MASK = 0x5412;

function bchDigit(d) {
  let n = 0;
  while (d !== 0) {
    n++;
    d >>>= 1;
  }
  return n;
}

function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

function rsBlocks(version) {
  const blocks = [];
  for (const [count, total, data] of RS_M[version]) {
    for (let i = 0; i < count; i++) blocks.push([total, data]);
  }
  return blocks;
}

function dataCodewordCount(version) {
  let sum = 0;
  for (const [, data] of rsBlocks(version)) sum += data;
  return sum;
}

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const needed = 4 + (v < 10 ? 8 : 16) + 8 * byteLen;
    if (needed <= dataCodewordCount(v) * 8) return v;
  }
  throw new Error("data too long for QR version 10");
}

function genPoly(ecCount) {
  let g = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      if (g[j] !== 0) next[j + 1] ^= GF_EXP[(GF_LOG[g[j]] + i) % 255];
    }
    g = next;
  }
  return g;
}

function rsRemainder(data, gen) {
  const ec = gen.length - 1;
  const rem = new Array(ec).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      const lf = GF_LOG[factor];
      for (let i = 0; i < ec; i++) {
        if (gen[i + 1] !== 0) rem[i] ^= GF_EXP[(lf + GF_LOG[gen[i + 1]]) % 255];
      }
    }
  }
  return rem;
}

class Bits {
  constructor() {
    this.bytes = [];
    this.len = 0;
  }

  putBit(bit) {
    const i = this.len >> 3;
    if (this.bytes.length <= i) this.bytes.push(0);
    if (bit) this.bytes[i] |= 0x80 >> (this.len & 7);
    this.len++;
  }

  put(num, length) {
    for (let i = 0; i < length; i++) this.putBit(((num >> (length - i - 1)) & 1) === 1);
  }
}

function createCodewords(version, bytes) {
  const bitLimit = dataCodewordCount(version) * 8;
  const buf = new Bits();
  buf.put(4, 4);
  buf.put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  if (buf.len > bitLimit) throw new Error("data too long for chosen version");
  const term = Math.min(bitLimit - buf.len, 4);
  for (let i = 0; i < term; i++) buf.putBit(false);
  while (buf.len % 8 !== 0) buf.putBit(false);
  let pad = 0;
  while (buf.len < bitLimit) buf.put(pad++ % 2 === 0 ? 0xec : 0x11, 8);

  const dcs = [];
  const ecs = [];
  let maxDc = 0;
  let maxEc = 0;
  let offset = 0;
  for (const [total, dc] of rsBlocks(version)) {
    const ecCount = total - dc;
    if (dc > maxDc) maxDc = dc;
    if (ecCount > maxEc) maxEc = ecCount;
    const block = buf.bytes.slice(offset, offset + dc);
    offset += dc;
    dcs.push(block);
    ecs.push(rsRemainder(block, genPoly(ecCount)));
  }

  const out = [];
  for (let i = 0; i < maxDc; i++) {
    for (const d of dcs) if (i < d.length) out.push(d[i]);
  }
  for (let i = 0; i < maxEc; i++) {
    for (const e of ecs) if (i < e.length) out.push(e[i]);
  }
  return out;
}

function placeFinder(m, n, row, col) {
  for (let r = -1; r < 8; r++) {
    if (row + r <= -1 || n <= row + r) continue;
    for (let c = -1; c < 8; c++) {
      if (col + c <= -1 || n <= col + c) continue;
      m[row + r][col + c] =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
    }
  }
}

function placeAlignment(m, version) {
  const pos = ALIGN_POS[version];
  for (const row of pos) {
    for (const col of pos) {
      if (m[row][col] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[row + r][col + c] =
            r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }
}

function placeTiming(m, n) {
  for (let r = 8; r < n - 8; r++) {
    if (m[r][6] === null) m[r][6] = r % 2 === 0;
  }
  for (let c = 8; c < n - 8; c++) {
    if (m[6][c] === null) m[6][c] = c % 2 === 0;
  }
}

const skeletonCache = new Map();

function skeleton(version) {
  let base = skeletonCache.get(version);
  if (!base) {
    const n = version * 4 + 17;
    base = Array.from({ length: n }, () => new Array(n).fill(null));
    placeFinder(base, n, 0, 0);
    placeFinder(base, n, n - 7, 0);
    placeFinder(base, n, 0, n - 7);
    placeAlignment(base, version);
    placeTiming(base, n);
    skeletonCache.set(version, base);
  }
  return base.map((row) => row.slice());
}

// test=true leaves format and version modules light, matching how the
// reference implementation scores mask candidates.
function placeFormat(m, n, maskPattern, test) {
  const bits = bchTypeInfo(maskPattern);
  for (let i = 0; i < 15; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    if (i < 6) m[i][8] = mod;
    else if (i < 8) m[i + 1][8] = mod;
    else m[n - 15 + i][8] = mod;
  }
  for (let i = 0; i < 15; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    if (i < 8) m[8][n - i - 1] = mod;
    else if (i < 9) m[8][15 - i] = mod;
    else m[8][14 - i] = mod;
  }
  m[n - 8][8] = !test;
}

function placeVersionInfo(m, n, version, test) {
  const bits = bchTypeNumber(version);
  for (let i = 0; i < 18; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    m[Math.floor(i / 3)][(i % 3) + n - 11] = mod;
    m[(i % 3) + n - 11][Math.floor(i / 3)] = mod;
  }
}

function mapData(m, n, data, maskPattern) {
  let inc = -1;
  let row = n - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  const mf = MASKS[maskPattern];

  for (let start = n - 1; start > 0; start -= 2) {
    let col = start;
    if (col <= 6) col -= 1;
    for (;;) {
      for (const c of [col, col - 1]) {
        if (m[row][c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >> bitIndex) & 1) === 1;
          if (mf(row, c)) dark = !dark;
          m[row][c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || n <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

function lostPointLevel1(m, n) {
  let lost = 0;
  const container = new Array(n + 1).fill(0);

  for (let row = 0; row < n; row++) {
    const r = m[row];
    let prev = r[0];
    let len = 0;
    for (let col = 0; col < n; col++) {
      if (r[col] === prev) len++;
      else {
        if (len >= 5) container[len]++;
        len = 1;
        prev = r[col];
      }
    }
    if (len >= 5) container[len]++;
  }

  for (let col = 0; col < n; col++) {
    let prev = m[0][col];
    let len = 0;
    for (let row = 0; row < n; row++) {
      if (m[row][col] === prev) len++;
      else {
        if (len >= 5) container[len]++;
        len = 1;
        prev = m[row][col];
      }
    }
    if (len >= 5) container[len]++;
  }

  for (let L = 5; L <= n; L++) lost += container[L] * (L - 2);
  return lost;
}

function lostPointLevel2(m, n) {
  let lost = 0;
  for (let row = 0; row < n - 1; row++) {
    const thisRow = m[row];
    const nextRow = m[row + 1];
    for (let col = 0; col < n - 1; col++) {
      const topRight = thisRow[col + 1];
      if (topRight !== nextRow[col + 1]) col++;
      else if (topRight !== thisRow[col]) continue;
      else if (topRight !== nextRow[col]) continue;
      else lost += 3;
    }
  }
  return lost;
}

function lostPointLevel3(m, n) {
  let lost = 0;

  for (let row = 0; row < n; row++) {
    const r = m[row];
    for (let col = 0; col < n - 10; col++) {
      if (
        !r[col + 1] && r[col + 4] && !r[col + 5] && r[col + 6] && !r[col + 9] &&
        ((r[col] && r[col + 2] && r[col + 3] && !r[col + 7] && !r[col + 8] && !r[col + 10]) ||
          (!r[col] && !r[col + 2] && !r[col + 3] && r[col + 7] && r[col + 8] && r[col + 10]))
      ) {
        lost += 40;
      }
      if (r[col + 10]) col++;
    }
  }

  for (let col = 0; col < n; col++) {
    for (let row = 0; row < n - 10; row++) {
      if (
        !m[row + 1][col] && m[row + 4][col] && !m[row + 5][col] && m[row + 6][col] &&
        !m[row + 9][col] &&
        ((m[row][col] && m[row + 2][col] && m[row + 3][col] && !m[row + 7][col] &&
          !m[row + 8][col] && !m[row + 10][col]) ||
          (!m[row][col] && !m[row + 2][col] && !m[row + 3][col] && m[row + 7][col] &&
            m[row + 8][col] && m[row + 10][col]))
      ) {
        lost += 40;
      }
      if (m[row + 10][col]) row++;
    }
  }

  return lost;
}

function lostPointLevel4(m, n) {
  let dark = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) if (m[row][col]) dark++;
  }
  const percent = dark / (n * n);
  return Math.trunc(Math.abs(percent * 100 - 50) / 5) * 10;
}

function lostPoint(m) {
  const n = m.length;
  return (
    lostPointLevel1(m, n) +
    lostPointLevel2(m, n) +
    lostPointLevel3(m, n) +
    lostPointLevel4(m, n)
  );
}

function buildMatrix(version, data, maskPattern, test) {
  const m = skeleton(version);
  const n = m.length;
  placeFormat(m, n, maskPattern, test);
  if (version >= 7) placeVersionInfo(m, n, version, test);
  mapData(m, n, data, maskPattern);
  return m;
}

function encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = chooseVersion(bytes.length);
  return { version, data: createCodewords(version, bytes) };
}

function bestMask(version, data) {
  let best = 0;
  let minLost = 0;
  for (let i = 0; i < 8; i++) {
    const lp = lostPoint(buildMatrix(version, data, i, true));
    if (i === 0 || minLost > lp) {
      minLost = lp;
      best = i;
    }
  }
  return best;
}

// Returns an NxN array of booleans (true = dark module), no quiet zone.
export function qrMatrix(text) {
  const { version, data } = encode(text);
  return buildMatrix(version, data, bestMask(version, data), false);
}

// Same as qrMatrix but with a fixed mask pattern 0-7. Test hook.
export function qrMatrixForced(text, mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) {
    throw new Error("mask must be an integer 0-7");
  }
  const { version, data } = encode(text);
  return buildMatrix(version, data, mask, false);
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

// Renders the matrix as an SVG string with a 4-module quiet zone.
export function qrSvg(text, opts = {}) {
  const dark = COLOR_RE.test(String(opts.dark || "")) ? opts.dark : "#000000";
  const light = COLOR_RE.test(String(opts.light || "")) ? opts.light : "#ffffff";
  const m = qrMatrix(text);
  const n = m.length;
  const q = 4;
  const size = n + q * 2;
  let rects = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) rects += `<rect x="${x + q}" y="${y + q}" width="1" height="1"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="${light}"/>` +
    `<g fill="${dark}">${rects}</g></svg>`
  );
}
