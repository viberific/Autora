/**
 * App windows on the canvas (docs/PANACEA-GAPS.md, G2): where each one is, how big, and in front of which. The person
 * moves, sizes, maximises and raises them by hand; the agent does the same through `panacea_arrange`. Both write here,
 * so a reload keeps every window where it was and the agent can see the layout it is working in.
 *
 * Pure: shared by the server and the page.
 */
import { WORKSPACE_MODES, type WorkspaceMode } from "../workspace";

export interface Box { x: number; y: number; w: number; h: number }

/** One app window's place: `id` is `engine:<mode>` as the board names it. `was` is the box it had before it was maximised. */
export interface WinBox extends Box {
  id: string;
  /** Stacking: the higher is in front. */
  z: number;
  was?: Box;
}

const MAX_WINDOWS = 16;
export const WIN_MIN = { w: 320, h: 240 };
const LIMIT = 100_000;

const num = (v: unknown, fallback: number, lo = -LIMIT, hi = LIMIT) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
const readBox = (raw: unknown): Box | null => {
  const r = raw as Record<string, unknown> | null;
  return r && typeof r === "object" ? { x: num(r.x, 0), y: num(r.y, 0), w: num(r.w, 640, 120, 8000), h: num(r.h, 480, 120, 8000) } : null;
};

/** The window ids a canvas can hold: an app other than the canvas itself. */
const MODES = (Object.keys(WORKSPACE_MODES) as WorkspaceMode[]).filter((m) => m !== "panacea");
const windowId = (mode: WorkspaceMode) => `engine:${mode}`;
const modeOf = (id: string): WorkspaceMode | null => MODES.find((m) => windowId(m) === id) ?? null;

export function readWindows(raw: unknown): WinBox[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WinBox[] = [];
  for (const item of raw.slice(0, MAX_WINDOWS)) {
    const r = item as Record<string, unknown> | null;
    const id = typeof r?.id === "string" ? r.id : "";
    const box = readBox(item);
    if (!box || !modeOf(id) || seen.has(id)) continue;
    seen.add(id);
    const was = readBox(r?.was);
    out.push({ id, ...box, z: num(r?.z, out.length, 0, 1_000_000), ...(was ? { was } : {}) });
  }
  return out;
}

/** The window an agent means by a word: a mode id (`studio`), the window's name (`Music`, `3D`) or its board id. */
export function windowNamed(word: unknown): string | null {
  const s = String(word ?? "").trim().toLowerCase();
  if (!s) return null;
  const mode = MODES.find((m) => m === s || WORKSPACE_MODES[m].name.toLowerCase() === s || windowId(m) === s);
  return mode ? windowId(mode) : null;
}

export const windowTitle = (id: string): string => { const m = modeOf(id); return m ? WORKSPACE_MODES[m].name : id; };

/** The topmost z, and one above it: what a window raised to the front takes. */
const frontZ = (windows: readonly WinBox[]) => windows.reduce((m, w) => Math.max(m, w.z), 0) + 1;

/** Sets one window's box (adding it if the canvas had none), raising it if it is not already in front. */
export function placeWindow(windows: WinBox[], id: string, box: Partial<Box>, opts: { front?: boolean } = {}): WinBox | null {
  if (!modeOf(id)) return null;
  let w = windows.find((x) => x.id === id);
  if (!w) {
    if (windows.length >= MAX_WINDOWS) return null;
    w = { id, x: 0, y: 0, w: 1056, h: 740, z: frontZ(windows) };
    windows.push(w);
  }
  if (box.x !== undefined) w.x = num(box.x, w.x);
  if (box.y !== undefined) w.y = num(box.y, w.y);
  if (box.w !== undefined) w.w = num(box.w, w.w, WIN_MIN.w, 8000);
  if (box.h !== undefined) w.h = num(box.h, w.h, WIN_MIN.h, 8000);
  if (opts.front) w.z = frontZ(windows.filter((x) => x !== w));
  return w;
}

/** Brings a window to the front; false when it was in front already (nothing to write). */
export function raise(windows: WinBox[], id: string): boolean {
  const w = windows.find((x) => x.id === id);
  if (!w) return false;
  const top = frontZ(windows.filter((x) => x !== w));
  if (w.z >= top) return false;
  w.z = top;
  return true;
}

/** Maximises a window to a room, remembering what it was; again (or `restore`), and it is given back. */
export function maximise(windows: WinBox[], id: string, room: { w: number; h: number }, pad = 16, to?: "max" | "restore"): "maximised" | "restored" | null {
  const w = windows.find((x) => x.id === id);
  if (!w) return null;
  if (w.was && to !== "max") {
    Object.assign(w, w.was);
    delete w.was;
    return "restored";
  }
  if (to === "restore") return null;
  if (!w.was) w.was = { x: w.x, y: w.y, w: w.w, h: w.h };
  w.w = Math.max(WIN_MIN.w, room.w - pad * 2);
  w.h = Math.max(WIN_MIN.h, room.h - pad * 2);
  w.z = frontZ(windows.filter((x) => x !== w));
  return "maximised";
}

/**
 * Lays boxes out in rows with a gap between, none over another, keeping their order (top to bottom, then left to right)
 * and their sizes. `width` is how wide a row may be before the next begins. Returns the new place of each, by id.
 */
export function tidy(items: ReadonlyArray<Box & { id: string }>, opts: { x?: number; y?: number; width?: number; gap?: number } = {}): Map<string, { x: number; y: number }> {
  const gap = opts.gap ?? 40;
  const width = Math.max(opts.width ?? 2400, 400);
  const startX = opts.x ?? Math.min(0, ...items.map((i) => i.x));
  const startY = opts.y ?? Math.min(0, ...items.map((i) => i.y));
  const order = [...items].sort((a, b) => Math.round(a.y / 200) - Math.round(b.y / 200) || a.x - b.x || a.id.localeCompare(b.id));
  const out = new Map<string, { x: number; y: number }>();
  let x = startX, y = startY, row = 0;
  for (const it of order) {
    if (x > startX && x + it.w > startX + width) { x = startX; y += row + gap; row = 0; }
    out.set(it.id, { x, y });
    x += it.w + gap;
    row = Math.max(row, it.h);
  }
  return out;
}

/** The windows in words, for the agent: where each is and which is in front. */
export function describeWindows(windows: readonly WinBox[]): string {
  if (!windows.length) return "";
  const front = [...windows].sort((a, b) => b.z - a.z);
  return `Windows (front first): ${front.map((w) => `${windowTitle(w.id)} ${w.w}x${w.h} at ${w.x},${w.y}${w.was ? " (maximised)" : ""}`).join("; ")}.`;
}
