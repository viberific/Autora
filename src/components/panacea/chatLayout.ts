import { useCallback, useState } from "react";

/** The floating conversation on a desktop: how far it keeps from the world's edges, how close to a side it must come
    before it is pulled onto it, its smallest size, and the size it opens at. */
export const FLOAT_GAP = 16;
export const FLOAT_SNAP = 56;
export const FLOAT_MIN_W = 360;
const FLOAT_MIN_H = 280;
const FLOAT_DEFAULT_W = 400;
const FLOAT_DEFAULT_H = 640;
/** How far an arrow key moves or resizes the window (four times this with Shift). */
export const FLOAT_STEP = 16;

/** Where the floating conversation stands in the world area, in pixels from its top-left corner. `snap` is the side it
    is held to: it stays on that side as the window is resized, and leaves it only when dragged away. */
export interface FloatBox { x: number; y: number; w: number; h: number; snap: "left" | "right" | null }
export interface Room { w: number; h: number }
/** Which edges of the window a resize handle moves: n, s, e, w or a corner. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** The two open heights of the phone's bottom sheet. Closed (peek) is the retracted conversation. */
export type Sheet = "half" | "full";

/** One line of the retracted sheet's preview: who said it and a flat, markdown-free run of what they said. */
export type PreviewLine = { who: "You" | "Autora"; text: string };

/** The last `count` things said, oldest first, flattened to plain text for a clamped line. Empty turns are skipped. */
export function previewOf(turns: readonly { role: "user" | "agent"; text: string }[], count = 2): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (let i = turns.length - 1; i >= 0 && lines.length < count; i -= 1) {
    const text = turns[i].text
      .replace(/```[\s\S]*?```/g, " code ")
      .replace(/[`*_#>~|]+/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.unshift({ who: turns[i].role === "user" ? "You" : "Autora", text: text.slice(0, 280) });
  }
  return lines;
}

const FLOAT_KEY = "autora.chat.float";
const SHEET_KEY = "autora.chat.sheet";

const between = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** Where the window opens: held to the left, at the foot of the world area, as tall as it allows up to the default. */
export function defaultFloat(room: Room): FloatBox {
  const w = Math.min(FLOAT_DEFAULT_W, Math.max(FLOAT_MIN_W, room.w - FLOAT_GAP * 2));
  const h = Math.min(FLOAT_DEFAULT_H, Math.max(FLOAT_MIN_H, room.h - FLOAT_GAP * 2));
  return clampFloat({ x: FLOAT_GAP, y: room.h - h - FLOAT_GAP, w, h, snap: "left" }, room);
}

/** Keeps the window inside the world area, a gap from every edge, and on the side it is held to. A room too small
    for the window's minimum lets it overhang the far edges rather than the near ones. */
export function clampFloat(box: FloatBox, room: Room): FloatBox {
  const w = Math.round(between(box.w, FLOAT_MIN_W, room.w - FLOAT_GAP * 2));
  const h = Math.round(between(box.h, FLOAT_MIN_H, room.h - FLOAT_GAP * 2));
  const maxX = room.w - w - FLOAT_GAP;
  const x = box.snap === "left" ? FLOAT_GAP : box.snap === "right" ? Math.max(FLOAT_GAP, maxX) : between(box.x, FLOAT_GAP, maxX);
  const y = between(box.y, FLOAT_GAP, room.h - h - FLOAT_GAP);
  return { x: Math.round(x), y: Math.round(y), w, h, snap: box.snap };
}

/** The magnet: a window brought within FLOAT_SNAP of a side is pulled onto it and held there; anywhere else it floats. */
export function magnet(box: FloatBox, room: Room): FloatBox {
  const left = box.x - FLOAT_GAP;
  const right = room.w - FLOAT_GAP - (box.x + box.w);
  const snap = left <= FLOAT_SNAP && left <= right ? "left" : right <= FLOAT_SNAP ? "right" : null;
  return clampFloat({ ...box, snap }, room);
}

/** The window stepped by (dx, dy), as the arrow keys step it. A step is shorter than the magnet reaches, so the magnet is
    not asked: the window is free once it steps off a side, and held again only when a step brings it up against one. */
export function nudgeFloat(box: FloatBox, dx: number, dy: number, room: Room): FloatBox {
  const free = clampFloat({ ...box, x: box.x + dx, y: box.y + dy, snap: null }, room);
  const snap = free.x <= FLOAT_GAP ? (dx > 0 ? null : "left") : free.x + free.w >= room.w - FLOAT_GAP ? (dx < 0 ? null : "right") : null;
  return clampFloat({ ...free, snap: dx === 0 ? box.snap : snap }, room);
}

/** The window after its `edge` has been dragged by (dx, dy). The opposite edges stay where they were, and a window held
    to a side stays held unless the edge on that side is the one pulled away from it. */
export function resizeFloat(start: FloatBox, edge: Edge, dx: number, dy: number, room: Room): FloatBox {
  let { x, y, w, h } = start;
  const maxW = Math.max(FLOAT_MIN_W, room.w - FLOAT_GAP * 2);
  const maxH = Math.max(FLOAT_MIN_H, room.h - FLOAT_GAP * 2);
  if (edge.includes("e")) w = between(start.w + dx, FLOAT_MIN_W, Math.min(maxW, room.w - FLOAT_GAP - start.x));
  if (edge.includes("w")) {
    w = between(start.w - dx, FLOAT_MIN_W, Math.min(maxW, start.x + start.w - FLOAT_GAP));
    x = start.x + start.w - w;
  }
  if (edge.includes("s")) h = between(start.h + dy, FLOAT_MIN_H, Math.min(maxH, room.h - FLOAT_GAP - start.y));
  if (edge.includes("n")) {
    h = between(start.h - dy, FLOAT_MIN_H, Math.min(maxH, start.y + start.h - FLOAT_GAP));
    y = start.y + start.h - h;
  }
  const snap = start.snap === "left" && edge.includes("w") && x > FLOAT_GAP + 1 ? null
    : start.snap === "right" && edge.includes("e") && x + w < room.w - FLOAT_GAP - 1 ? null
    : start.snap;
  return clampFloat({ x, y, w, h, snap }, room);
}

function readFloat(): FloatBox | null {
  try {
    const stored = JSON.parse(localStorage.getItem(FLOAT_KEY) ?? "null") as Partial<FloatBox> | null;
    if (!stored || ![stored.x, stored.y, stored.w, stored.h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const snap = stored.snap === "left" || stored.snap === "right" ? stored.snap : null;
    return { x: stored.x!, y: stored.y!, w: stored.w!, h: stored.h!, snap };
  } catch { return null; }
}

function readSheet(): Sheet {
  try { return localStorage.getItem(SHEET_KEY) === "full" ? "full" : "half"; } catch { return "half"; }
}

/** The person's chosen window place and size (desktop) and sheet height (phone), remembered between visits. A window
    never moved has no place yet (null): it opens at the default for whatever room there is. */
export function useChatLayout() {
  const [float, setFloatState] = useState<FloatBox | null>(readFloat);
  const [sheet, setSheetState] = useState<Sheet>(readSheet);
  const setFloat = useCallback((next: FloatBox | null) => {
    setFloatState(next);
    try {
      if (next) localStorage.setItem(FLOAT_KEY, JSON.stringify(next));
      else localStorage.removeItem(FLOAT_KEY);
    } catch { /* not remembered */ }
  }, []);
  const setSheet = useCallback((next: Sheet) => {
    setSheetState(next);
    try { localStorage.setItem(SHEET_KEY, next); } catch { /* not remembered */ }
  }, []);
  return { float, setFloat, sheet, setSheet };
}
