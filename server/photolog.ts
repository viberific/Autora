/**
 * What differs between two readings of a picture (what the command line's `doc.inspect` says), in a colleague's words: for the
 * Photo window's command log (server/photodesk.ts). The reading is read defensively, since only its size and layers are known
 * here: a change it cannot see (pixels painted on a layer) is "changed the picture". Pure, so `tests/photolog.test.ts` runs it alone.
 */

interface Reading {
  size?: { width?: number; height?: number };
  width?: number;
  height?: number;
  layers?: unknown[];
  [k: string]: unknown;
}

type Layer = Record<string, unknown> & { children?: unknown };

const MAX_LINES = 6;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function flat(layers: unknown, out: Layer[] = []): Layer[] {
  if (!Array.isArray(layers)) return out;
  for (const l of layers) {
    if (!l || typeof l !== "object") continue;
    out.push(l as Layer);
    flat((l as Layer).children, out);
  }
  return out;
}

const keyOf = (l: Layer): string => String(l.id ?? l.name ?? "");
const nameOf = (l: Layer): string => (typeof l.name === "string" && l.name ? `"${l.name.slice(0, 30)}"` : "a layer");
const sizeOf = (r: Reading): string | null => {
  const w = r.size?.width ?? r.width;
  const h = r.height ?? r.size?.height;
  return typeof w === "number" && typeof h === "number" ? `${w}x${h}` : null;
};
/** The settings of a layer that a person changes without painting: the ones named here when the reading has them. */
const SETTINGS = ["visible", "opacity", "blend", "blendMode", "locked", "name"] as const;

/** The changes between two readings, one short line each (at most six; the rest are counted). */
export function describePhotoChange(before: Reading | undefined, after: Reading | undefined): string[] {
  if (!before || !after) return ["changed the picture"];
  const lines: string[] = [];
  const was = sizeOf(before), now = sizeOf(after);
  if (was && now && was !== now) lines.push(`resized the picture from ${was} to ${now}`);

  const a = flat(before.layers), b = flat(after.layers);
  const keyed = a.every((l) => keyOf(l)) && b.every((l) => keyOf(l));
  if (keyed) {
    const aMap = new Map(a.map((l) => [keyOf(l), l]));
    const bMap = new Map(b.map((l) => [keyOf(l), l]));
    const added = b.filter((l) => !aMap.has(keyOf(l)));
    const gone = a.filter((l) => !bMap.has(keyOf(l)));
    for (const l of added.slice(0, 3)) lines.push(`added the layer ${nameOf(l)}`);
    if (added.length > 3) lines.push(`added ${plural(added.length - 3, "more layer")}`);
    for (const l of gone.slice(0, 3)) lines.push(`removed the layer ${nameOf(l)}`);
    if (gone.length > 3) lines.push(`removed ${plural(gone.length - 3, "more layer")}`);
    for (const l of b) {
      const old = aMap.get(keyOf(l));
      if (!old) continue;
      const set = SETTINGS.filter((k) => k in l && JSON.stringify(l[k]) !== JSON.stringify(old[k]));
      if (set.length) lines.push(`changed ${nameOf(l)}: ${set.join(", ")}`);
    }
  } else if (a.length !== b.length) {
    lines.push(b.length > a.length ? `added ${plural(b.length - a.length, "layer")}` : `removed ${plural(a.length - b.length, "layer")}`);
  }
  if (lines.length === 0) lines.push("changed the picture");
  if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES), `and ${lines.length - MAX_LINES} more`];
  return lines;
}
