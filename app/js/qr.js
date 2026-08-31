// QR encoding for invite links. Placeholder implementation: renders a labeled
// frame instead of a scannable code. The real byte-mode encoder replaces this
// file and keeps the exact same exports.

// Returns an NxN array of booleans (true = dark module), no quiet zone.
export function qrMatrix(text) {
  const n = 33;
  const m = Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => (x + y + text.length) % 3 === 0),
  );
  return m;
}

// Renders the matrix as an SVG string with a 4-module quiet zone.
export function qrSvg(text, opts = {}) {
  const dark = opts.dark || "#000000";
  const light = opts.light || "#ffffff";
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
