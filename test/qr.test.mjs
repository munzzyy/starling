// QR encoder tests. Ground truth is the installed Python qrcode library,
// forced to byte mode at error correction level M, compared byte-for-byte
// for every mask 0-7 plus the automatic mask choice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { qrMatrix, qrMatrixForced, qrSvg } from "../app/js/qr.js";

// Note: qrcode 8.2 names the byte mode constant MODE_8BIT_BYTE.
const PY_SCRIPT = `
import qrcode, qrcode.util, json, sys
payload = sys.argv[1]; mask = int(sys.argv[2])
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=1, border=0, mask_pattern=(None if mask < 0 else mask))
qr.add_data(qrcode.util.QRData(payload.encode(), mode=qrcode.util.MODE_8BIT_BYTE), optimize=0)
qr.make(fit=True)
print(json.dumps([[bool(v) for v in row] for row in qr.modules]))
`;

// The Python qrcode library is a dev-only ground truth, not a runtime or a
// required test dependency. When it (or python) is absent the cross-check tests
// skip (reported as skipped, not failed) so `node --test` stays self-contained
// on a bare clone; CI installs it so the cross-check actually runs there.
// python3 on Linux/macOS, python on Windows.
const PY = (() => {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["-c", "import qrcode"], { stdio: "ignore" });
      return bin;
    } catch {
      // try the next name
    }
  }
  return null;
})();
const pySkip = PY ? false : "python qrcode library not installed (dev-only QR ground truth)";

function pythonMatrix(payload, mask) {
  const out = execFileSync(PY, ["-c", PY_SCRIPT, payload, String(mask)], {
    maxBuffer: 1 << 25,
  });
  return JSON.parse(out.toString());
}

function utf8Len(s) {
  return new TextEncoder().encode(s).length;
}

const SECRET_A = "Ab3xZ9qLK7mW2fT8pR5vN0cY6sD1jH4gQoUeIaXtM-_";
const SECRET_B = "zZ0yY1xX2wW3vV4uU5tT6sS7rR8qQ9pP-aAbBcCdD_e";
assert.equal(SECRET_A.length, 43);
assert.equal(SECRET_B.length, 43);

// Payloads chosen to hit versions 1, 5, 7 (version info), 9 and 10
// (16 bit char count), both capacity boundaries, and multi-byte UTF-8.
const PAYLOADS = [
  { text: `https://starling.pages.dev/#j=${SECRET_A}`, version: 5 },
  { text: `https://starling.pages.dev/#j=${SECRET_B}`, version: 5 },
  { text: "S", version: 1 },
  { text: "starling-invit", version: 1 },
  {
    text: "The relay stores ciphertext and learns as little as we can manage. Share this link over a channel you already trust.",
    version: null,
  },
  { text: "x".repeat(120), version: 7 },
  { text: "q".repeat(180), version: 9 },
  { text: "%".repeat(181), version: 10 },
  { text: "9".repeat(213), version: 10 },
  { text: "unicode: héllo wörld ☃ 🐦 スターリングの招待", version: null },
];

assert.ok(PAYLOADS.length >= 8);
assert.ok(PAYLOADS[4].text.length >= 100);

function checkFinder(m, top, left) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const dark = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      assert.equal(m[top + r][left + c], dark, `finder at (${top},${left}) module (${r},${c})`);
    }
  }
}

function checkSeparators(m) {
  const n = m.length;
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7][i], false);
    assert.equal(m[i][7], false);
    assert.equal(m[7][n - 1 - i], false);
    assert.equal(m[i][n - 8], false);
    assert.equal(m[n - 8][i], false);
    assert.equal(m[n - 1 - i][7], false);
  }
}

for (const { text, version } of PAYLOADS) {
  const label = text.length > 40 ? `${text.slice(0, 34)}... (${text.length} chars)` : text;

  test(`matches python for every forced mask: ${label}`, { skip: pySkip }, () => {
    for (let mask = 0; mask <= 7; mask++) {
      const want = pythonMatrix(text, mask);
      const got = qrMatrixForced(text, mask);
      assert.deepEqual(got, want, `payload ${JSON.stringify(label)} mask ${mask}`);
    }
  });

  test(`matches python automatic mask choice: ${label}`, { skip: pySkip }, () => {
    const want = pythonMatrix(text, -1);
    const got = qrMatrix(text);
    assert.deepEqual(got, want, `payload ${JSON.stringify(label)} auto mask`);
  });

  test(`matrix shape and function patterns: ${label}`, () => {
    const m = qrMatrix(text);
    const n = m.length;
    for (const row of m) {
      assert.equal(row.length, n, "matrix is square");
      for (const v of row) assert.equal(typeof v, "boolean");
    }
    const v = (n - 17) / 4;
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 10, `size ${n} implies version 1-10`);
    assert.equal(n, 17 + 4 * v);
    if (version !== null) {
      assert.equal(v, version, "smallest fitting version chosen");
      assert.equal(chooseCapacity(v - 1) < utf8Len(text), true, "would not fit one version smaller");
    }
    checkFinder(m, 0, 0);
    checkFinder(m, 0, n - 7);
    checkFinder(m, n - 7, 0);
    checkSeparators(m);
    for (let i = 8; i < n - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, "horizontal timing");
      assert.equal(m[i][6], i % 2 === 0, "vertical timing");
    }
    assert.equal(m[n - 8][8], true, "dark module");
  });
}

// Byte mode capacity at level M for versions 1-10; index 0 means version 0.
function chooseCapacity(v) {
  return [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213][v];
}

test("mask disagreement would be caught: forced masks differ from each other", () => {
  const a = qrMatrixForced("S", 0);
  const b = qrMatrixForced("S", 5);
  assert.notDeepEqual(a, b);
});

test("qrMatrixForced rejects bad masks", () => {
  assert.throws(() => qrMatrixForced("S", 8));
  assert.throws(() => qrMatrixForced("S", -1));
  assert.throws(() => qrMatrixForced("S", 2.5));
});

test("oversized payload throws instead of emitting garbage", () => {
  assert.throws(() => qrMatrix("z".repeat(214)));
});

test("svg structure: quiet zone, rect count, only safe tags", () => {
  const text = `https://starling.pages.dev/#j=${SECRET_A}`;
  const m = qrMatrix(text);
  const n = m.length;
  const svg = qrSvg(text);
  assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}"`));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const rects = svg.match(/<rect /g) || [];
  assert.equal(rects.length, dark + 1, "one rect per dark module plus background");
  const leftovers = svg.replace(/<\/?(?:svg|g|rect)\b[^>]*>/g, "");
  assert.equal(leftovers, "", "nothing outside svg/g/rect tags");
});

test("svg accepts valid colors and falls back on anything else", () => {
  const ok = qrSvg("S", { dark: "#123abc", light: "#FFF" });
  assert.ok(ok.includes('fill="#123abc"'));
  assert.ok(ok.includes('fill="#FFF"'));
  const ok8 = qrSvg("S", { dark: "#AABBCCDD", light: "#0f0f0f" });
  assert.ok(ok8.includes('fill="#AABBCCDD"'));
  assert.ok(ok8.includes('fill="#0f0f0f"'));

  const bad = qrSvg("S", { dark: '"><script>alert(1)</script>', light: "red" });
  assert.ok(bad.includes('fill="#000000"'), "invalid dark falls back");
  assert.ok(bad.includes('fill="#ffffff"'), "invalid light falls back");
  assert.ok(!bad.includes("script"));
  assert.ok(!bad.includes("red"));
  assert.ok(!bad.includes("&"));

  for (const c of ["#12", "#123456789", "123456", "#12g456", "url(#x)", ""]) {
    const out = qrSvg("S", { dark: c, light: c });
    assert.ok(out.includes('fill="#000000"'), `rejects ${JSON.stringify(c)}`);
    assert.ok(out.includes('fill="#ffffff"'), `rejects ${JSON.stringify(c)}`);
  }
});

test("svg never embeds the encoded text", () => {
  const hostile = '<script>steal()</script>"onload="evil()';
  const svg = qrSvg(hostile);
  assert.ok(!svg.includes("steal"));
  assert.ok(!svg.includes("evil"));
  assert.ok(!svg.includes("onload"));
});
