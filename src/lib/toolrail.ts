import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The tool rail every Autora app wears (docs/TOOL-RAIL.md): round, coloured tools, a bar that never scrolls, an All tools
 * grid for the rest. This file is what an app hands to `ToolRail` (src/components/ToolRail.tsx): a list of tools, each
 * with the colour of its verb. The PDF window's rail (spectra-editor/src/autora/rail.tsx) is the same design inside
 * Spectra's frame; apps whose editors live in the host page use this one.
 */

/** One colour per verb, the same in every app, so a person learns it once. These are SecurePDF's. */
export const VERB = {
  select: "#2563eb",
  text: "#059669",
  highlight: "#f59e0b",
  draw: "#9333ea",
  shape: "#4f46e5",
  note: "#0284c7",
  stamp: "#d97706",
  remove: "#e11d48",
  insert: "#0891b2",
} as const;

export interface RailTool {
  id: string;
  label: string;
  /** The grid's section for it. */
  group: string;
  icon: ReactNode;
  color: string;
  /** In the phone's bar, and what a desktop's starts with. */
  phone?: boolean;
  /** In the desktop's bar at first, beyond the phone's. */
  desktop?: boolean;
  /** Lit while it is on: the tool whose tray is open, or a switch that is set. */
  on?: boolean;
  disabled?: boolean;
  /**
   * Whether the work needs this tool now. `false` takes it off the bar (it stays in All tools, with what it needs) and it fades
   * out; it comes back, fading in, when the work needs it. Omitted means always, so a window opts in by saying when. It wins
   * over `on`: a switch that happens to be set (Loop) is no reason to keep a tool there. A tool whose tray is open stays by the
   * window counting that in its own `needed`.
   */
  needed?: boolean;
  /** Said under the label in the grid and as the bar's tooltip. */
  about?: string;
  run: () => void;
}

const keyOf = (app: string) => `autora-rail-pins-${app}`;

/** What a desktop's bar shows, in order: the person's pins, or the defaults. A phone never reads this. */
export function usePins(app: string, tools: RailTool[]): {
  pins: string[];
  toggle: (id: string, room: number) => "pinned" | "unpinned" | "full";
  reset: () => void;
} {
  const defaults = tools.filter((t) => t.phone || t.desktop).map((t) => t.id);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(keyOf(app)) ?? "null") as unknown;
      if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === "string");
    } catch { /* no storage: the defaults */ }
    return defaults;
  });
  const save = (next: string[]) => {
    setPins(next);
    try { localStorage.setItem(keyOf(app), JSON.stringify(next)); } catch { /* it still works for this session */ }
  };
  const toggle = useCallback((id: string, room: number) => {
    if (pins.includes(id)) { save(pins.filter((p) => p !== id)); return "unpinned" as const; }
    if (pins.length >= room) return "full" as const;
    save([...pins, id]);
    return "pinned" as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` only closes over setPins and the app key
  }, [pins, app]);
  const reset = useCallback(() => save(defaults), [defaults.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return { pins, toggle, reset };
}

/** How long a tool takes to fade out of the bar: the `--dur-2` of the rail's CSS, which is where the fade itself is drawn. */
const FADE_MS = 250;

/**
 * The ids the bar shows, with the ones that have just gone kept for a moment, marked `leaving`, so a tool fades out of its
 * place instead of vanishing and the others do not jump until it has gone. (With reduced motion the CSS draws no fade, and
 * the wait is the same short one.)
 */
export function useFading(present: string[]): { id: string; leaving: boolean }[] {
  const key = present.join("\u0000");
  const last = useRef<string[]>(present);
  /** The bar as it was when the tools now fading were still on it: where each of them sits. */
  const order = useRef<string[]>(present);
  const [leaving, setLeaving] = useState<string[]>([]);
  useEffect(() => {
    const gone = last.current.filter((id) => !present.includes(id));
    if (gone.length) order.current = last.current;
    last.current = present;
    if (!gone.length) return;
    setLeaving((cur) => [...new Set([...cur, ...gone])]);
    const t = setTimeout(() => setLeaving((cur) => cur.filter((id) => !gone.includes(id))), FADE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is `present`'s content
  }, [key]);
  const merged = present.map((id) => ({ id, leaving: false }));
  // A tool that has just gone stays by the tool it was after while it fades.
  for (const id of leaving) {
    if (present.includes(id)) continue;
    const prev = order.current.slice(0, Math.max(0, order.current.indexOf(id))).reverse().find((o) => merged.some((m) => m.id === o));
    const at = prev === undefined ? 0 : merged.findIndex((m) => m.id === prev) + 1;
    merged.splice(at, 0, { id, leaving: true });
  }
  return merged;
}
