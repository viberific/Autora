/**
 * The image surface's engine: every parameter of src/lib/panacea/surfaces.ts IMAGE_PARAMS applied live on the GPU
 * (WebGL 1, one fragment shader), and what the panels read off the picture: its histogram, a palette of its own colours,
 * and the "auto" settings. Export renders the same shader at the picture's full size.
 *
 * Geometry (aspect, straighten, a quarter turn, flips, zoom) is one matrix from the output's corners to the source's,
 * worked out so a straightened crop never shows past the picture's edge.
 */
import type { Value } from "../../lib/panacea/atoms";
import { LOOKS } from "../../lib/panacea/surfaces";

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_img;
uniform sampler2D u_lut;
uniform mat3 u_geo;
uniform vec2 u_texel;
uniform float u_aspect;
uniform float u_split;
uniform float u_exposure, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_vibrance, u_saturation, u_clarity, u_fade, u_vignette, u_grain;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 src = (u_geo * vec3(v_uv, 1.0)).xy;
  if (src.x < 0.0 || src.y < 0.0 || src.x > 1.0 || src.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec3 c = texture2D(u_img, src).rgb;
  if (u_split >= 0.0 && v_uv.x < u_split) { gl_FragColor = vec4(c, 1.0); return; }

  vec3 lin = pow(c, vec3(2.2)) * exp2(u_exposure);
  lin *= vec3(1.0 + 0.28 * u_temp + 0.08 * u_tint, 1.0 - 0.16 * u_tint, 1.0 - 0.28 * u_temp + 0.08 * u_tint);
  c = pow(max(lin, vec3(0.0)), vec3(1.0 / 2.2));

  if (u_clarity != 0.0) {
    vec2 r = u_texel * 6.0;
    vec3 blur = (texture2D(u_img, src + vec2(r.x, 0.0)).rgb + texture2D(u_img, src - vec2(r.x, 0.0)).rgb +
                 texture2D(u_img, src + vec2(0.0, r.y)).rgb + texture2D(u_img, src - vec2(0.0, r.y)).rgb +
                 texture2D(u_img, src + r).rgb + texture2D(u_img, src - r).rgb +
                 texture2D(u_img, src + vec2(r.x, -r.y)).rgb + texture2D(u_img, src + vec2(-r.x, r.y)).rgb) / 8.0;
    vec3 orig = texture2D(u_img, src).rgb;
    float mid = 1.0 - abs(luma(orig) - 0.5) * 2.0;
    c += (orig - blur) * u_clarity * 1.6 * mid;
  }

  float L = luma(c);
  c += vec3(u_shadows * 0.32 * (1.0 - smoothstep(0.0, 0.55, L)));
  c += vec3(u_highlights * 0.32 * smoothstep(0.45, 1.0, L));
  float bp = -u_blacks * 0.12;
  float wp = 1.0 - u_whites * 0.12;
  c = (c - bp) / max(0.05, wp - bp);
  c = (c - 0.5) * (1.0 + u_contrast * 0.85) + 0.5;

  L = luma(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(L), c, 1.0 + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0)));
  c = mix(vec3(luma(c)), c, 1.0 + u_saturation);

  c = clamp(c, 0.0, 1.0);
  c = vec3(texture2D(u_lut, vec2(c.r, 0.5)).r, texture2D(u_lut, vec2(c.g, 0.5)).r, texture2D(u_lut, vec2(c.b, 0.5)).r);

  c = mix(c, c * 0.82 + 0.1, u_fade);
  vec2 d = (v_uv - 0.5) * vec2(u_aspect, 1.0) / max(1.0, u_aspect);
  c *= 1.0 - u_vignette * smoothstep(0.25, 0.8, length(d) * 1.2);
  c += (hash(v_uv * 1024.0) - 0.5) * u_grain * 0.16;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

type Mat3 = [number, number, number, number, number, number, number, number, number];
/** Row-major a*b for 3x3 affine matrices. */
const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k]! * b[k * 3 + c]!;
  return o;
};
const T = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const S = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1];
const R = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

const num = (v: Value | undefined, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The output's aspect, width over height, for a picture of `w`x`h` and these settings. */
export function outputAspect(params: Record<string, Value>, w: number, h: number): number {
  const quarter = Number(params.rotate ?? "0") % 180 !== 0;
  const src = quarter ? h / w : w / h;
  const a = String(params.aspect ?? "original");
  const m = /^(\d+):(\d+)$/.exec(a);
  return m ? Number(m[1]) / Number(m[2]) : src;
}

/** The matrix from output uv to source uv. */
function geometry(params: Record<string, Value>, w: number, h: number): Mat3 {
  const quarter = (Number(params.rotate ?? "0") / 90) % 4;
  const ar = quarter % 2 ? h / w : w / h;
  const aout = outputAspect(params, w, h);
  const th = (num(params.straighten) * Math.PI) / 180;
  const zoom = Math.max(1, num(params.zoom, 1));
  const cs = Math.abs(Math.cos(th));
  const sn = Math.abs(Math.sin(th));
  const hh = Math.min(ar / (cs * aout + sn), 1 / (sn * aout + cs)) / zoom;
  const fx = params.flip_h === true ? -1 : 1;
  const fy = params.flip_v === true ? -1 : 1;
  // Output uv -> flipped -> the box in the rotated-frame's units -> rotated-frame uv -> the picture's own uv.
  let m: Mat3 = mul(T(0.5, 0.5), mul(S(fx, fy), T(-0.5, -0.5)));
  m = mul(mul(T(0.5, 0.5), mul(S(1 / ar, 1), mul(R(th), S(aout * hh, hh)))), mul(T(-0.5, -0.5), m));
  m = mul(mul(T(0.5, 0.5), mul(R((-quarter * Math.PI) / 2), T(-0.5, -0.5))), m);
  return m;
}

/** A curve through its points, as 256 levels (monotone cubic, so it never overshoots). */
function curveLut(points: Value | undefined): Uint8Array {
  const pts = (Array.isArray(points) ? (points as Array<[number, number]>) : [[0, 0], [1, 1]]).slice().sort((a, b) => a[0] - b[0]);
  const out = new Uint8Array(256 * 4);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / Math.max(1e-6, xs[i + 1]! - xs[i]!));
  const m: number[] = [d[0] ?? 0];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2] ?? 0);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]!) k++;
    const x0 = xs[k]!;
    const x1 = xs[k + 1] ?? 1;
    const hgt = Math.max(1e-6, x1 - x0);
    const t = Math.min(1, Math.max(0, (x - x0) / hgt));
    const y = n < 2 ? x
      : (2 * t ** 3 - 3 * t ** 2 + 1) * ys[k]! + (t ** 3 - 2 * t ** 2 + t) * hgt * m[k]! + (-2 * t ** 3 + 3 * t ** 2) * (ys[k + 1] ?? 1) + (t ** 3 - t ** 2) * hgt * m[k + 1]!;
    const v = Math.round(Math.min(1, Math.max(0, x <= xs[0]! ? ys[0]! : x >= xs[n - 1]! ? ys[n - 1]! : y)) * 255);
    out.set([v, v, v, 255], i * 4);
  }
  return out;
}

/** The parameters with the look mixed in, at its strength: what the shader is given. */
function effective(params: Record<string, Value>): Record<string, number> {
  const look = LOOKS[String(params.look ?? "none")]?.set ?? {};
  const amount = num(params.look_amount, 100) / 100;
  const get = (k: string) => num(params[k]) + (look[k] ?? 0) * amount;
  return {
    exposure: get("exposure"), contrast: get("contrast") / 100, highlights: get("highlights") / 100, shadows: get("shadows") / 100,
    whites: get("whites") / 100, blacks: get("blacks") / 100, temp: get("temperature") / 100, tint: get("tint") / 100,
    vibrance: get("vibrance") / 100, saturation: get("saturation") / 100, clarity: get("clarity") / 100,
    fade: Math.max(0, get("fade")) / 100, vignette: Math.max(0, get("vignette")) / 100, grain: Math.max(0, get("grain")) / 100,
  };
}

export class ImageEngine {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private lut: WebGLTexture;
  private lutKey = "";
  private loc = new Map<string, WebGLUniformLocation | null>();
  w = 0;
  h = 0;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false }) as WebGLRenderingContext | null;
    if (!gl) throw new Error("This browser cannot draw the picture (no WebGL).");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "program");
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.tex = texture();
    this.lut = texture();
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }

  setImage(img: TexImageSource & { width: number; height: number }) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.w = img.width;
    this.h = img.height;
  }

  /** Draw with these settings at the canvas's size. `split` (0..1) shows the original left of it. */
  render(params: Record<string, Value>, split: number | null) {
    const gl = this.gl;
    if (!this.w) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    const key = JSON.stringify(params.curve ?? null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    if (key !== this.lutKey) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, curveLut(params.curve));
      this.lutKey = key;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u("u_img"), 0);
    gl.uniform1i(this.u("u_lut"), 1);
    const g = geometry(params, this.w, this.h);
    // WebGL takes column-major.
    gl.uniformMatrix3fv(this.u("u_geo"), false, [g[0], g[3], g[6], g[1], g[4], g[7], g[2], g[5], g[8]]);
    gl.uniform2f(this.u("u_texel"), 1 / this.w, 1 / this.h);
    gl.uniform1f(this.u("u_aspect"), this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform1f(this.u("u_split"), split ?? -1);
    const e = effective(params);
    for (const [k, v] of Object.entries(e)) gl.uniform1f(this.u(`u_${k}`), v);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Red, green, blue and luminance in 64 bins each, read off what was last drawn. */
  histogram(): number[][] {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const bins = [new Array(64).fill(0), new Array(64).fill(0), new Array(64).fill(0), new Array(64).fill(0)] as number[][];
    const step = Math.max(1, Math.floor((w * h) / 40000)) * 4;
    for (let i = 0; i < px.length; i += step) {
      if (px[i + 3] === 0) continue;
      const r = px[i]!; const g = px[i + 1]!; const b = px[i + 2]!;
      bins[0]![r >> 2]++; bins[1]![g >> 2]++; bins[2]![b >> 2]++;
      bins[3]![Math.min(63, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b) >> 2)]++;
    }
    return bins;
  }
}

/** A picture's pixels, small: for auto settings and the palette. */
function sample(img: HTMLImageElement, size = 96): Uint8ClampedArray | null {
  const c = document.createElement("canvas");
  const k = size / Math.max(img.naturalWidth, img.naturalHeight);
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

/** Exposure, contrast, whites, blacks and white balance worked out from the picture itself. */
export function autoSettings(img: HTMLImageElement): Record<string, number> {
  const px = sample(img, 128);
  if (!px) return {};
  const lum: number[] = [];
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    lum.push((0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255);
    r += px[i]!; g += px[i + 1]!; b += px[i + 2]!; n++;
  }
  lum.sort((x, y) => x - y);
  const at = (q: number) => lum[Math.min(lum.length - 1, Math.floor(q * lum.length))]!;
  const mean = lum.reduce((a, v) => a + v, 0) / lum.length;
  const lo = at(0.02);
  const hi = at(0.98);
  const round = (v: number, step: number) => Math.round(v / step) * step;
  return {
    exposure: round(Math.max(-1.5, Math.min(1.5, Math.log2(0.46 / Math.max(0.02, mean)))), 0.05),
    contrast: Math.round(Math.max(-20, Math.min(35, (0.8 - (hi - lo)) * 60))),
    whites: Math.round(Math.max(-30, Math.min(40, (0.96 - hi) * 120))),
    blacks: Math.round(Math.max(-40, Math.min(30, -lo * 120))),
    temperature: Math.round(Math.max(-40, Math.min(40, ((b - r) / n / 255) * 160))),
    tint: Math.round(Math.max(-30, Math.min(30, (((r + b) / 2 - g) / n / 255) * 120))),
  };
}

/** The picture's own colours: five, by a few rounds of k-means over a small copy. */
export function paletteOf(img: HTMLImageElement): string[] {
  const px = sample(img, 64);
  if (!px) return [];
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < px.length; i += 4) pts.push([px[i]!, px[i + 1]!, px[i + 2]!]);
  const k = 5;
  let centres = Array.from({ length: k }, (_, i) => pts[Math.floor(((i + 0.5) / k) * pts.length)]!.slice() as [number, number, number]);
  for (let round = 0; round < 8; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let best = 0; let bd = Infinity;
      centres.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      const s = sums[best]!; s[0]! += p[0]; s[1]! += p[1]; s[2]! += p[2]; s[3]! += 1;
    }
    centres = centres.map((c, i) => { const s = sums[i]!; return s[3] ? [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] as [number, number, number] : c; });
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return [...new Set(centres.map((c) => `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`))];
}

/** The picture with these settings at its full size (up to 8192 on a side), as a file. */
export async function renderFull(img: HTMLImageElement, params: Record<string, Value>, format: "png" | "jpeg"): Promise<Blob> {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const aout = outputAspect(params, w, h);
  const quarter = Number(params.rotate ?? "0") % 180 !== 0;
  const srcH = quarter ? w : h;
  const zoom = Math.max(1, num(params.zoom, 1));
  let outH = Math.round(srcH / zoom);
  let outW = Math.round(outH * aout);
  const k = Math.min(1, 8192 / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * k));
  outH = Math.max(1, Math.round(outH * k));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const engine = new ImageEngine(canvas);
  engine.setImage(img);
  engine.render(params, null);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be made."))), `image/${format}`, 0.92));
}

// ------------------------------------------------------- what panels read --

type Stats = { hist: number[][] | null; palette: string[] };
const stats = new Map<string, Stats>();
const watchers = new Set<() => void>();

export function imageStats(surface: string): Stats {
  return stats.get(surface) ?? { hist: null, palette: [] };
}

export function setImageStats(surface: string, patch: Partial<Stats>) {
  stats.set(surface, { ...imageStats(surface), ...patch });
  for (const w of watchers) w();
}

export function onImageStats(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}
