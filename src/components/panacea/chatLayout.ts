import { useCallback, useState } from "react";

/** How wide the docked conversation panel may be, in pixels (desktop), and the step an arrow key moves it. */
export const PANEL_MIN = 320;
export const PANEL_MAX = 640;
export const PANEL_DEFAULT = 380;
export const PANEL_STEP = 16;

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

const WIDTH_KEY = "autora.chat.width";
const SHEET_KEY = "autora.chat.sheet";

/** Keeps a width inside what the panel allows and what the window can spare. */
export function clampPanelWidth(width: number, room = Infinity): number {
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(room * 0.6)));
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)));
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampPanelWidth(stored) : PANEL_DEFAULT;
  } catch { return PANEL_DEFAULT; }
}

function readSheet(): Sheet {
  try { return localStorage.getItem(SHEET_KEY) === "full" ? "full" : "half"; } catch { return "half"; }
}

/** The person's chosen panel width and sheet height, remembered between visits. */
export function useChatLayout() {
  const [width, setWidthState] = useState(readWidth);
  const [sheet, setSheetState] = useState<Sheet>(readSheet);
  const setWidth = useCallback((next: number) => {
    const value = clampPanelWidth(next, typeof window === "undefined" ? Infinity : window.innerWidth);
    setWidthState(value);
    try { localStorage.setItem(WIDTH_KEY, String(value)); } catch { /* not remembered */ }
  }, []);
  const setSheet = useCallback((next: Sheet) => {
    setSheetState(next);
    try { localStorage.setItem(SHEET_KEY, next); } catch { /* not remembered */ }
  }, []);
  return { width, setWidth, sheet, setSheet };
}
