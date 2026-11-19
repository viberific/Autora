/**
 * Builds the mirror view's copy of the live page inside a document (the sandboxed, script-free frame `MirrorView`
 * makes), from the snapshot and changes `server/mirror.ts` sends.
 *
 * The server has already cleaned every node. This checks again, because it is the last thing between a page and the
 * person's browser: no element that runs or embeds anything, no `on*` attribute, and no address but Autora's own
 * resource tokens, inline pictures and in-page fragments. The frame itself has no `allow-scripts`, so even a mistake
 * here runs nothing.
 *
 * Pure DOM, no React: tests/mirror.test.ts loads it into a real Chromium.
 */

export type MirrorNode = {
  i: number; n?: string; t?: string; a?: Record<string, string>; c?: Array<MirrorNode | { r: number }>; ns?: number;
  s?: { i: number; c: Array<MirrorNode | { r: number }>; ss?: string[] }; ss?: string[]; rg?: number; w?: number; h?: number;
  v?: string; k?: number; sx?: number; sy?: number;
};

export type MirrorSnapshot = {
  op: "snapshot"; gen: number; url: string; title: string; vw: number; vh: number; dw: number; dh: number;
  sx: number; sy: number; root: MirrorNode | null; ss: string[]; quirks: boolean; size: number;
};

export type MirrorOp = { o: string; i?: number; [key: string]: unknown };

export type MirrorRegion = { op: "region"; gen: number; i: number; data: string; ox: number; oy: number; cw: number; ch: number; w: number; h: number };

const SVG = "http://www.w3.org/2000/svg";
const MATH = "http://www.w3.org/1998/Math/MathML";
const XLINK = "http://www.w3.org/1999/xlink";
const BLOCKED = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "meta", "base", "portal", "noscript", "template"]);
const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "background", "srcset", "imagesrcset"]);
const TAG_OK = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const ATTR_OK = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/;
/** Marks what the mirror added itself (a picture region's canvas, adopted sheets), so a change from the page does not
    remove it. */
const OWN = "data-autora-own";

export type MirrorHooks = {
  /** The real page moved focus. */
  onFocus?: (el: Element) => void;
  /** The real mouse moved (the agent's hand, or the person's own input arriving). */
  onPointer?: (x: number, y: number, down: boolean) => void;
  /** The page's viewport changed size. */
  onViewport?: (w: number, h: number) => void;
  /** Whether a value from the page should wait: the person is typing into that field right now. */
  holdValue?: (el: Element) => boolean;
  /** Whether a scroll from the page should wait: the person is scrolling that element (0, the page) right now. */
  holdScroll?: (id: number) => boolean;
};

export class MirrorDom {
  private nodes = new Map<number, Node>();
  private ids = new WeakMap<Node, number>();
  private regions = new Map<number, HTMLCanvasElement>();
  private scrolls = new Map<number, { x: number; y: number }>();
  /** When a scroll was last put there by the page, so the frame's own scroll event is not sent straight back. */
  private placed = new WeakMap<object, number>();
  gen = 0;

  constructor(private doc: Document, private prefix: string, private hooks: MirrorHooks = {}) {}

  /** Whether an address is one the copy may load: a resource token, an inline picture or font, or a fragment. */
  allowed(value: string): boolean {
    const v = value.trim();
    if (v === "" || v.startsWith("#")) return true;
    if (v.startsWith(this.prefix)) return true;
    return /^data:(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)|font\/|application\/(font|x-font))/i.test(v);
  }

  private safeAttr(name: string, value: string): boolean {
    if (!ATTR_OK.test(name) || /^on/i.test(name) || name.toLowerCase() === "srcdoc") return false;
    const lower = name.toLowerCase();
    if (/^\s*(javascript|vbscript):/i.test(value.replace(/[\u0000-\u001f\s]+/g, ""))) return false;
    if (lower === "srcset" || lower === "imagesrcset") return value.split(",").every((part) => this.allowed(part.trim().split(/\s+/)[0] ?? ""));
    if (URL_ATTRS.has(lower)) return this.allowed(value);
    return true;
  }

  private setAttr(el: Element, name: string, value: string | null) {
    try {
      if (value === null || !this.safeAttr(name, value)) {
        if (name === "xlink:href") el.removeAttributeNS(XLINK, "href");
        else el.removeAttribute(name);
        return;
      }
      if (name === "xlink:href") el.setAttributeNS(XLINK, "xlink:href", value);
      else el.setAttribute(name, value);
    } catch {
      // An attribute name the DOM refuses: left off.
    }
  }

  private remember(node: Node, id: number) {
    this.nodes.set(id, node);
    this.ids.set(node, id);
  }

  /** The id of the nearest mirrored node at or above this one, for input aimed at it. */
  idOf(node: Node | null): number | null {
    for (let n: Node | null = node; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) {
      const id = this.ids.get(n);
      if (id) return id;
    }
    return null;
  }

  node(id: number): Node | undefined {
    return id === 0 ? this.doc.scrollingElement ?? this.doc.documentElement : this.nodes.get(id);
  }

  private build(spec: MirrorNode, parentNs: number): Node | null {
    if (typeof spec.t === "string" && spec.n === undefined) {
      const text = this.doc.createTextNode(spec.t);
      if (spec.i > 0) this.remember(text, spec.i);
      return text;
    }
    const tag = String(spec.n ?? "");
    if (!TAG_OK.test(tag) || BLOCKED.has(tag.toLowerCase())) return null;
    const ns = spec.ns ?? (parentNs === 1 && tag.toLowerCase() !== "foreignobject" ? 1 : 0);
    if (spec.rg) return this.buildRegion(spec, tag, ns);
    let el: Element;
    try {
      el = ns === 1 ? this.doc.createElementNS(SVG, tag) : ns === 2 ? this.doc.createElementNS(MATH, tag) : this.doc.createElement(tag);
    } catch {
      return null;
    }
    this.remember(el, spec.i);
    const lower = tag.toLowerCase();
    // A link that is not a style sheet from a token (an icon, a preload) loads nothing here.
    if (lower === "link" && !(spec.a?.href ?? "").startsWith(this.prefix)) return null;
    for (const [k, v] of Object.entries(spec.a ?? {})) this.setAttr(el, k, v);
    if (lower === "style") {
      el.textContent = spec.c?.map((c) => ("t" in c && typeof c.t === "string" ? c.t : "")).join("") ?? "";
      return el;
    }
    const childNs = lower === "svg" ? 1 : lower === "math" ? 2 : lower === "foreignobject" ? 0 : ns;
    for (const kid of spec.c ?? []) {
      const child = this.child(kid, childNs);
      if (child) el.appendChild(child);
    }
    if (spec.s) this.shadow(el, spec.s, childNs);
    if (typeof spec.v === "string") this.value(el, spec.v, !!spec.k);
    if (spec.sx || spec.sy) this.scrolls.set(spec.i, { x: spec.sx ?? 0, y: spec.sy ?? 0 });
    return el;
  }

  private child(kid: MirrorNode | { r: number }, ns: number): Node | null {
    if ("r" in kid) return this.nodes.get(kid.r) ?? null;
    return this.build(kid, ns);
  }

  private shadow(host: Element, spec: { i: number; c: Array<MirrorNode | { r: number }>; ss?: string[] }, ns: number) {
    let root: ShadowRoot;
    try {
      root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    } catch {
      return; // not a host the DOM allows: its light children are shown instead
    }
    this.remember(root, spec.i);
    for (const css of spec.ss ?? []) root.appendChild(this.ownStyle(css));
    for (const kid of spec.c) {
      const child = this.child(kid, ns);
      if (child) root.appendChild(child);
    }
  }

  private ownStyle(css: string): HTMLStyleElement {
    const st = this.doc.createElement("style");
    st.setAttribute(OWN, "");
    st.textContent = css;
    return st;
  }

  /** A part the DOM cannot carry: a canvas the server's pictures are painted into, sized as the original. */
  private buildRegion(spec: MirrorNode, tag: string, ns: number): Node | null {
    const w = Math.max(1, spec.w ?? 1);
    const h = Math.max(1, spec.h ?? 1);
    const canvas = this.doc.createElement("canvas");
    canvas.setAttribute("data-autora-region", tag.toLowerCase());
    if (spec.rg === 2 && TAG_OK.test(tag) && ns === 0) {
      // A closed shadow root: the host stays (its styles still apply) and the picture is drawn inside it.
      let host: Element;
      try { host = this.doc.createElement(tag); } catch { return null; }
      for (const [k, v] of Object.entries(spec.a ?? {})) this.setAttr(host, k, v);
      canvas.setAttribute(OWN, "");
      canvas.width = w;
      canvas.height = h;
      canvas.style.cssText = `display:block;width:${w}px;height:${h}px`;
      host.appendChild(canvas);
      this.remember(host, spec.i);
      this.regions.set(spec.i, canvas);
      return host;
    }
    for (const [k, v] of Object.entries(spec.a ?? {})) this.setAttr(canvas, k, v);
    const own = tag.toLowerCase() === "canvas";
    if (!own || !spec.a?.width) canvas.width = w;
    if (!own || !spec.a?.height) canvas.height = h;
    if (!own && !spec.a?.style) canvas.style.cssText = `width:${w}px;height:${h}px`;
    this.remember(canvas, spec.i);
    this.regions.set(spec.i, canvas);
    return canvas;
  }

  private value(el: Element, v: string, checked: boolean) {
    if (el instanceof this.doc.defaultView!.HTMLSelectElement) el.selectedIndex = Number(v) || 0;
    else if (el instanceof this.doc.defaultView!.HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") el.checked = checked;
      else if (el.type !== "file") el.value = v;
    } else if (el instanceof this.doc.defaultView!.HTMLTextAreaElement) el.value = v;
  }

  /** Start again from a whole page. */
  snapshot(msg: MirrorSnapshot) {
    this.gen = msg.gen;
    this.nodes.clear();
    this.regions.clear();
    this.scrolls.clear();
    const root = msg.root ? this.build(msg.root, 0) : null;
    const doc = this.doc;
    if (root && root.nodeType === 1 && (root as Element).localName === "html") {
      // The policy meta in the frame's first document was read when it was parsed and holds after this.
      doc.replaceChild(root, doc.documentElement);
    } else {
      doc.body?.replaceChildren(...(root ? [root] : []));
    }
    const head = doc.head ?? doc.documentElement;
    for (const css of msg.ss ?? []) head.appendChild(this.ownStyle(css));
    this.scrolls.set(0, { x: msg.sx, y: msg.sy });
    this.placeScrolls();
  }

  /** Put the scroll offsets in place. Called again once style sheets have loaded, since before that the page may be
      too short to scroll to them. */
  placeScrolls() {
    for (const [id, at] of this.scrolls) {
      const el = this.node(id) as Element | undefined;
      if (!el) continue;
      this.placed.set(id === 0 ? this.doc : el, Date.now());
      if (id === 0) this.doc.defaultView?.scrollTo(at.x, at.y);
      else { el.scrollLeft = at.x; el.scrollTop = at.y; }
      if (Math.abs((id === 0 ? this.doc.defaultView!.scrollY : el.scrollTop) - at.y) < 2) this.scrolls.delete(id);
    }
  }

  /** Whether a scroll event on `target` is one the page put there (and so not the person's to send back). */
  placedByPage(target: object): boolean {
    return Date.now() - (this.placed.get(target) ?? 0) < 150;
  }

  /** Apply a batch of changes. False means the copy lost track of a node and needs a fresh snapshot. */
  apply(ops: MirrorOp[]): boolean {
    let ok = true;
    for (const op of ops) {
      const id = Number(op.i ?? 0);
      switch (op.o) {
        case "kids": {
          const parent = this.nodes.get(id);
          if (!parent) { ok = false; break; }
          const ns = parent.nodeType === 1 && (parent as Element).namespaceURI === SVG && (parent as Element).localName !== "foreignObject" ? 1 : 0;
          const want: Node[] = [];
          for (const kid of (op.c as Array<MirrorNode | { r: number }>) ?? []) {
            const child = this.child(kid, ns);
            if (child) want.push(child);
            else if ("r" in kid) ok = false;
          }
          this.reconcile(parent, want);
          break;
        }
        case "attr": {
          const el = this.nodes.get(id);
          if (el && el.nodeType === 1) this.setAttr(el as Element, String(op.k), op.v === null ? null : String(op.v));
          break;
        }
        case "text": {
          const t = this.nodes.get(id);
          if (t && t.nodeType === 3) (t as Text).data = String(op.t ?? "");
          break;
        }
        case "css": {
          const st = this.nodes.get(id);
          if (st && st.nodeType === 1) st.textContent = String(op.t ?? "");
          break;
        }
        case "val": {
          const el = this.nodes.get(id);
          if (el && el.nodeType === 1 && !this.hooks.holdValue?.(el as Element)) this.value(el as Element, String(op.v ?? ""), !!op.k);
          break;
        }
        case "scroll":
          if (!this.hooks.holdScroll?.(id)) this.scrolls.set(id, { x: Number(op.x) || 0, y: Number(op.y) || 0 });
          break;
        case "focus": {
          const el = this.nodes.get(id);
          if (el && el.nodeType === 1) this.hooks.onFocus?.(el as Element);
          break;
        }
        case "ptr":
          this.hooks.onPointer?.(Number(op.x) || 0, Number(op.y) || 0, !!op.d);
          break;
        case "vp":
          this.hooks.onViewport?.(Number(op.w) || 0, Number(op.h) || 0);
          break;
      }
    }
    this.placeScrolls();
    return ok;
  }

  /** Make `parent`'s children exactly `want`, moving the ones that are already there. */
  private reconcile(parent: Node, want: Node[]) {
    const keep = new Set(want);
    for (const child of Array.from(parent.childNodes)) {
      if (!keep.has(child) && !(child.nodeType === 1 && (child as Element).hasAttribute(OWN))) parent.removeChild(child);
    }
    let at: Node | null = parent.firstChild;
    for (const node of want) {
      while (at && at.nodeType === 1 && (at as Element).hasAttribute(OWN)) at = at.nextSibling;
      if (at === node) { at = at.nextSibling; continue; }
      parent.insertBefore(node, at);
    }
  }

  /** A picture of a region, drawn into its canvas where it belongs. */
  region(msg: MirrorRegion, decode: (src: string) => Promise<CanvasImageSource | null>): Promise<void> {
    const canvas = this.regions.get(msg.i);
    if (!canvas || msg.gen !== this.gen) return Promise.resolve();
    return decode(`data:image/jpeg;base64,${msg.data}`).then((img) => {
      if (!img) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const sx = canvas.width / Math.max(1, msg.w);
      const sy = canvas.height / Math.max(1, msg.h);
      ctx.drawImage(img, msg.ox * sx, msg.oy * sy, msg.cw * sx, msg.ch * sy);
    });
  }
}
