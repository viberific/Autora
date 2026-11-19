/**
 * The recorder the mirror view runs inside the server browser's page (docs/MODULES.md, "The mirror view").
 *
 * It runs in an isolated world (`MIRROR_WORLD`), not the page's own: the page's script cannot see it, call it or
 * fingerprint it, and it shares only the DOM. It sends one snapshot of the document, then the changes, batched once
 * a frame, through the `MIRROR_BINDING` CDP binding (which exists only in this world). Nothing here decides what is
 * safe to show: `server/mirror.ts` sanitises every message before it leaves the server, and the client draws it in a
 * script-free sandboxed frame. What it does keep from ever leaving the page is a password: a password field's value is
 * sent as its length only.
 *
 * Node format: an element `{i, n, a?, c?, ns?, s?, ss?, rg?, w?, h?, v?, k?, sx?, sy?}` (id, tag, attributes,
 * children, namespace 1 svg / 2 mathml, open shadow root `{i, c, ss}`, adopted sheets, picture region 1 replaced /
 * 2 closed shadow, the box, form value, checked, scroll offsets); a text node `{i, t}`. Ops in a batch:
 * `kids {i, c}` (the node's whole child list: known children as `{r: id}`), `attr {i, k, v}`, `text {i, t}`,
 * `css {i, t}`, `val {i, v, k}`, `scroll {i, x, y}` (0 is the document), `focus {i}`, `rect {i, x, y, w, h}`
 * (document coordinates), `ptr {x, y, d}`, `vp {w, h}`.
 *
 * Plain JavaScript in a string: it is evaluated by Chrome, never bundled.
 */
export const MIRROR_WORLD = "__autora_mirror";
export const MIRROR_BINDING = "__autoraMirrorOut";

export const MIRROR_SCRIPT = String.raw`
(() => {
  if (window.__autoraMirror || window.top !== window) return;
  const send = (msg) => { try { window.__autoraMirrorOut(JSON.stringify(msg)); } catch (e) { /* the binding is gone: the page is closing */ } };
  const SKIP = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "META", "BASE", "TITLE"]);
  const REGION = new Set(["CANVAS", "VIDEO", "IFRAME", "FRAME", "EMBED", "OBJECT"]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MATH_NS = "http://www.w3.org/1998/Math/MathML";
  const URL_ATTRS = new Set(["src", "href", "poster", "xlink:href", "background", "action", "data"]);
  const ids = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  let gen = 0;
  const idOf = (node) => {
    let id = ids.get(node);
    if (!id) { id = nextId++; ids.set(node, id); byId.set(id, new WeakRef(node)); }
    return id;
  };
  const known = (node) => ids.get(node);
  const nodeOf = (id) => { const ref = byId.get(id); return ref ? ref.deref() : undefined; };
  const regions = new Map();
  const lastVals = new WeakMap();
  const sheetLens = new WeakMap();

  const abs = (v) => { try { return new URL(v, document.baseURI).href; } catch (e) { return ""; } };
  const absSet = (v) => String(v).split(",").map((part) => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return "";
    bits[0] = abs(bits[0]);
    return bits.join(" ");
  }).filter(Boolean).join(", ");

  const skipped = (el) => SKIP.has(el.tagName.toUpperCase()) || el.hasAttribute("data-autora") || el.id === "__autora_cursor"
    || (el.tagName === "LINK" && !/(^|\s)stylesheet(\s|$)/i.test(el.getAttribute("rel") || ""));

  const sheetText = (sheet) => {
    try { return Array.from(sheet.cssRules).map((r) => r.cssText).join("\n"); } catch (e) { return null; }
  };
  const adopted = (root) => {
    try { return (root.adoptedStyleSheets || []).map(sheetText).filter((t) => t !== null); } catch (e) { return []; }
  };
  const isPassword = (el) => el.tagName === "INPUT" && String(el.type).toLowerCase() === "password";
  const masked = (el) => "•".repeat(Math.min(String(el.value || "").length, 64));
  const valueOf = (el) => {
    if (el.tagName === "SELECT") return String(el.selectedIndex);
    if (isPassword(el)) return masked(el);
    return String(el.value == null ? "" : el.value);
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };

  function attrs(el) {
    const out = {};
    for (const a of Array.from(el.attributes)) {
      const k = a.name;
      let v = a.value;
      if (URL_ATTRS.has(k.toLowerCase())) v = abs(v);
      else if (k === "srcset") v = absSet(v);
      out[k] = v;
    }
    if (isPassword(el) && "value" in out) out.value = "";
    return out;
  }

  /* An image whose address is the page's own blob: the server cannot fetch it, so its pixels travel instead. */
  function blobPixels(el, out) {
    if (el.tagName !== "IMG" || !/^blob:/.test(el.currentSrc || el.src || "") || !el.complete || !el.naturalWidth) return;
    if (el.naturalWidth * el.naturalHeight > 1200 * 1200) return;
    try {
      const c = document.createElement("canvas");
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext("2d").drawImage(el, 0, 0);
      out.src = c.toDataURL("image/webp", 0.85);
      delete out.srcset;
    } catch (e) { /* tainted */ }
  }

  function ser(node, depth) {
    if (node.nodeType === 3) return { i: idOf(node), t: node.data };
    if (node.nodeType !== 1 || depth > 400) return null;
    const el = node;
    if (skipped(el)) return null;
    const out = { i: idOf(el), n: el.localName };
    if (el.namespaceURI === SVG_NS) out.ns = 1;
    else if (el.namespaceURI === MATH_NS) out.ns = 2;
    out.a = attrs(el);
    blobPixels(el, out.a);
    const tag = el.tagName.toUpperCase();
    if (REGION.has(tag)) {
      out.rg = 1;
      const b = box(el);
      out.w = b.w; out.h = b.h;
      regions.set(out.i, el);
      return out;
    }
    if (tag === "STYLE") {
      const t = el.sheet ? sheetText(el.sheet) : null;
      out.c = [{ i: -1, t: t !== null ? t : el.textContent || "" }];
      if (el.sheet) { try { sheetLens.set(el, el.sheet.cssRules.length); } catch (e) { /* cross-origin */ } }
      return out;
    }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      out.v = valueOf(el);
      if (el.checked) out.k = 1;
      lastVals.set(el, out.v + (el.checked ? "\u0001" : ""));
    }
    if (el.scrollTop || el.scrollLeft) { out.sx = el.scrollLeft; out.sy = el.scrollTop; }
    const kids = [];
    for (let c = el.firstChild; c; c = c.nextSibling) { const s = ser(c, depth + 1); if (s) kids.push(s); }
    if (kids.length) out.c = kids;
    const sr = el.shadowRoot;
    if (sr) {
      watch(sr);
      const sk = [];
      for (let c = sr.firstChild; c; c = c.nextSibling) { const s = ser(c, depth + 1); if (s) sk.push(s); }
      out.s = { i: idOf(sr), c: sk, ss: adopted(sr) };
    } else if (el.localName.includes("-") && !el.firstChild) {
      /* A custom element with nothing in it and no open shadow root has a closed one, or none: if it takes up
         room, something is drawn there that the DOM does not show, so it is a picture. */
      const b = box(el);
      if (b.w * b.h > 64) { out.rg = 2; out.w = b.w; out.h = b.h; regions.set(out.i, el); }
    }
    return out;
  }

  const observer = new MutationObserver((records) => { for (const r of records) queue.push(r); schedule(); });
  const watching = new WeakSet();
  function watch(root) {
    if (watching.has(root)) return;
    watching.add(root);
    observer.observe(root, { childList: true, attributes: true, characterData: true, subtree: true });
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }

  let queue = [];
  const extra = [];
  const scrolls = new Map();
  let ptr = null;
  let timer = 0;
  let raf = 0;
  function schedule() {
    if (timer) return;
    /* A frame, or 16ms when the page is not drawing frames. */
    raf = requestAnimationFrame(flush);
    timer = setTimeout(flush, 16);
  }

  function snapshot() {
    queue = []; extra.length = 0; scrolls.clear(); regions.clear();
    gen += 1;
    const root = document.documentElement ? ser(document.documentElement, 0) : null;
    send({
      op: "snapshot", gen, url: location.href, base: document.baseURI, title: document.title,
      vw: innerWidth, vh: innerHeight, dw: document.documentElement ? document.documentElement.scrollWidth : 0,
      dh: document.documentElement ? document.documentElement.scrollHeight : 0, sx: scrollX, sy: scrollY,
      root, ss: adopted(document), mode: document.compatMode,
      dir: document.documentElement ? document.documentElement.getAttribute("dir") : null,
    });
    for (const [id, el] of regions) extra.push({ o: "rect", i: id, ...box(el) });
    if (document.activeElement && known(document.activeElement)) extra.push({ o: "focus", i: known(document.activeElement) });
    schedule();
  }

  function flush() {
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(timer);
    timer = 0; raf = 0;
    const records = queue;
    queue = [];
    const ops = [];
    const dirty = new Set();
    const attrsSeen = new Map();
    const texts = new Set();
    for (const r of records) {
      if (r.type === "childList" && r.target.nodeType === 9) { snapshot(); return; }
      if (r.type === "childList") dirty.add(r.target);
      else if (r.type === "attributes") {
        if (!known(r.target)) continue;
        let set = attrsSeen.get(r.target);
        if (!set) { set = new Set(); attrsSeen.set(r.target, set); }
        set.add(r.attributeName);
      } else if (r.type === "characterData") texts.add(r.target);
    }
    const depth = (n) => { let d = 0; for (let p = n; p; p = p.parentNode || p.host) d += 1; return d; };
    const parents = Array.from(dirty).filter((n) => known(n) && n.isConnected).sort((a, b) => depth(a) - depth(b));
    for (const p of parents) {
      if (p.nodeType === 1 && p.tagName === "STYLE") { ops.push({ o: "css", i: known(p), t: p.sheet ? (sheetText(p.sheet) || p.textContent || "") : p.textContent || "" }); continue; }
      if (p.nodeType === 1 && (REGION.has(p.tagName) || skipped(p))) continue;
      const c = [];
      for (let k = p.firstChild; k; k = k.nextSibling) {
        const id = known(k);
        if (id && (k.nodeType === 3 || !skipped(k))) c.push({ r: id });
        else { const s = ser(k, depth(k)); if (s) c.push(s); }
      }
      ops.push({ o: "kids", i: known(p), c });
    }
    for (const [el, names] of attrsSeen) {
      if (!el.isConnected) continue;
      for (const k of names) {
        let v = el.getAttribute(k);
        if (v !== null && URL_ATTRS.has(k.toLowerCase())) v = abs(v);
        else if (v !== null && k === "srcset") v = absSet(v);
        if (isPassword(el) && k === "value") v = "";
        ops.push({ o: "attr", i: known(el), k, v });
      }
    }
    for (const t of texts) {
      if (!t.isConnected) continue;
      const parent = t.parentNode;
      if (parent && parent.nodeType === 1 && parent.tagName === "STYLE") { if (known(parent)) ops.push({ o: "css", i: known(parent), t: parent.textContent || "" }); }
      else if (known(t)) ops.push({ o: "text", i: known(t), t: t.data });
    }
    for (const [id, at] of scrolls) ops.push({ o: "scroll", i: id, x: at.x, y: at.y });
    scrolls.clear();
    if (ptr) { ops.push({ o: "ptr", ...ptr }); ptr = null; }
    ops.push(...extra.splice(0));
    if (ops.length) send({ op: "batch", gen, m: ops });
  }

  function onScroll(e) {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.scrollingElement) scrolls.set(0, { x: Math.round(scrollX), y: Math.round(scrollY) });
    else if (t.nodeType === 1 && known(t)) scrolls.set(known(t), { x: Math.round(t.scrollLeft), y: Math.round(t.scrollTop) });
    schedule();
  }

  /* Values a script set without an input event, sheets grown by insertRule, and boxes of the picture regions: read
     a few times a second rather than on every change, since none of them say when they change. */
  const regionBoxes = new Map();
  function poll() {
    if (!document.documentElement) return;
    let changed = false;
    const fields = document.querySelectorAll("input, textarea, select");
    for (let n = 0; n < fields.length && n < 800; n += 1) {
      const el = fields[n];
      const id = known(el);
      if (!id) continue;
      const v = valueOf(el);
      const key = v + (el.checked ? "\u0001" : "");
      if (lastVals.get(el) !== key) { lastVals.set(el, key); extra.push({ o: "val", i: id, v, k: el.checked ? 1 : 0 }); changed = true; }
    }
    for (const st of document.querySelectorAll("style")) {
      const id = known(st);
      if (!id || !st.sheet) continue;
      let len = -1;
      try { len = st.sheet.cssRules.length; } catch (e) { continue; }
      if (sheetLens.get(st) !== len) { sheetLens.set(st, len); extra.push({ o: "css", i: id, t: sheetText(st.sheet) || "" }); changed = true; }
    }
    for (const [id, el] of regions) {
      if (!el.isConnected) { regions.delete(id); regionBoxes.delete(id); continue; }
      const b = box(el);
      const was = regionBoxes.get(id);
      if (!was || was.x !== b.x || was.y !== b.y || was.w !== b.w || was.h !== b.h) {
        regionBoxes.set(id, b);
        extra.push({ o: "rect", i: id, ...b });
        changed = true;
      }
    }
    if (changed) schedule();
  }

  const opt = { capture: true, passive: true };
  const onValue = (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1 || !known(el)) return;
    const v = valueOf(el);
    lastVals.set(el, v + (el.checked ? "\u0001" : ""));
    extra.push({ o: "val", i: known(el), v, k: el.checked ? 1 : 0 });
    schedule();
  };
  function start() {
    if (!document.documentElement) return;
    watch(document);
    document.addEventListener("input", onValue, opt);
    document.addEventListener("change", onValue, opt);
    document.addEventListener("focusin", (e) => { const id = known(e.target); if (id) { extra.push({ o: "focus", i: id }); schedule(); } }, opt);
    const move = (d) => (e) => { if (e.isTrusted) { ptr = { x: Math.round(e.clientX), y: Math.round(e.clientY), d }; schedule(); } };
    window.addEventListener("mousemove", move(0), opt);
    window.addEventListener("mousedown", move(1), opt);
    window.addEventListener("mouseup", move(0), opt);
    window.addEventListener("resize", () => { extra.push({ o: "vp", w: innerWidth, h: innerHeight }); schedule(); }, opt);
    setInterval(poll, 250);
    snapshot();
  }

  window.__autoraMirror = {
    snapshot,
    /* Where a node is now, for input aimed at it (viewport coordinates), or null when it has gone. */
    rect(id) {
      const el = nodeOf(id);
      if (!el || !el.isConnected || el.nodeType !== 1) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    /* The person scrolled the mirror: the real page follows. */
    scroll(id, x, y) {
      if (!id) { window.scrollTo(x, y); return true; }
      const el = nodeOf(id);
      if (!el || el.nodeType !== 1) return false;
      el.scrollLeft = x; el.scrollTop = y;
      return true;
    },
    prune() { for (const [id, ref] of byId) if (!ref.deref()) byId.delete(id); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  setInterval(() => { if (byId.size > 50000) window.__autoraMirror.prune(); }, 10000);
})();
`;
