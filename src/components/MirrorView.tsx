import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { mirrorTraffic, subscribeMirror, type MirrorChannel } from "../lib/liveMirror";
import { MirrorDom, type MirrorRegion, type MirrorSnapshot } from "../lib/mirrorDom";
import { NAMED_KEYS } from "../lib/pageInput";

/** The frame's first document: no scripts, and nothing loaded from anywhere but Autora itself. Read when the frame
    is parsed, so it holds for everything the copy puts in it afterwards. */
const POLICY = "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
  + "media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const frameDoc = (quirks: boolean) =>
  `${quirks ? "" : "<!doctype html>"}<html><head><meta http-equiv="Content-Security-Policy" content="${POLICY}"></head><body></body></html>`;
/** A picture of nothing at the page's size: the stage's `.frame` rules size it exactly as they size a screencast
    frame, and the copy is laid over it. */
const spacer = (w: number, h: number) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E`;

const editable = (el: EventTarget | null): boolean => {
  const e = el as HTMLElement | null;
  if (!e || e.nodeType !== 1) return false;
  if (e.isContentEditable) return true;
  if (e.tagName === "TEXTAREA") return true;
  if (e.tagName !== "INPUT") return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"].includes((e as HTMLInputElement).type);
};
/** Keys whose effect in a field the copy shows itself at once (the caret, a deleted letter) as well as sending. */
const ECHO_KEYS = new Set(["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * The live page as a copy of its DOM, drawn by the person's own browser (server/mirror.ts): scrolling, text and
 * hover are local, and only what the person does goes to the real page. A frame with `allow-same-origin` and never
 * `allow-scripts`, plus a policy that loads nothing but Autora's own resource tokens: nothing the site wrote runs.
 *
 * `local`: input lands on the copy itself (a desktop, the board, full screen). Otherwise the copy takes no pointer
 * and the stage's own handlers treat it like the picture (a phone in the thread, where a finger scrolls the chat).
 */
export function MirrorView({
  sessionId, channel = "browser", local, usable, driving, readout, hidden, send, onReady, onUnhealthy, children,
}: {
  sessionId: string;
  /** Whose page: the live browser's (the default), or the app window's, which has its own Chromium and its own routes. */
  channel?: MirrorChannel;
  local: boolean;
  usable: boolean;
  driving: boolean;
  readout: boolean;
  /** Still being built under the picture: drawn but not shown, so the switch has no blank moment. */
  hidden: boolean;
  send: (path: string, body: unknown) => Promise<any>;
  onReady: (ready: boolean) => void;
  onUnhealthy: (reason: string) => void;
  children?: ReactNode;
}) {
  const [quirks, setQuirks] = useState(false);
  const [vp, setVp] = useState({ w: 1280, h: 800 });
  /** How the copy sits in the space the picture would take: scaled and centred as `object-fit: contain` would. */
  const [fit, setFit] = useState({ s: 1, x: 0, y: 0 });
  const [doc, setDoc] = useState<Document | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLImageElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const domRef = useRef<MirrorDom | null>(null);
  const live = useRef({ usable, driving, send, onReady, onUnhealthy, quirks, vp });
  live.current = { usable, driving, send, onReady, onUnhealthy, quirks, vp };
  /** When the person last typed into, or scrolled, each part of the copy: the page's own word on it waits. */
  const localAt = useRef({ typed: 0, scrolled: new Map<number, number>() });
  const stats = useRef({ latency: [] as number[], clickAt: 0, fps: 0, frames: 0, scrollingUntil: 0 });
  const [shownStats, setShownStats] = useState<string>("");

  // The copy is scaled to the space the picture would take; its own layout stays at the page's size.
  useLayoutEffect(() => {
    const spacer = spacerRef.current;
    const wrap = wrapRef.current;
    if (!spacer || !wrap) return;
    const place = () => {
      // The picture's own box can run past the stage (a pane sizes it by height); the copy fits what is visible.
      const w = Math.min(spacer.clientWidth, wrap.clientWidth || spacer.clientWidth);
      const h = Math.min(spacer.clientHeight, wrap.clientHeight || spacer.clientHeight);
      const s = Math.max(0.05, Math.min(w / Math.max(1, vp.w), h / Math.max(1, vp.h)));
      setFit({ s, x: Math.max(0, (w - vp.w * s) / 2), y: Math.max(0, (h - vp.h * s) / 2) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(spacer);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [vp.w, vp.h]);

  // Build the copy once the frame's empty, script-free document is there, and keep it up to date.
  useEffect(() => {
    if (!doc) return;
    const own = live.current;
    const dom = new MirrorDom(doc, `/api/sessions/${encodeURIComponent(sessionId)}/${channel === "preview" ? "preview" : "browser"}/mirror/r/`, {
      holdValue: (el) => el === doc.activeElement && Date.now() - localAt.current.typed < 1500,
      holdScroll: (id) => Date.now() - (localAt.current.scrolled.get(id) ?? 0) < 400,
      onFocus: (el) => { if (doc.hasFocus() && el !== doc.activeElement) (el as HTMLElement).focus?.({ preventScroll: true }); },
      onPointer: (x, y, down) => {
        const c = cursorRef.current;
        const { vp: size } = live.current;
        if (!c) return;
        c.style.left = `${(x / size.w) * 100}%`;
        c.style.top = `${(y / size.h) * 100}%`;
        c.classList.toggle("is-down", down);
        c.classList.add("is-on");
      },
      onViewport: (w, h) => { if (w > 0 && h > 0) setVp({ w, h }); },
    });
    domRef.current = dom;
    let resyncAt = 0;
    let checkTimer = 0;
    const decode = (src: string) => new Promise<CanvasImageSource | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    const ready = (snap: MirrorSnapshot) => {
      // Shown once its style sheets are in (or a moment has passed): shown before, it would flash unstyled.
      const sheets = Array.from(doc.querySelectorAll("link[rel~='stylesheet']")) as HTMLLinkElement[];
      const loaded = sheets.map((l) => (l.sheet ? Promise.resolve() : new Promise<void>((r) => {
        l.addEventListener("load", () => r(), { once: true });
        l.addEventListener("error", () => r(), { once: true });
      })));
      void Promise.race([Promise.all(loaded), new Promise((r) => setTimeout(r, 1500))]).then(() => {
        if (domRef.current !== dom || dom.gen !== snap.gen) return;
        dom.placeScrolls();
        own.onReady(true);
        // A copy whose page came out a different length than the real one is laid out wrong: pictures instead.
        window.clearTimeout(checkTimer);
        checkTimer = window.setTimeout(() => {
          if (domRef.current !== dom || dom.gen !== snap.gen) return;
          const mine = doc.documentElement?.scrollHeight ?? 0;
          if (snap.dh > snap.vh * 1.2 && Math.abs(mine - snap.dh) / snap.dh > 0.35) {
            live.current.onUnhealthy("the copy's layout came out different from the page");
          }
        }, 1500);
      });
    };
    const off = subscribeMirror(sessionId, (msg) => {
      if (msg.op === "snapshot") {
        const snap = msg as unknown as MirrorSnapshot;
        if (!!snap.quirks !== live.current.quirks) { setQuirks(!!snap.quirks); return; }
        if (snap.vw > 0 && snap.vh > 0) setVp({ w: snap.vw, h: snap.vh });
        live.current.onReady(false);
        dom.snapshot(snap);
        ready(snap);
      } else if (msg.op === "batch") {
        if (msg.gen !== dom.gen) return;
        const st = stats.current;
        if (st.clickAt) { st.latency = [...st.latency.slice(-19), Date.now() - st.clickAt]; st.clickAt = 0; }
        if (!dom.apply(msg.m) && Date.now() - resyncAt > 2000) {
          resyncAt = Date.now();
          void fetch(`/api/sessions/${sessionId}/browser/mirror/resync${channel === "preview" ? "?target=preview" : ""}`, { method: "POST" }).catch(() => undefined);
        }
      } else if (msg.op === "region") {
        void dom.region(msg as unknown as MirrorRegion, decode);
      }
    }, channel);
    return () => { off(); window.clearTimeout(checkTimer); if (domRef.current === dom) domRef.current = null; };
  }, [doc, sessionId, channel]);

  // The person's input on the copy, sent to the real page.
  useEffect(() => {
    if (!doc || !local) return;
    const win = doc.defaultView;
    const dom = () => domRef.current;
    const at = (e: MouseEvent) => {
      const id = dom()?.idOf(e.target as Node) ?? null;
      const el = id ? (dom()?.node(id) as Element | undefined) : undefined;
      const b = el?.getBoundingClientRect?.();
      return {
        x: Math.round(e.clientX), y: Math.round(e.clientY), node: id,
        fx: b && b.width > 0 ? (e.clientX - b.left) / b.width : 0.5,
        fy: b && b.height > 0 ? (e.clientY - b.top) / b.height : 0.5,
      };
    };
    // Typing is gathered for a moment and sent as one, like the picture's keyboard.
    let text = "";
    let textTimer = 0;
    const flush = () => { window.clearTimeout(textTimer); textTimer = 0; const t = text; text = ""; if (t) void live.current.send("type", { text: t }); };
    const typeText = (t: string) => { text += t; localAt.current.typed = Date.now(); if (!textTimer) textTimer = window.setTimeout(flush, 40); };
    const go = (path: string, body: unknown) => { flush(); return live.current.send(path, body); };
    let lastKey = "";
    let down: { x: number; y: number; dragging: boolean; mouse: boolean; at: ReturnType<typeof at> } | null = null;
    let hoverTimer = 0;
    let hoverId: number | null = null;
    const scrollTimers = new Map<number, number>();

    const onPointerDown = (e: PointerEvent) => {
      if (!live.current.usable || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, dragging: false, mouse: e.pointerType === "mouse", at: at(e) };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!live.current.usable) return;
      if (down?.mouse && (e.buttons & 1)) {
        if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) {
          down.dragging = true;
          void go("drag", { phase: "start", x: down.at.x, y: down.at.y });
        }
        if (down.dragging) { e.preventDefault(); void go("drag", { phase: "move", x: Math.round(e.clientX), y: Math.round(e.clientY) }); }
        return;
      }
      // A pointer that rests on something new moves the real mouse there, for a menu that opens on hover.
      if (e.pointerType !== "mouse") return;
      const id = dom()?.idOf(e.target as Node) ?? null;
      if (id === hoverId) return;
      hoverId = id;
      window.clearTimeout(hoverTimer);
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      hoverTimer = window.setTimeout(() => { if (live.current.usable) void go("hover", { x, y }); }, 160);
    };
    const onPointerUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (d?.dragging) void go("drag", { phase: "end", x: Math.round(e.clientX), y: Math.round(e.clientY) });
    };
    const onClick = (e: MouseEvent) => {
      // A link, a submit, a checkbox: nothing happens in the copy on its own; the real page does it and the copy follows.
      e.preventDefault();
      if (!live.current.usable || e.button !== 0 || down?.dragging) return;
      stats.current.clickAt = Date.now();
      void go("click", { ...at(e), button: "left", double: e.detail === 2 });
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      if (live.current.usable) void go("click", { ...at(e), button: "right" });
    };
    const canScroll = (start: Element | null, dx: number, dy: number): boolean => {
      for (let n: Element | null = start; n && n !== doc.documentElement; n = n.parentElement) {
        const cs = win?.getComputedStyle(n);
        if (!cs) break;
        if (dy && /(auto|scroll)/.test(cs.overflowY) && (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) return true;
        if (dx && /(auto|scroll)/.test(cs.overflowX) && (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0)) return true;
      }
      const se = doc.scrollingElement;
      if (!se) return false;
      return (dy > 0 && se.scrollTop + se.clientHeight < se.scrollHeight - 1) || (dy < 0 && se.scrollTop > 0)
        || (dx > 0 && se.scrollLeft + se.clientWidth < se.scrollWidth - 1) || (dx < 0 && se.scrollLeft > 0);
    };
    let wheel = { dx: 0, dy: 0, timer: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!live.current.usable) { e.preventDefault(); return; }
      // The copy scrolls itself where it can: that is local, and immediate. Where it cannot (a map, a page that
      // scrolls by script), the wheel goes to the real page.
      if (canScroll(e.target as Element, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      wheel.dx += e.deltaX;
      wheel.dy += e.deltaY;
      if (!wheel.timer) wheel.timer = window.setTimeout(() => { const { dx, dy } = wheel; wheel = { dx: 0, dy: 0, timer: 0 }; void go("scroll", { dx, dy }); }, 35);
    };
    const onScroll = (e: Event) => {
      const t = e.target as Node;
      const isDoc = t === doc || t === doc.documentElement || t === doc.scrollingElement;
      const id = isDoc ? 0 : dom()?.idOf(t) ?? null;
      if (id === null || dom()?.placedByPage(isDoc ? doc : t)) return;
      if (!live.current.usable) return;
      localAt.current.scrolled.set(id, Date.now());
      stats.current.scrollingUntil = Date.now() + 250;
      if (scrollTimers.has(id)) return;
      // Sent a few times a second, and once more where it came to rest.
      scrollTimers.set(id, window.setTimeout(() => {
        scrollTimers.delete(id);
        const el = isDoc ? doc.scrollingElement : (t as Element);
        if (el) void go("mirror/scroll", { node: id, x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop) });
      }, 80));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!live.current.usable) { e.preventDefault(); return; }
      const field = editable(e.target);
      const mod = e.ctrlKey || e.metaKey;
      lastKey = e.key;
      if (mod && e.key.length === 1) {
        const k = e.key.toLowerCase();
        if (k === "v" || k === "c") return; // the paste event carries it; a copy is the person's own, from the copy
        e.preventDefault();
        void go("key", { key: `Control+${k}` });
        return;
      }
      if (NAMED_KEYS.has(e.key)) {
        if (!(field && ECHO_KEYS.has(e.key))) e.preventDefault();
        else localAt.current.typed = Date.now();
        void go("key", { key: e.key });
        return;
      }
      // Off a field, a key is the page's (a space that scrolls, a shortcut): nothing happens in the copy.
      if (!field && e.key.length === 1) { e.preventDefault(); typeText(e.key); }
    };
    const onInput = (e: Event) => {
      const ie = e as InputEvent;
      if (ie.isComposing || !live.current.usable) return;
      localAt.current.typed = Date.now();
      if (ie.inputType === "insertFromPaste") return;
      if (ie.inputType.startsWith("insert") && ie.data) typeText(ie.data);
      else if (ie.inputType === "deleteContentBackward" && lastKey !== "Backspace") void go("key", { key: "Backspace" });
    };
    const onCompositionEnd = (e: CompositionEvent) => { if (live.current.usable && e.data) typeText(e.data); };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.clipboardData?.getData("text") ?? "";
      if (!editable(e.target)) e.preventDefault();
      if (live.current.usable && t) typeText(t);
    };
    const onSubmit = (e: Event) => e.preventDefault();
    const opt = { capture: true };
    const passive = { capture: true, passive: true };
    doc.addEventListener("pointerdown", onPointerDown, opt);
    doc.addEventListener("pointermove", onPointerMove, opt);
    doc.addEventListener("pointerup", onPointerUp, opt);
    doc.addEventListener("click", onClick, opt);
    doc.addEventListener("auxclick", onClick, opt);
    doc.addEventListener("contextmenu", onContext, opt);
    doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
    doc.addEventListener("scroll", onScroll, passive);
    doc.addEventListener("keydown", onKeyDown, opt);
    doc.addEventListener("input", onInput, opt);
    doc.addEventListener("compositionend", onCompositionEnd, opt);
    doc.addEventListener("paste", onPaste, opt);
    doc.addEventListener("submit", onSubmit, opt);
    doc.addEventListener("dragstart", onSubmit, opt);
    return () => {
      flush();
      window.clearTimeout(hoverTimer);
      window.clearTimeout(wheel.timer);
      for (const t of scrollTimers.values()) window.clearTimeout(t);
      doc.removeEventListener("pointerdown", onPointerDown, opt);
      doc.removeEventListener("pointermove", onPointerMove, opt);
      doc.removeEventListener("pointerup", onPointerUp, opt);
      doc.removeEventListener("click", onClick, opt);
      doc.removeEventListener("auxclick", onClick, opt);
      doc.removeEventListener("contextmenu", onContext, opt);
      doc.removeEventListener("wheel", onWheel, { capture: true });
      doc.removeEventListener("scroll", onScroll, passive);
      doc.removeEventListener("keydown", onKeyDown, opt);
      doc.removeEventListener("input", onInput, opt);
      doc.removeEventListener("compositionend", onCompositionEnd, opt);
      doc.removeEventListener("paste", onPaste, opt);
      doc.removeEventListener("submit", onSubmit, opt);
      doc.removeEventListener("dragstart", onSubmit, opt);
    };
  }, [doc, local]);

  // The readout (a dev setting): what R7 in the intent is measured against.
  useEffect(() => {
    if (!readout || !doc) return;
    const win = doc.defaultView;
    let raf = 0;
    const tick = () => {
      if (Date.now() < stats.current.scrollingUntil) stats.current.frames += 1;
      raf = win?.requestAnimationFrame(tick) ?? 0;
    };
    raf = win?.requestAnimationFrame(tick) ?? 0;
    const timer = window.setInterval(() => {
      const st = stats.current;
      if (st.frames) st.fps = st.frames;
      st.frames = 0;
      const t = mirrorTraffic();
      const lat = [...st.latency].sort((a, b) => a - b);
      const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
      setShownStats(`${st.fps} fps scrolling · click→change ${median === null ? "–" : `${median} ms`} · `
        + `${(t.bytesPerSecond / 1024).toFixed(1)} KB/s · ${t.opsPerSecond} changes/s · snapshot ${(t.snapshotBytes / 1024).toFixed(0)} KB`);
    }, 1000);
    return () => { win?.cancelAnimationFrame(raf); window.clearInterval(timer); };
  }, [readout, doc]);

  // The agent's pointer is the page's own, drawn over the copy where the real mouse is; only while the agent drives.
  useEffect(() => { if (!driving) cursorRef.current?.classList.remove("is-on"); }, [driving]);

  return (
    <div ref={wrapRef} className={`frame-wrap mirror-wrap${hidden ? " is-hidden" : ""}`} aria-hidden={hidden || undefined}>
      <img ref={spacerRef} className="frame mirror-spacer" src={spacer(vp.w, vp.h)} alt={hidden ? "" : "the page, live"} draggable={false} />
      <div
        className={`mirror-layer${local && usable ? " is-local" : ""}`}
        style={{ left: fit.x, top: fit.y, width: vp.w * fit.s, height: vp.h * fit.s }}
      >
        <iframe
          key={quirks ? "quirks" : "standards"}
          className="mirror-frame"
          title="The page, live"
          sandbox="allow-same-origin"
          srcDoc={frameDoc(quirks)}
          tabIndex={local && usable ? 0 : -1}
          style={{ width: vp.w, height: vp.h, transform: `scale(${fit.s})` }}
          onLoad={(e) => setDoc(e.currentTarget.contentDocument)}
        />
        {driving && <span ref={cursorRef} className="mirror-cursor" aria-hidden="true" />}
      </div>
      {children}
      {readout && !hidden && <div className="mirror-readout" role="status">{shownStats || "measuring…"}</div>}
    </div>
  );
}
