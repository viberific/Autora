const fs = require('fs'), zlib = require('zlib');
fs.mkdirSync('art', { recursive: true });
function png(w, h, fn, file) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b, a] = fn(x + 0.5, y + 0.5); const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = Math.max(0, Math.min(255, r)); raw[o + 1] = Math.max(0, Math.min(255, g)); raw[o + 2] = Math.max(0, Math.min(255, b)); raw[o + 3] = Math.max(0, Math.min(255, a * 255)); } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const sm = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const cov = (d) => 1 - sm(-0.7, 0.7, d);                      // 1 inside (d<0), antialiased edge
const rbox = (px, py, cx, cy, hw, hh, r) => { const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const seg = (px, py, ax, ay, bx, by) => { const abx = bx - ax, aby = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby))); return Math.hypot(px - ax - abx * t, py - ay - aby * t); };
const over = (dst, src) => { const a = src[3] + dst[3] * (1 - src[3]); if (a <= 0) return [0, 0, 0, 0]; return [0, 1, 2].map(i => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a).concat([a]); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---- the ball: an orange ball with a shine
png(44, 44, (x, y) => { const d = Math.hypot(x - 22, y - 22) - 20; const a = cov(d); if (a <= 0) return [0, 0, 0, 0];
  const t = Math.hypot(x - 16, y - 15) / 24; let c = mix([255, 214, 90], [226, 96, 20], Math.min(1, t));
  if (d > -2.2) c = mix(c, [120, 40, 8], 0.8); const sh = 1 - sm(0, 6, Math.hypot(x - 14, y - 13)); c = mix(c, [255, 255, 255], sh * 0.75); return [...c, a]; }, 'art/ball.png');

// ---- the window pane (wooden frame + glass), intact and cracked
const GW = 380, GH = 440, FR = 14;
function cracks(level) {
  const lines = [];
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const centre = [190, 215];
  const arms = level === 0 ? 0 : level === 1 ? 6 : 13;
  for (let i = 0; i < arms; i++) {
    let ang = (i / arms) * Math.PI * 2 + rnd() * 0.4, [px, py] = centre; const len = level === 1 ? 70 + rnd() * 80 : 110 + rnd() * 140;
    for (let s = 0, d = 0; d < len; s++) { const step = 18 + rnd() * 14; ang += (rnd() - 0.5) * 0.7; const nx = px + Math.cos(ang) * step, ny = py + Math.sin(ang) * step; lines.push([px, py, nx, ny, level === 1 ? 1.4 : 1.7]); px = nx; py = ny; d += step; }
  }
  if (level === 2) for (const r of [38, 74, 118]) { const n = 14; for (let i = 0; i < n; i++) { const a0 = (i / n) * Math.PI * 2 + rnd() * 0.3, a1 = a0 + (Math.PI * 2 / n) * (0.6 + rnd() * 0.4); lines.push([centre[0] + Math.cos(a0) * r, centre[1] + Math.sin(a0) * r, centre[0] + Math.cos(a1) * (r + rnd() * 10), centre[1] + Math.sin(a1) * (r + rnd() * 10), 1.2]); } }
  return lines;
}
function pane(level, file) {
  const L = cracks(level);
  png(GW, GH, (x, y) => {
    let px = [0, 0, 0, 0];
    const outer = cov(rbox(x, y, GW / 2, GH / 2, GW / 2 - 0.5, GH / 2 - 0.5, 10));
    if (outer <= 0) return px;
    const inner = cov(rbox(x, y, GW / 2, GH / 2, GW / 2 - FR, GH / 2 - FR, 4));
    // wooden frame
    const grain = 0.5 + 0.5 * Math.sin(x * 0.35 + Math.sin(y * 0.06) * 3 + y * 0.02);
    const wood = mix([116, 76, 42], [150, 104, 62], grain * 0.8); const bevel = Math.min(1, Math.max(0, (Math.min(x, y, GW - x, GH - y)) / FR));
    px = [...mix(wood, [196, 150, 98], (1 - bevel) * 0.45), outer * (1 - inner)];
    // glass: pale blue tint, brighter toward the corner, with two diagonal glints
    const gt = (x + y) / (GW + GH);
    let g = mix([120, 200, 240], [190, 236, 255], 1 - gt); let ga = 0.30 + 0.16 * (1 - gt);
    const glint = (cx, w) => 1 - sm(0, w, Math.abs((x - y * 0.55) - cx));
    g = mix(g, [255, 255, 255], Math.max(glint(70, 14), glint(125, 6)) * 0.7);
    ga += Math.max(glint(70, 14), glint(125, 6)) * 0.3;
    px = over(px, [...g, ga * inner]);
    // inner shadow line at the frame's edge
    const edge = cov(Math.abs(rbox(x, y, GW / 2, GH / 2, GW / 2 - FR, GH / 2 - FR, 4)) - 1.1) * 0.5; px = over(px, [60, 40, 24, edge]);
    for (const [ax, ay, bx, by, w] of L) { const d = seg(x, y, ax, ay, bx, by) - w; const a = cov(d) * inner; if (a > 0) px = over(px, [255, 255, 255, a * 0.95]); }
    return px;
  }, file);
}
pane(0, 'art/glass0.png'); pane(1, 'art/glass1.png'); pane(2, 'art/glass2.png');

// ---- a shard of glass (triangle)
png(34, 34, (x, y) => { const A = [4, 6], B = [30, 12], C = [14, 30]; const sgn = (p, a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const p = [x, y]; const d1 = sgn(p, A, B), d2 = sgn(p, B, C), d3 = sgn(p, C, A); const inside = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  const dist = Math.min(seg(x, y, ...A, ...B), seg(x, y, ...B, ...C), seg(x, y, ...C, ...A)); const a = inside ? 1 : cov(dist - 0.9);
  if (a <= 0) return [0, 0, 0, 0]; const edge = 1 - sm(0, 3, dist); const t = (x + y) / 60; return [...mix(mix([170, 225, 245], [235, 250, 255], t), [255, 255, 255], edge * 0.9), (0.62 + edge * 0.35) * a]; }, 'art/shard.png');

// ---- the cannon (points up): a barrel on a round base
png(96, 124, (x, y) => { let px = [0, 0, 0, 0];
  const barrel = cov(rbox(x, y, 48, 52, 22, 48, 8)); const bt = 1 - sm(0, 44, Math.abs(x - 38));
  if (barrel > 0) px = over(px, [...mix([58, 66, 82], [150, 164, 186], bt), barrel]);
  const mouth = cov(rbox(x, y, 48, 8, 27, 8, 5)); if (mouth > 0) px = over(px, [...mix([40, 46, 60], [110, 122, 142], 1 - sm(0, 40, Math.abs(x - 36))), mouth]);
  const base = cov(rbox(x, y, 48, 102, 44, 20, 14)); if (base > 0) px = over(px, [...mix([40, 44, 58], [96, 108, 128], 1 - sm(86, 124, y)), base]);
  const hub = cov(Math.hypot(x - 48, y - 94) - 15); if (hub > 0) px = over(px, [...mix([214, 170, 70], [255, 226, 130], 1 - sm(0, 20, Math.hypot(x - 43, y - 89))), hub]);
  return px; }, 'art/cannon.png');

// ---- buttons
function button(w, h, color, glyph, file, round) {
  png(w, h, (x, y) => { const r = round ? Math.min(w, h) / 2 : 22; const d = rbox(x, y, w / 2, h / 2, w / 2 - 2, h / 2 - 2, r); const a = cov(d); if (a <= 0) return [0, 0, 0, 0];
    let c = mix(color.map(v => Math.min(255, v + 46)), color.map(v => v * 0.72), y / h); const rim = 1 - sm(0, 4, -d); c = mix(c, [255, 255, 255], rim * 0.5);
    const gl = glyph(x, y); if (gl > 0) c = mix(c, [255, 255, 255], gl); return [...c, 0.94 * a]; }, file);
}
const tri = (x, y, cx, cy, s, dir) => { const px = (x - cx) * dir, py = y - cy; const inside = px > -s * 0.75 && Math.abs(py) < (s * 0.95) * (1 - (px + s * 0.75) / (s * 1.5)) + 0; return inside ? cov(-(Math.min(px + s * 0.75, (s * 0.95) * (1 - (px + s * 0.75) / (s * 1.5)) - Math.abs(py)) * 0.9)) : 0; };
button(130, 130, [66, 110, 190], (x, y) => tri(x, y, 65, 65, 34, 1), 'art/btn_right.png');
button(130, 130, [66, 110, 190], (x, y) => tri(x, y, 65, 65, 34, -1), 'art/btn_left.png');
button(150, 150, [214, 62, 54], (x, y) => { const d = Math.hypot(x - 75, y - 75); return Math.max(cov(d - 26) * (1 - cov(d - 15)), cov(d - 9) * 1) * 0.95 + 0 * (d > 30); }, 'art/btn_fire.png', true);
button(300, 84, [58, 160, 98], () => 0, 'art/btn_again.png');
console.log(fs.readdirSync('art').map(f => f + ' ' + fs.statSync('art/' + f).size).join('\n'));
