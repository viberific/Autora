/**
 * What acts on a panel's controls: every piece in Panacea must do what it shows (docs/PANACEA-GAPS.md).
 *
 * A control bound to a surface (`@img1.exposure`) or pressing a surface's action is acted on by the surface. A control
 * bound to a plain shared value (`budget`, `todo`) holds the panel's own content, which the panel itself shows and the
 * agent reads. But a value named for an app (`music.bpm`, `model.x`, `game.gravity`, `ui.radius`, `doc.columns`) is a
 * promise that the app changes when it moves: such a value is live only once an adapter for that app acts on it, and is
 * listed here when it does. A recipe with a value nothing acts on is not offered (the picker, the rules, the agent's
 * panacea_place), and a panel of one already on a canvas says so.
 *
 * Pure: shared by the server and the page.
 */
import type { Node } from "./recipe";

/** Values named for an app: live only when an adapter acts on them. */
const APP_VALUE = /^(doc|music|video|model|game|ui)\./;

/**
 * The app values an adapter acts on, exactly or by a prefix ending in "." (the adapters fill this in as each app is
 * connected: docs/PANACEA-GAPS.md, G1).
 */
const WIRED: readonly string[] = ["music."];

/** Whether something acts on this bind. */
function bindWired(bind: string): boolean {
  if (bind.startsWith("@") || !APP_VALUE.test(bind)) return true;
  return WIRED.some((w) => (w.endsWith(".") ? bind.startsWith(w) : bind === w));
}

/** The binds (and app actions) in a tree that nothing acts on yet. */
export function unwiredBinds(tree: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.bind && !bindWired(n.bind)) out.add(n.bind);
    const action = n.props?.action;
    if (typeof action === "string" && action.startsWith("set:")) {
      const key = action.slice(4, action.indexOf("=") > 0 ? action.indexOf("=") : undefined);
      if (!bindWired(key)) out.add(key);
    }
    n.children?.forEach(walk);
  };
  walk(tree);
  return [...out];
}

/** Whether every control of a recipe or panel does something. */
export function treeLive(tree: Node): boolean {
  return unwiredBinds(tree).length === 0;
}
