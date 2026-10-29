/**
 * The image engine's renderer: every develop setting of src/lib/panacea/surfaces.ts and src/lib/panacea/image.ts applied
 * live on the GPU, in two passes.
 *
 *   1. **Develop**, at the photo's own (working) size: light, colour, detail (clarity, sharpen, blur, dehaze), colour by
 *      hue, grading, the tone curve, fade; then each local adjustment's own settings, only where its mask is (up to six,
 *      one texture each). Into a texture.
 *   2. **Present**, at the card's size: the geometry (aspect, straighten, a quarter turn, flips, zoom, the free crop: one
 *      matrix from the output's corners to the photo's), vignette and grain, and Before / after.
 *
 * The layers are put together before this (compose.ts), so the develop settings act on the whole picture. And what the
 * panels read off the picture: its histogram, a palette of its own colours, and the "auto" settings.
 */
import type { Value } from "../../lib/panacea/atoms";
import { geometry, HUE_NAMES, MASK_PARAMS, MAX_MASKS, outputAspect } from "../../lib/panacea/image";
import { LOOKS } from "../../lib/panacea/surfaces";


const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const MP = MASK_PARAMS.length;

/** The develop pass, at the photo's size: v_uv is the photo's own uv. The masks' code is unrolled, one block each. */
const DEVELOP = `${PRECISION}
varying vec2 v_uv;
uniform sampler2D u_img;
uniform sampler2D u_lut;
${Array.from({ length: MAX_MASKS }, (_, i) => `uniform sampler2D u_m${i};`).join("\n")}
uniform float u_mp[${MAX_MASKS * MP}];
uniform float u_masks;
uniform vec2 u_texel;
uniform float u_exposure, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_vibrance, u_saturation, u_clarity, u_fade;
uniform float u_sharpen, u_blur, u_dehaze;
uniform float u_hh[8], u_hs[8], u_hl[8];
uniform vec3 u_gs, u_gh;
uniform float u_gbal;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5; float d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y < 1e-5) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2(p, q, h.x + 1.0 / 3.0), hue2(p, q, h.x), hue2(p, q, h.x - 1.0 / 3.0));
}

/** The picture around a point, blurred over a disc of radius r (in uv): sixteen taps on a golden-angle spiral. */
vec3 around(vec2 src, float r) {
  vec3 acc = texture2D(u_img, src).rgb;
  for (int i = 1; i < 16; i++) {
    float f = float(i);
    float a = f * 2.39996;
    vec2 o = vec2(cos(a), sin(a)) * sqrt(f / 15.0) * r;
    acc += texture2D(u_img, src + o * vec2(u_texel.y / u_texel.x, 1.0)).rgb;
  }
  return acc / 16.0;
}

/** Light and colour: what the whole picture and each local adjustment share. */
vec3 light(vec3 c, vec2 src, float expo, float contrast, float hi, float sh, float temp, float tint, float vib, float sat, float clarity, float blur) {
  if (blur > 0.0) c = mix(c, around(src, blur * 0.02), min(1.0, blur * 1.5));
  vec3 lin = pow(max(c, vec3(0.0)), vec3(2.2)) * exp2(expo);
  lin *= vec3(1.0 + 0.28 * temp + 0.08 * tint, 1.0 - 0.16 * tint, 1.0 - 0.28 * temp + 0.08 * tint);
  c = pow(max(lin, vec3(0.0)), vec3(1.0 / 2.2));
  if (clarity != 0.0) {
    vec3 b = around(src, 0.006);
    float mid = 1.0 - abs(luma(c) - 0.5) * 2.0;
    c += (texture2D(u_img, src).rgb - b) * clarity * 1.6 * mid;
  }
  float L = luma(c);
  c += vec3(sh * 0.32 * (1.0 - smoothstep(0.0, 0.55, L)));
  c += vec3(hi * 0.32 * smoothstep(0.45, 1.0, L));
  c = (c - 0.5) * (1.0 + contrast * 0.85) + 0.5;
  L = luma(c);
  float s = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(L), c, 1.0 + vib * (1.0 - clamp(s, 0.0, 1.0)));
  c = mix(vec3(luma(c)), c, 1.0 + sat);
  return c;
}

void main() {
  vec4 src4 = texture2D(u_img, v_uv);
  vec3 c = src4.rgb;
  if (u_sharpen > 0.0) c += (c - around(v_uv, 0.0025)) * u_sharpen * 2.2;
  if (u_dehaze > 0.0) c = (c - 0.12 * u_dehaze) / (1.0 - 0.12 * u_dehaze);
  else if (u_dehaze < 0.0) c = mix(c, vec3(0.78), -u_dehaze * 0.45);
  c = light(c, v_uv, u_exposure, u_contrast + max(0.0, u_dehaze) * 0.15, u_highlights, u_shadows, u_temp, u_tint, u_vibrance, u_saturation + max(0.0, u_dehaze) * 0.2, u_clarity, u_blur);
  float bp = -u_blacks * 0.12;
  float wp = 1.0 - u_whites * 0.12;
  c = (c - bp) / max(0.05, wp - bp);
  c = clamp(c, 0.0, 1.0);

  // Colour by hue: eight bands round the wheel, each a weight that falls off to its neighbours.
  vec3 h = rgb2hsl(c);
  if (h.y > 0.0) {
    float dh = 0.0; float ds = 0.0; float dl = 0.0;
    float centres[8];
    centres[0] = 0.0; centres[1] = 30.0 / 360.0; centres[2] = 60.0 / 360.0; centres[3] = 120.0 / 360.0;
    centres[4] = 180.0 / 360.0; centres[5] = 240.0 / 360.0; centres[6] = 280.0 / 360.0; centres[7] = 320.0 / 360.0;
    for (int i = 0; i < 8; i++) {
      float d = abs(h.x - centres[i]);
      d = min(d, 1.0 - d);
      float w = max(0.0, 1.0 - d / 0.09);
      dh += u_hh[i] * w; ds += u_hs[i] * w; dl += u_hl[i] * w;
    }
    h.x = fract(h.x + dh * 0.085);
    h.y = clamp(h.y * (1.0 + ds), 0.0, 1.0);
    h.z = clamp(h.z + dl * 0.22 * h.y, 0.0, 1.0);
    c = hsl2rgb(h);
  }

  c = vec3(texture2D(u_lut, vec2(c.r, 0.5)).r, texture2D(u_lut, vec2(c.g, 0.5)).r, texture2D(u_lut, vec2(c.b, 0.5)).r);

  // Grading: a tint in the shadows and one in the highlights, the balance moving where they meet.
  float L = luma(c);
  float split = 0.5 + u_gbal * 0.3;
  c += u_gs * (1.0 - smoothstep(0.0, split, L)) + u_gh * smoothstep(split, 1.0, L);
  c = mix(c, c * 0.82 + 0.1, u_fade);

  // Each local adjustment, only where its mask is.
${Array.from({ length: MAX_MASKS }, (_, i) => {
  const at = (k: number) => `u_mp[${i * MP + k}]`;
  return `  if (u_masks > ${i}.5) {
    float m = texture2D(u_m${i}, v_uv).r * ${at(MP - 1)};
    if (m > 0.0) c = mix(c, light(c, v_uv, ${at(0)}, ${at(1)}, ${at(2)}, ${at(3)}, ${at(4)}, ${at(5)}, ${at(6)}, ${at(7)}, ${at(8)}, ${at(9)}), m);
  }`;
}).join("\n")}
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), src4.a);
}`;

/** The present pass: the developed picture through the geometry, with vignette, grain and Before / after. */
const PRESENT = `${PRECISION}
varying vec2 v_uv;
uniform sampler2D u_dev;
uniform sampler2D u_orig;
uniform mat3 u_geo;
uniform float u_aspect;
uniform float u_split;
uniform float u_vignette, u_grain;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 src = (u_geo * vec3(v_uv, 1.0)).xy;
  if (src.x < 0.0 || src.y < 0.0 || src.x > 1.0 || src.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  if (u_split >= 0.0 && v_uv.x < u_split) { gl_FragColor = texture2D(u_orig, src); return; }
  // Develop drew into its texture with its first row at the bottom, as GL keeps a framebuffer.
  vec4 c = texture2D(u_dev, vec2(src.x, 1.0 - src.y));
  vec2 d = (v_uv - 0.5) * vec2(u_aspect, 1.0) / max(1.0, u_aspect);
  c.rgb *= 1.0 - u_vignette * smoothstep(0.25, 0.8, length(d) * 1.2);
  c.rgb += (hash(v_uv * 1024.0) - 0.5) * u_grain * 0.16;
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
}`;

const num = (v: Value | undefined, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

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

/** A hue (degrees) at full colour, less grey, as a tint to add. */
function tintOf(hue: number, amount: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const k = (amount / 100) * 0.18;
  return [(r - 0.5) * k, (g - 0.5) * k, (b - 0.5) * k];
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
    sharpen: num(params.sharpen) / 100, blur: num(params.blur) / 100, dehaze: num(params.dehaze) / 100, gbal: num(params["grade.balance"]) / 100,
  };
}

/** A local adjustment's settings, in the order the shader reads them. */
function maskUniforms(params: Record<string, Value>, id: string): number[] {
  return MASK_PARAMS.map((p) => {
    const v = num(params[`mask.${id}.${p.name}`], p.default as number);
    return p.name === "exposure" ? v : v / 100;
  });
}

/** One local adjustment as the renderer takes it: its mask at the working size, and its id (for its settings). */
export interface MaskLayer {
  id: string;
  data: Uint8Array;
  w: number;
  h: number;
  /** Changes when the mask does, so it is uploaded only then. */
  key: string;
}

type GL = WebGLRenderingContext;

function program(gl: GL, frag: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(prog, 0, "a_pos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "program");
  return prog;
}

export class ImageEngine {
  private gl: GL;
  private dev: WebGLProgram;
  private present: WebGLProgram;
  private tex: WebGLTexture;
  private orig: WebGLTexture | null = null;
  private lut: WebGLTexture;
  private out: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private masks: Array<{ id: string; tex: WebGLTexture; key: string }> = [];
  private lutKey = "";
  private loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** The working size of the picture (what develop renders at). */
  w = 0;
  h = 0;
  /** The largest texture this GPU takes. */
  readonly max: number;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: true }) as GL | null;
    if (!gl) throw new Error("This browser cannot draw the picture (no WebGL).");
    this.gl = gl;
    this.max = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    this.dev = program(gl, DEVELOP);
    this.present = program(gl, PRESENT);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.tex = this.texture();
    this.lut = this.texture();
    this.out = this.texture();
    this.fbo = gl.createFramebuffer()!;
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  private u(prog: WebGLProgram, name: string) {
    let m = this.loc.get(prog);
    if (!m) this.loc.set(prog, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  /** The picture to develop (the layers put together), and the original for Before / after (the photo alone). */
  setImage(img: TexImageSource & { width: number; height: number }, original?: TexImageSource) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (original && original !== img) {
      this.orig ??= this.texture();
      gl.bindTexture(gl.TEXTURE_2D, this.orig);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, original);
    } else if (this.orig) { gl.deleteTexture(this.orig); this.orig = null; }
    if (img.width !== this.w || img.height !== this.h) {
      this.w = img.width;
      this.h = img.height;
      gl.bindTexture(gl.TEXTURE_2D, this.out);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
  }

  /** The local adjustments' masks, uploaded when they change. */
  setMasks(list: MaskLayer[]) {
    const gl = this.gl;
    const next: typeof this.masks = [];
    for (const m of list.slice(0, MAX_MASKS)) {
      const have = this.masks.find((x) => x.id === m.id);
      const tex = have?.tex ?? this.texture();
      if (have?.key !== m.key) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, m.w, m.h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, m.data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      }
      next.push({ id: m.id, tex, key: m.key });
    }
    for (const old of this.masks) if (!next.some((x) => x.tex === old.tex)) gl.deleteTexture(old.tex);
    this.masks = next;
  }

  /** Draw with these settings at the canvas's size. `split` (0..1) shows the original left of it; `uncropped` leaves the free crop out. */
  render(params: Record<string, Value>, split: number | null, uncropped = false) {
    const gl = this.gl;
    if (!this.w) return;
    const e = effective(params);

    // Develop, into the texture.
    gl.useProgram(this.dev);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out, 0);
    gl.viewport(0, 0, this.w, this.h);
    const key = JSON.stringify(params.curve ?? null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    if (key !== this.lutKey) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, curveLut(params.curve));
      this.lutKey = key;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u(this.dev, "u_img"), 0);
    gl.uniform1i(this.u(this.dev, "u_lut"), 1);
    gl.uniform2f(this.u(this.dev, "u_texel"), 1 / this.w, 1 / this.h);
    for (const k of ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "temp", "tint", "vibrance", "saturation", "clarity", "fade", "sharpen", "blur", "dehaze", "gbal"]) {
      gl.uniform1f(this.u(this.dev, `u_${k}`), e[k]!);
    }
    gl.uniform1fv(this.u(this.dev, "u_hh"), HUE_NAMES.map((h) => num(params[`hsl.${h}.hue`]) / 100));
    gl.uniform1fv(this.u(this.dev, "u_hs"), HUE_NAMES.map((h) => num(params[`hsl.${h}.sat`]) / 100));
    gl.uniform1fv(this.u(this.dev, "u_hl"), HUE_NAMES.map((h) => num(params[`hsl.${h}.lum`]) / 100));
    gl.uniform3fv(this.u(this.dev, "u_gs"), tintOf(num(params["grade.shadows_hue"], 220), num(params["grade.shadows_sat"])));
    gl.uniform3fv(this.u(this.dev, "u_gh"), tintOf(num(params["grade.highlights_hue"], 40), num(params["grade.highlights_sat"])));
    const mp = new Float32Array(MAX_MASKS * MP);
    this.masks.forEach((m, i) => {
      mp.set(maskUniforms(params, m.id), i * MP);
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, m.tex);
      gl.uniform1i(this.u(this.dev, `u_m${i}`), 2 + i);
    });
    // Unused samplers still need a unit of their own type; they are never read.
    for (let i = this.masks.length; i < MAX_MASKS; i++) gl.uniform1i(this.u(this.dev, `u_m${i}`), 1);
    gl.uniform1fv(this.u(this.dev, "u_mp"), mp);
    gl.uniform1f(this.u(this.dev, "u_masks"), this.masks.length);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Present, onto the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.present);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.out);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.orig ?? this.tex);
    gl.uniform1i(this.u(this.present, "u_dev"), 0);
    gl.uniform1i(this.u(this.present, "u_orig"), 1);
    const g = geometry(params, this.w, this.h, uncropped);
    // WebGL takes column-major.
    gl.uniformMatrix3fv(this.u(this.present, "u_geo"), false, [g[0], g[3], g[6], g[1], g[4], g[7], g[2], g[5], g[8]]);
    gl.uniform1f(this.u(this.present, "u_aspect"), this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform1f(this.u(this.present, "u_split"), split ?? -1);
    gl.uniform1f(this.u(this.present, "u_vignette"), e.vignette!);
    gl.uniform1f(this.u(this.present, "u_grain"), e.grain!);
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

  /** The colour at a point of what was last drawn (0..1 from the top left), for the eyedropper. */
  colorAt(x: number, y: number): string {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(x * (this.canvas.width - 1)), Math.round((1 - y) * (this.canvas.height - 1)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${hex(px[0]!)}${hex(px[1]!)}${hex(px[2]!)}`;
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** A picture's pixels, small: for auto settings and the palette. */
function sample(img: CanvasImageSource & { width: number; height: number }, size = 96): Uint8ClampedArray | null {
  const c = document.createElement("canvas");
  const k = size / Math.max(img.width, img.height);
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

/** Exposure, contrast, whites, blacks and white balance worked out from the picture itself. */
export function autoSettings(img: CanvasImageSource & { width: number; height: number }): Record<string, number> {
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
export function paletteOf(img: CanvasImageSource & { width: number; height: number }): string[] {
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

/** The output size for a picture of `w`x`h` with these settings, up to 8192 (or the GPU's most) on a side. */
export function outputSize(params: Record<string, Value>, w: number, h: number, max = 8192): { w: number; h: number } {
  const aout = outputAspect(params, w, h);
  const quarter = Number(params.rotate ?? "0") % 180 !== 0;
  const srcH = quarter ? w : h;
  const zoom = Math.max(1, num(params.zoom, 1));
  const crop = Array.isArray(params.crop) ? Number(params.crop[3]) || 1 : 1;
  let outH = Math.round((srcH / zoom) * crop);
  let outW = Math.round(outH * aout);
  const k = Math.min(1, max / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * k));
  outH = Math.max(1, Math.round(outH * k));
  return { w: outW, h: outH };
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
