/**
 * The mirror view of the live browser (docs/MODULES.md, "The mirror view"; intent/2026-11-19-new-web-browser-architecture.md).
 *
 * Chromium stays on the server and is the only browser. Instead of sending the person pictures of the page, the
 * recorder in `mirror-script.ts` sends the page's DOM and its changes; this file cleans every one of those messages
 * before it leaves the server, swaps every sub-resource address for a token that only Autora can redeem (so images,
 * fonts and style sheets load through the server browser's own network session, with its cookies), watches the
 * mirror's health, and captures the parts the DOM cannot carry (canvas, video, frames, closed shadow roots) as small
 * cropped pictures. The client rebuilds the page in a sandboxed frame with no scripts (`src/lib/mirrorDom.ts`).
 *
 * What never leaves here: a script, an inline event handler, a `javascript:` address, a password's characters, or an
 * address the client's frame could load from the site directly.
 */

import crypto from "node:crypto";
import { MIRROR_BINDING, MIRROR_SCRIPT, MIRROR_WORLD } from "./mirror-script";

/** When a page is better shown as pictures. */
export const MIRROR_LIMITS = {
  /** A snapshot bigger than this (bytes of JSON) is a page the mirror cannot carry cheaply. */
  snapshotBytes: Number(process.env.AUTORA_MIRROR_MAX_SNAPSHOT) || 6 * 1024 * 1024,
  /** Changes a second, held for `busySeconds`, after which the page is a picture. */
  opsPerSecond: Number(process.env.AUTORA_MIRROR_MAX_OPS) || 4000,
  busySeconds: 3,
  /** The share of the viewport that may be picture regions before the whole page is one. */
  regionShare: 0.5,
};

export type MirrorStatus = { status: "off" | "starting" | "live" | "fallback"; reason: string | null };

// ------------------------------------------------------------- tokens --

export type ResourceKind = "css" | "img" | "any";
type TokenEntry = { url: string; kind: ResourceKind; referer: string };

/**
 * Sub-resource addresses, swapped for unguessable tokens. The client's frame only ever sees
 * `/api/sessions/<id>/browser/mirror/r/<token>`, which Autora redeems by fetching the address through the server
 * browser's own session; a token is only made for an address the page itself referred to, so the route is not a way
 * to make the server fetch anything else.
 */
export class ResourceTokens {
  private byKey = new Map<string, string>();
  private byToken = new Map<string, TokenEntry>();
  constructor(private prefix: string, private max = 20000) {}

  token(url: string, kind: ResourceKind, referer: string): string {
    const key = `${kind}\u0000${url}`;
    let token = this.byKey.get(key);
    if (!token) {
      token = crypto.randomBytes(12).toString("base64url");
      this.byKey.set(key, token);
      this.byToken.set(token, { url, kind, referer });
      if (this.byToken.size > this.max) {
        const [oldToken, old] = this.byToken.entries().next().value as [string, TokenEntry];
        this.byToken.delete(oldToken);
        this.byKey.delete(`${old.kind}\u0000${old.url}`);
      }
    }
    return this.prefix + token;
  }

  get(token: string): TokenEntry | undefined {
    return this.byToken.get(token);
  }
}

/** The addresses a mirror may load: the web, and pictures or fonts written into the page. */
export function loadable(url: string): "web" | "data" | null {
  if (/^https?:\/\//i.test(url)) return "web";
  if (/^data:(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)|font\/|application\/(font|x-font))/i.test(url)) return "data";
  return null;
}

function resolve(raw: string, base: string): string | null {
  try {
    return new URL(raw.trim(), base).href;
  } catch {
    return null;
  }
}

/** Every `url()` and `@import` in a style sheet, pointed at a token; anything that is not a web address or an inline
    picture or font goes nowhere. */
export function rewriteCss(css: string, base: string, tokens: ResourceTokens, referer: string): string {
  const to = (raw: string, kind: ResourceKind) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return trimmed;
    const abs = resolve(trimmed, base);
    const can = abs ? loadable(abs) : null;
    if (!abs || !can) return "about:invalid";
    return can === "data" ? abs : tokens.token(abs, kind, referer);
  };
  return css
    .replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, (_m, _q, u: string) => `@import url("${to(u, "css")}")`)
    .replace(/url\(\s*(["']?)((?:\\.|(?!\1\s*\)).)*?)\1\s*\)/gi, (_m, _q, u: string) => `url("${to(u.replace(/\\(.)/g, "$1"), "any").replace(/"/g, "%22")}")`)
    .replace(/expression\s*\(/gi, "invalid(")
    .replace(/-moz-binding\s*:/gi, "-x-binding:");
}

// ----------------------------------------------------------- sanitising --

/** Elements a mirror never contains. Frames, plugins, canvases and videos arrive as picture regions instead. */
const DROP_TAGS = new Set(["script", "noscript", "template", "meta", "base", "title", "frameset", "applet", "portal", "param", "slot-script"]);
const REGION_TAGS = new Set(["canvas", "video", "iframe", "frame", "embed", "object"]);
/** Attributes that run, submit, ping or verify, none of which a script-free copy needs. */
const DROP_ATTRS = new Set([
  "srcdoc", "formaction", "action", "ping", "integrity", "nonce", "crossorigin", "referrerpolicy", "http-equiv",
  "autofocus", "is", "data", "codebase", "manifest", "attributionsrc", "fetchpriority",
]);
const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "background"]);
const TAG_OK = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const ATTR_OK = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/;
const MASK = "•";

export type MirrorNode = {
  i: number; n?: string; t?: string; a?: Record<string, string>; c?: Array<MirrorNode | { r: number }>; ns?: number;
  s?: { i: number; c: MirrorNode[]; ss?: string[] }; ss?: string[]; rg?: number; w?: number; h?: number;
  v?: string; k?: number; sx?: number; sy?: number;
};

export type Sanitiser = {
  tokens: ResourceTokens;
  /** The page's base address, for the relative addresses left in style text. */
  base: string;
  /** The page's address, sent as the referer when a resource is fetched. */
  referer: string;
};

function cleanUrlAttr(tag: string, name: string, value: string, s: Sanitiser, rel: string): string | null {
  const abs = resolve(value, s.base);
  if (!abs) return null;
  // A link never navigates the mirror: the real browser does every navigation.
  if ((tag === "a" || tag === "area") && (name === "href" || name === "xlink:href")) return "#";
  if (tag === "link") return /(^|\s)stylesheet(\s|$)/i.test(rel) && loadable(abs) === "web" ? s.tokens.token(abs, "css", s.referer) : null;
  const can = loadable(abs);
  if (!can) return null;
  if (can === "data") return abs;
  // An SVG sprite keeps its fragment: `use href="icons.svg#star"`.
  const hash = abs.indexOf("#");
  if (hash > 0 && (tag === "use" || tag === "image" || tag === "feImage")) return s.tokens.token(abs.slice(0, hash), "img", s.referer) + abs.slice(hash);
  return s.tokens.token(abs, "img", s.referer);
}

function cleanSrcset(value: string, s: Sanitiser): string {
  return value.split(/,\s+/).map((part) => {
    const bits = part.trim().split(/\s+/);
    const abs = bits[0] ? resolve(bits[0], s.base) : null;
    const can = abs ? loadable(abs) : null;
    if (!abs || !can) return "";
    bits[0] = can === "data" ? abs : s.tokens.token(abs, "img", s.referer);
    return bits.join(" ");
  }).filter(Boolean).join(", ");
}

/** One attribute made safe, or null to drop it. */
export function cleanAttr(tag: string, name: string, value: string, s: Sanitiser, all: Record<string, string> = {}): string | null {
  if (!ATTR_OK.test(name)) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || DROP_ATTRS.has(lower)) return null;
  // A link never navigates the mirror, wherever it pointed: the real browser does every navigation.
  if ((tag === "a" || tag === "area") && (lower === "href" || lower === "xlink:href")) return "#";
  if (/^\s*(javascript|vbscript|livescript):/i.test(value.replace(/[\u0000-\u001f\s]+/g, ""))) return null;
  if (lower === "style") return rewriteCss(value, s.base, s.tokens, s.referer);
  if (lower === "srcset" || lower === "imagesrcset") return cleanSrcset(value, s);
  if (URL_ATTRS.has(lower)) return cleanUrlAttr(tag, lower, value, s, all.rel ?? "");
  if (lower === "target") return null;
  if (tag === "input" && lower === "value" && String(all.type ?? "").toLowerCase() === "password") return "";
  // An SVG animation can set an attribute to anything, an address included.
  if ((tag === "animate" || tag === "set") && (lower === "to" || lower === "from" || lower === "values") && /href/i.test(all.attributeName ?? "")) return null;
  return value;
}

/** A node from the recorder, made safe to send, or null to leave it out. */
export function cleanNode(node: MirrorNode, s: Sanitiser): MirrorNode | null {
  if (typeof node !== "object" || node === null || typeof node.i !== "number") return null;
  if (typeof node.t === "string" && node.n === undefined) return { i: node.i, t: node.t };
  const tag = String(node.n ?? "");
  if (!TAG_OK.test(tag)) return null;
  const lower = tag.toLowerCase();
  if (DROP_TAGS.has(lower)) return null;
  if ((lower === "animate" || lower === "set") && /href/i.test(node.a?.attributeName ?? "")) return null;
  const out: MirrorNode = { i: node.i, n: tag };
  if (node.ns === 1 || node.ns === 2) out.ns = node.ns;
  const attrs = node.a ?? {};
  if (node.rg || REGION_TAGS.has(lower)) {
    // A picture region keeps only what places it: its box is drawn from the server's pictures.
    out.rg = node.rg === 2 ? 2 : 1;
    out.w = Math.max(0, Math.round(Number(node.w) || 0));
    out.h = Math.max(0, Math.round(Number(node.h) || 0));
    const keep: Record<string, string> = {};
    for (const k of ["id", "class", "style", "width", "height", "slot", "hidden", "dir", "lang", "role"]) {
      if (typeof attrs[k] === "string") {
        const v = cleanAttr("div", k, attrs[k], s, attrs);
        if (v !== null) keep[k] = v;
      }
    }
    out.a = keep;
    return out;
  }
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v !== "string") continue;
    const clean = cleanAttr(lower, k, v, s, attrs);
    if (clean !== null) a[k] = clean;
  }
  out.a = a;
  if (lower === "style") {
    const text = Array.isArray(node.c) ? node.c.map((c) => ("t" in c && typeof c.t === "string" ? c.t : "")).join("") : "";
    out.c = [{ i: -1, t: rewriteCss(text, s.base, s.tokens, s.referer) }];
    return out;
  }
  if (typeof node.v === "string") {
    const password = lower === "input" && String(attrs.type ?? "").toLowerCase() === "password";
    out.v = password ? MASK.repeat(Math.min([...node.v].length, 64)) : node.v;
  }
  if (node.k) out.k = 1;
  if (node.sx) out.sx = Number(node.sx) || 0;
  if (node.sy) out.sy = Number(node.sy) || 0;
  if (Array.isArray(node.c)) out.c = cleanKids(node.c, s);
  if (node.s && typeof node.s.i === "number") {
    out.s = { i: node.s.i, c: cleanKids(node.s.c ?? [], s) as MirrorNode[], ss: cleanSheets(node.s.ss, s) };
  }
  return out;
}

function cleanKids(kids: Array<MirrorNode | { r: number }>, s: Sanitiser): Array<MirrorNode | { r: number }> {
  const out: Array<MirrorNode | { r: number }> = [];
  for (const kid of kids) {
    if (kid && typeof (kid as { r?: unknown }).r === "number") { out.push({ r: (kid as { r: number }).r }); continue; }
    const clean = cleanNode(kid as MirrorNode, s);
    if (clean) out.push(clean);
  }
  return out;
}

function cleanSheets(sheets: unknown, s: Sanitiser): string[] {
  return Array.isArray(sheets) ? sheets.filter((x): x is string => typeof x === "string").map((css) => rewriteCss(css, s.base, s.tokens, s.referer)) : [];
}

export type MirrorOp = Record<string, any> & { o: string };

/** One change from the recorder, made safe, or null to drop it. Picture-region boxes stay on the server. */
export function cleanOp(op: MirrorOp, s: Sanitiser, tags: Map<number, string>): MirrorOp | null {
  const i = Number(op.i);
  switch (op.o) {
    case "kids": {
      if (!Array.isArray(op.c)) return null;
      const c = cleanKids(op.c, s);
      remember(c, tags);
      return { o: "kids", i, c };
    }
    case "attr": {
      const tag = tags.get(i) ?? "div";
      if (tag === "input" && op.k === "type") tags.set(-i, String(op.v ?? "").toLowerCase());
      if (op.v === null) return ATTR_OK.test(String(op.k)) ? { o: "attr", i, k: String(op.k), v: null } : null;
      const v = cleanAttr(tag, String(op.k), String(op.v), s, { type: tag === "input" ? tags.get(-i) ?? "" : "" });
      // An attribute that cannot be shown is removed, so the mirror is never left with the old value.
      return { o: "attr", i, k: String(op.k), v: ATTR_OK.test(String(op.k)) && !/^on/i.test(String(op.k)) ? v : null };
    }
    case "text":
      return { o: "text", i, t: String(op.t ?? "") };
    case "css":
      return { o: "css", i, t: rewriteCss(String(op.t ?? ""), s.base, s.tokens, s.referer) };
    case "val": {
      const password = tags.get(-i) === "password";
      const v = String(op.v ?? "");
      return { o: "val", i, v: password ? MASK.repeat(Math.min([...v].length, 64)) : v, k: op.k ? 1 : 0 };
    }
    case "scroll":
      return { o: "scroll", i, x: Number(op.x) || 0, y: Number(op.y) || 0 };
    case "focus":
      return { o: "focus", i };
    case "ptr":
      return { o: "ptr", x: Number(op.x) || 0, y: Number(op.y) || 0, d: op.d ? 1 : 0 };
    case "vp":
      return { o: "vp", w: Number(op.w) || 0, h: Number(op.h) || 0 };
    default:
      return null;
  }
}

/** What each node is, by id, for the changes that come later: an attribute's rules depend on its element, and a
    value is masked when its field is a password (kept as -id). */
export function remember(nodes: Array<MirrorNode | { r: number }>, tags: Map<number, string>) {
  for (const node of nodes) {
    if (!node || "r" in node) continue;
    if (node.n) {
      tags.set(node.i, node.n.toLowerCase());
      if (node.n.toLowerCase() === "input") tags.set(-node.i, String(node.a?.type ?? "").toLowerCase());
    }
    if (node.c) remember(node.c, tags);
    if (node.s) remember(node.s.c, tags);
  }
}

// ------------------------------------------------------------ recorder --

type CDP = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  on: (event: string, fn: (e: any) => void) => unknown;
  off?: (event: string, fn: (e: any) => void) => unknown;
};

export type MirrorDeps = {
  /** Where tokens point: `/api/sessions/<id>/browser/mirror/r/`. */
  prefix: string;
  /** A message for the person's mirror (ephemeral, never logged). */
  send: (message: Record<string, unknown>) => void;
  /** Whether anyone is looking at the mirror now. */
  active: () => boolean;
  /** The mirror went live or fell back. */
  onStatus?: (status: MirrorStatus) => void;
};

type Region = { x: number; y: number; w: number; h: number; tag: string; at: number; hash: string };

/**
 * One tab's recorder, on the tab's CDP session. `attach` is called again for each new session (a tab switch, a
 * resize); each attach starts from a fresh snapshot.
 */
export class MirrorRecorder {
  readonly tokens: ResourceTokens;
  private cdp: CDP | null = null;
  private contextId: number | null = null;
  private mainFrame: string | null = null;
  private gen = 0;
  private base = "about:blank";
  private url = "about:blank";
  private tags = new Map<number, string>();
  private regions = new Map<number, Region>();
  private view = { sx: 0, sy: 0, vw: 0, vh: 0 };
  private state: MirrorStatus = { status: "starting", reason: null };
  /** A page that fell back stays a picture until it is left. */
  private fellBackAt: string | null = null;
  private opsWindow: Array<{ at: number; n: number }> = [];
  private regionTimer: NodeJS.Timeout | null = null;
  private listeners: Array<[string, (e: any) => void]> = [];
  /** The last snapshot sent, so a viewer that joins late starts from it. */
  private lastSnapshot: Record<string, unknown> | null = null;
  private batchesSince: Array<Record<string, unknown>> = [];

  constructor(private deps: MirrorDeps) {
    this.tokens = new ResourceTokens(deps.prefix);
  }

  status(): MirrorStatus {
    return { ...this.state };
  }

  private setStatus(status: MirrorStatus["status"], reason: string | null = null) {
    if (this.state.status === status && this.state.reason === reason) return;
    this.state = { status, reason };
    this.deps.send({ op: "state", status, reason, url: this.url });
    this.deps.onStatus?.(this.status());
  }

  /** The person asked for the copy again on a page that fell back: try it afresh. */
  retry(): Promise<unknown> {
    this.fellBackAt = null;
    this.opsWindow = [];
    this.setStatus("starting");
    return this.resnapshot();
  }

  /** Give up on the mirror for this page; the picture stream takes over. */
  fallBack(reason: string) {
    this.fellBackAt = this.url;
    this.setStatus("fallback", reason);
  }

  async attach(cdp: CDP): Promise<void> {
    this.detach();
    this.cdp = cdp;
    const on = (event: string, fn: (e: any) => void) => { cdp.on(event, fn); this.listeners.push([event, fn]); };
    on("Runtime.bindingCalled", (e) => {
      if (e.name !== MIRROR_BINDING || this.cdp !== cdp) return;
      this.receive(String(e.payload ?? ""));
    });
    on("Runtime.executionContextCreated", (e) => {
      const c = e.context;
      if (c?.name === MIRROR_WORLD && (!this.mainFrame || c.auxData?.frameId === this.mainFrame)) this.contextId = c.id;
    });
    on("Runtime.executionContextsCleared", () => { this.contextId = null; });
    on("Page.frameNavigated", (e) => { if (!e.frame?.parentId) this.mainFrame = e.frame.id; });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: MIRROR_BINDING, executionContextName: MIRROR_WORLD });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MIRROR_SCRIPT, worldName: MIRROR_WORLD });
    const tree = await cdp.send("Page.getFrameTree");
    this.mainFrame = tree?.frameTree?.frame?.id ?? null;
    if (this.mainFrame) {
      const world = await cdp.send("Page.createIsolatedWorld", { frameId: this.mainFrame, worldName: MIRROR_WORLD });
      this.contextId = world?.executionContextId ?? null;
      // A recorder already in this world (a second attach to the same document) is asked for a fresh snapshot.
      await this.evaluate(`if (window.__autoraMirror) window.__autoraMirror.snapshot(); else ${MIRROR_SCRIPT}\n1`);
    }
    this.regionTimer = setInterval(() => void this.captureRegions(), 250);
    this.regionTimer.unref?.();
  }

  detach() {
    const cdp = this.cdp;
    if (cdp?.off) for (const [event, fn] of this.listeners) cdp.off(event, fn);
    this.listeners = [];
    this.cdp = null;
    this.contextId = null;
    if (this.regionTimer) clearInterval(this.regionTimer);
    this.regionTimer = null;
  }

  private async evaluate(expression: string): Promise<any> {
    if (!this.cdp || this.contextId === null) return null;
    const out = await this.cdp.send("Runtime.evaluate", { contextId: this.contextId, expression, returnByValue: true }).catch(() => null);
    return out?.result?.value ?? null;
  }

  /** Ask the page for a fresh snapshot (a viewer lost track of a node). */
  resnapshot(): Promise<unknown> {
    return this.evaluate("window.__autoraMirror && window.__autoraMirror.snapshot(), 1");
  }

  /** Where a mirrored node is on the real page now, in viewport pixels. */
  async rect(id: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
    if (!Number.isFinite(id) || id <= 0) return null;
    const r = await this.evaluate(`window.__autoraMirror ? window.__autoraMirror.rect(${Math.round(id)}) : null`);
    return r && typeof r.x === "number" ? r : null;
  }

  /** Scroll the real page (0) or one of its scrolling elements where the person scrolled the mirror. */
  async scroll(id: number, x: number, y: number): Promise<boolean> {
    const ok = await this.evaluate(`window.__autoraMirror ? window.__autoraMirror.scroll(${Math.round(id) || 0}, ${Math.round(x) || 0}, ${Math.round(y) || 0}) : false`);
    return ok === true;
  }

  /** What a viewer that has just arrived needs: the snapshot and every batch since. */
  catchUp(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [{ op: "state", ...this.state, url: this.url }];
    if (this.lastSnapshot) out.push(this.lastSnapshot, ...this.batchesSince);
    return out;
  }

  /** One message from the recorder. Exposed for the tests; the binding calls it. */
  receive(payload: string) {
    // Past this it is not worth reading to find out which page it was: the next page, whatever it is, tries again.
    if (payload.length > MIRROR_LIMITS.snapshotBytes * 8) { this.url = ""; this.fallBack("the page is too large to mirror"); return; }
    let msg: any;
    try { msg = JSON.parse(payload); } catch { return; }
    if (msg?.op === "snapshot") this.onSnapshot(msg, payload.length);
    else if (msg?.op === "batch" && msg.gen === this.gen) this.onBatch(msg);
  }

  private onSnapshot(msg: any, size: number) {
    this.gen = Number(msg.gen) || this.gen + 1;
    this.base = typeof msg.base === "string" ? msg.base : String(msg.url ?? "");
    const url = String(msg.url ?? "");
    if (url !== this.url) this.fellBackAt = null;
    this.url = url;
    this.tags.clear();
    this.regions.clear();
    this.opsWindow = [];
    this.view = { sx: Number(msg.sx) || 0, sy: Number(msg.sy) || 0, vw: Number(msg.vw) || 0, vh: Number(msg.vh) || 0 };
    const s = this.sanitiser();
    const root = msg.root ? cleanNode(msg.root, s) : null;
    if (root) remember([root], this.tags);
    const out = {
      op: "snapshot", gen: this.gen, url, title: String(msg.title ?? ""), vw: this.view.vw, vh: this.view.vh,
      dw: Number(msg.dw) || 0, dh: Number(msg.dh) || 0, sx: this.view.sx, sy: this.view.sy, root,
      ss: cleanSheets(msg.ss, s), quirks: msg.mode === "BackCompat", size,
    };
    this.lastSnapshot = out;
    this.batchesSince = [];
    if (this.fellBackAt === url) { this.deps.send(out); return; }
    if (size > MIRROR_LIMITS.snapshotBytes) { this.fallBack("the page is too large to mirror"); return; }
    this.deps.send(out);
    this.setStatus("live");
  }

  private onBatch(msg: any) {
    const s = this.sanitiser();
    const ops: MirrorOp[] = [];
    for (const raw of Array.isArray(msg.m) ? msg.m : []) {
      if (raw?.o === "rect") { this.noteRegion(raw); continue; }
      if (raw?.o === "scroll" && Number(raw.i) === 0) { this.view.sx = Number(raw.x) || 0; this.view.sy = Number(raw.y) || 0; }
      if (raw?.o === "vp") { this.view.vw = Number(raw.w) || 0; this.view.vh = Number(raw.h) || 0; }
      const clean = cleanOp(raw, s, this.tags);
      if (clean) ops.push(clean);
    }
    if (ops.length === 0) return;
    this.noteRate(ops.length);
    const out = { op: "batch", gen: this.gen, m: ops };
    this.batchesSince.push(out);
    // A viewer that joins late replays these; past a point a fresh snapshot is cheaper.
    if (this.batchesSince.length > 600) { this.batchesSince = []; this.lastSnapshot = null; void this.resnapshot(); }
    this.deps.send(out);
  }

  private noteRate(n: number) {
    const now = Date.now();
    this.opsWindow.push({ at: now, n });
    const since = now - MIRROR_LIMITS.busySeconds * 1000;
    while (this.opsWindow.length && this.opsWindow[0].at < since) this.opsWindow.shift();
    const total = this.opsWindow.reduce((sum, w) => sum + w.n, 0);
    if (this.state.status === "live" && total > MIRROR_LIMITS.opsPerSecond * MIRROR_LIMITS.busySeconds) {
      this.fallBack("the page changes too fast to mirror");
    }
  }

  private noteRegion(raw: any) {
    const i = Number(raw.i);
    const r = { x: Number(raw.x) || 0, y: Number(raw.y) || 0, w: Number(raw.w) || 0, h: Number(raw.h) || 0 };
    const was = this.regions.get(i);
    this.regions.set(i, { ...r, tag: this.tags.get(i) ?? "", at: was?.at ?? 0, hash: was && was.w === r.w && was.h === r.h ? was.hash : "" });
    this.checkRegionShare();
  }

  /** The part of the viewport that is pictures. Past half of it, the page is better as one picture. */
  private checkRegionShare() {
    const { sx, sy, vw, vh } = this.view;
    if (!vw || !vh || this.state.status !== "live") return;
    let area = 0;
    for (const r of this.regions.values()) {
      const w = Math.max(0, Math.min(r.x + r.w, sx + vw) - Math.max(r.x, sx));
      const h = Math.max(0, Math.min(r.y + r.h, sy + vh) - Math.max(r.y, sy));
      area += w * h;
    }
    if (area > MIRROR_LIMITS.regionShare * vw * vh) this.fallBack("most of the page is drawn, not written");
  }

  private capturing = false;
  /** The picture regions on screen, a few times a second: a playing video more often than a canvas. Each goes out
      only when it changed. */
  private async captureRegions() {
    const cdp = this.cdp;
    if (!cdp || this.capturing || this.state.status !== "live" || !this.deps.active() || this.regions.size === 0) return;
    this.capturing = true;
    try {
      const now = Date.now();
      const { sx, sy, vw, vh } = this.view;
      let budget = 4;
      for (const [i, r] of this.regions) {
        if (budget <= 0) break;
        const every = r.tag === "video" ? 250 : 500;
        if (now - r.at < every) continue;
        const x0 = Math.max(r.x, sx);
        const y0 = Math.max(r.y, sy);
        const x1 = Math.min(r.x + r.w, sx + (vw || 1280));
        const y1 = Math.min(r.y + r.h, sy + (vh || 800));
        if (x1 - x0 < 2 || y1 - y0 < 2) continue;
        budget -= 1;
        r.at = now;
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "jpeg", quality: r.tag === "video" ? 55 : 75,
          clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 },
        }).catch(() => null);
        if (!shot?.data || this.cdp !== cdp) continue;
        const hash = crypto.createHash("sha1").update(shot.data).digest("base64");
        if (hash === r.hash) continue;
        r.hash = hash;
        this.deps.send({
          op: "region", gen: this.gen, i, data: shot.data,
          ox: x0 - r.x, oy: y0 - r.y, cw: x1 - x0, ch: y1 - y0, w: r.w, h: r.h,
        });
      }
    } finally {
      this.capturing = false;
    }
  }

  private sanitiser(): Sanitiser {
    return { tokens: this.tokens, base: this.base, referer: this.url };
  }
}

// ------------------------------------------------------------- serving --

/** The content types a mirrored resource may be served as. Anything else is bytes, never a page. */
export function servedType(kind: ResourceKind, upstream: string): string {
  const type = upstream.split(";")[0].trim().toLowerCase();
  if (kind === "css") return /html|xml|javascript|ecmascript/.test(type) ? "application/octet-stream" : "text/css; charset=utf-8";
  if (type === "text/css") return "text/css; charset=utf-8";
  if (/^image\/[a-z0-9.+-]+$/.test(type) || /^font\/[a-z0-9.+-]+$/.test(type)) return type;
  if (/^application\/(font-woff2?|x-font-[a-z]+|vnd\.ms-fontobject|font-sfnt)$/.test(type)) return type;
  return "application/octet-stream";
}

/** The headers every mirrored resource is served with: never a page on Autora's origin, never sniffed into one. */
export const RESOURCE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, max-age=3600",
  "Referrer-Policy": "no-referrer",
};

/** Resources already fetched, held in memory for the session: a page's fonts and pictures are asked for again on
    every snapshot. Bounded by bytes; the oldest go first. */
export class ResourceCache {
  private entries = new Map<string, { type: string; body: Buffer }>();
  private bytes = 0;
  constructor(private max = 48 * 1024 * 1024) {}
  get(token: string) {
    const hit = this.entries.get(token);
    if (hit) { this.entries.delete(token); this.entries.set(token, hit); }
    return hit;
  }
  set(token: string, value: { type: string; body: Buffer }) {
    if (value.body.length > this.max / 4) return;
    const was = this.entries.get(token);
    if (was) this.bytes -= was.body.length;
    this.entries.set(token, value);
    this.bytes += value.body.length;
    while (this.bytes > this.max) {
      const [oldest, entry] = this.entries.entries().next().value as [string, { type: string; body: Buffer }];
      this.entries.delete(oldest);
      this.bytes -= entry.body.length;
    }
  }
}
