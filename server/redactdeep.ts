/**
 * Every string in a payload, however deep, with secrets blanked.
 *
 * It used to look only one level down, so a key inside a tool call's nested
 * arguments (an MCP tool's `{"auth": {"token": ...}}`, a header list) or in
 * any array went into the log on disk and to every watcher as it was. Then it
 * stopped eight levels down and passed whatever lay below untouched; a value
 * nested past `MAX_DEPTH` (or one that refers back to itself) now comes back
 * as its text, blanked, rather than as it was.
 */
const MAX_DEPTH = 64;

export function redactDeep(value: unknown, redact: (text: string) => string, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH || seen.has(value)) return flattened(value, redact);
    seen.add(value);
    const out = value.map((item) => redactDeep(item, redact, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  // Plain objects only: a Date or a Buffer rebuilt key by key would stop being one.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return flattened(value, redact);
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, depth + 1, seen);
  seen.delete(value);
  return out;
}

function flattened(value: object, redact: (text: string) => string): string {
  try {
    return redact(JSON.stringify(value) ?? "");
  } catch {
    return "[nested too deep to show]";
  }
}
