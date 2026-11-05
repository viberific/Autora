/**
 * The ids the bar shows, with the ones that have just gone kept for a moment, marked `leaving`, so a tool fades out of its place
 * instead of vanishing, and the others do not jump until it has gone. The same hook as src/lib/toolrail.ts and Autora 3D's: this
 * frame is a project of its own and cannot import them.
 */
import { useEffect, useRef, useState } from "react";

/** How long a tool takes to fade out; the CSS transition on `.is-leaving` (autora.css) is the same length. */
const FADE_MS = 250;

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
