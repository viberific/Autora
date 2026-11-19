import { useSyncExternalStore } from "react";
import type { MirrorRegion, MirrorSnapshot } from "./mirrorDom";

/**
 * The mirror view's messages off the session's socket (server/mirror.ts), kept outside React state like the live
 * frame (lib/liveFrame.ts): a busy page sends dozens of batches a second, and only the window drawing the copy
 * listens to them. A window that mounts late starts from the last snapshot and the batches since.
 *
 * Which view the person wants (the mirror, or pictures) is theirs, kept per browser: the mirror is a preview until
 * it meets the targets in intent/2026-11-19-new-web-browser-architecture.md (R7), so pictures stay the default.
 */

type Msg = Record<string, any> & { op: string };
type MirrorState = { status: "off" | "starting" | "live" | "fallback"; reason: string | null; url: string };

let session: string | null = null;
let status: MirrorState | null = null;
let snapshot: MirrorSnapshot | null = null;
let batches: Msg[] = [];
let regions = new Map<number, MirrorRegion>();
const listeners = new Set<(msg: Msg) => void>();
const statusListeners = new Set<() => void>();

/** What the readout shows: bytes and changes over the last few seconds, and the last snapshot's size. */
const traffic: Array<{ at: number; bytes: number; ops: number }> = [];

export function mirrorTraffic() {
  const now = Date.now();
  while (traffic.length && traffic[0].at < now - 3000) traffic.shift();
  const bytes = traffic.reduce((s, t) => s + t.bytes, 0);
  const ops = traffic.reduce((s, t) => s + t.ops, 0);
  return { bytesPerSecond: Math.round(bytes / 3), opsPerSecond: Math.round(ops / 3), snapshotBytes: snapshot?.size ?? 0 };
}

/** One message from the socket. */
export function pushMirror(msg: Msg, bytes: number) {
  const from = typeof msg.session === "string" ? msg.session : null;
  if (from !== session) {
    session = from;
    status = null;
    snapshot = null;
    batches = [];
    regions = new Map();
  }
  traffic.push({ at: Date.now(), bytes, ops: Array.isArray(msg.m) ? msg.m.length : msg.op === "snapshot" ? 1 : 0 });
  if (msg.op === "state") {
    status = { status: msg.status, reason: msg.reason ?? null, url: String(msg.url ?? "") };
    for (const l of statusListeners) l();
  } else if (msg.op === "snapshot") {
    snapshot = msg as unknown as MirrorSnapshot;
    batches = [];
    regions = new Map();
  } else if (msg.op === "batch") {
    if (!snapshot || msg.gen !== snapshot.gen) return;
    batches.push(msg);
    if (batches.length > 2000) batches = batches.slice(-2000);
  } else if (msg.op === "region") {
    regions.set(Number(msg.i), msg as unknown as MirrorRegion);
  }
  for (const l of listeners) l(msg);
}

/** Every message for `sessionId` from now on, after the ones a newcomer needs (the snapshot, then what came since). */
export function subscribeMirror(sessionId: string, fn: (msg: Msg) => void): () => void {
  if (session === sessionId && snapshot) {
    fn(snapshot as unknown as Msg);
    for (const b of batches) fn(b);
    for (const r of regions.values()) fn(r as unknown as Msg);
  }
  const l = (msg: Msg) => { if (msg.session === sessionId) fn(msg); };
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The mirror's state for this session (live, fallen back to pictures, off), or null before the server has said. */
export function useMirrorStatus(sessionId: string, on: boolean): MirrorState | null {
  return useSyncExternalStore(
    (l) => { statusListeners.add(l); return () => { statusListeners.delete(l); }; },
    () => (on && session === sessionId ? status : null),
  );
}

// ---------------------------------------------------------------- the person's choice of view --

const KEY = "autora.browserView";
const READOUT = "autora.mirrorReadout";
const viewListeners = new Set<() => void>();

function read(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* a private window: held for this page */ }
  memory.set(key, value);
  for (const l of viewListeners) l();
}
const memory = new Map<string, string>();
const get = (key: string, fallback: string) => memory.get(key) ?? read(key, fallback);

type BrowserView = "mirror" | "picture";

export function setBrowserView(view: BrowserView) { write(KEY, view); }
export function setMirrorReadout(on: boolean) { write(READOUT, on ? "on" : "off"); }

/** The view the person chose for the live browser: pictures unless they turned the mirror on. */
export function useBrowserView(): { view: BrowserView; readout: boolean } {
  const view = useSyncExternalStore(
    (l) => { viewListeners.add(l); return () => { viewListeners.delete(l); }; },
    () => (get(KEY, "picture") === "mirror" ? "mirror" : "picture"),
  );
  const readout = useSyncExternalStore(
    (l) => { viewListeners.add(l); return () => { viewListeners.delete(l); }; },
    () => get(READOUT, "off") === "on",
  );
  return { view, readout };
}

/** This window's name for itself when it tells the server which view it shows. */
export const VIEWER_ID = Math.random().toString(36).slice(2, 12);
