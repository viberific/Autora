import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DOMAIN_NAMES, searchLibrary, type Recipe } from "../../lib/panacea/library";
import type { Node } from "../../lib/panacea/recipe";

/** The picker's way to a board: not a panel but a surface, which the window adds where the person double-clicked. */
export const BOARD_PIECE = "blank.board";
export const FLOWCHART_PIECE = "blank.flowchart";

/** Pieces with nothing in them yet: a single control on a value of its own, for when the person just wants one; and a board. */
function blankPieces(name: string): Recipe[] {
  const piece = (id: string, title: string, about: string, tree: Node, w = 256): Recipe =>
    ({ id: `blank.${id}`, name: title, domain: "general", about, tags: [id], tree, w, origin: "builtin", uses: 0 });
  return [
    piece("slider", "Slider", "a number on a track", { atom: "slider", bind: name, props: { label: "Value", min: 0, max: 100 } }),
    piece("toggle", "Switch", "on or off", { atom: "toggle", bind: name, props: { label: "On" } }),
    piece("choice", "Choice", "one of a few", { atom: "segmented", bind: name, props: { label: "Choice", options: ["A", "B", "C"] } }),
    piece("notes", "Notes", "somewhere to write", { atom: "text", bind: name, props: { label: "Notes", multiline: true } }, 288),
    piece("checklist", "Checklist", "a list to tick", { atom: "list", bind: name, props: { label: "List" } }, 288),
    piece("colour", "Colour", "a colour", { atom: "color", bind: name, props: { label: "Colour" } }),
    { ...piece("board", "Board", "cards and links to think with: a brainstorm, a map of ideas", { atom: "note", props: { text: "A board" } }), id: BOARD_PIECE, tags: ["board", "brainstorm", "map", "cards", "ideas", "mind"] },
    { ...piece("flowchart", "Flowchart", "processes, decisions and directed paths", { atom: "note", props: { text: "A flowchart" } }), id: FLOWCHART_PIECE, tags: ["flowchart", "process", "decision", "diagram"] },
  ];
}

/**
 * The summon picker: what the person gets by double-clicking the grid (or pressing /). Type to search the library, pick
 * with a click or Enter, and the panel lands where they asked for it. No AI involved.
 */
export function Summon({ x, y, recipes, onPick, onClose }: {
  x: number;
  y: number;
  recipes: Recipe[];
  onPick: (r: Recipe) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as globalThis.Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const blanks = useMemo(() => blankPieces("value"), []);
  const found = useMemo(() => {
    const words = q.trim();
    const lib = words ? searchLibrary(recipes, words, null, 9) : searchLibrary(recipes, "", null, 6);
    const w = words.toLowerCase();
    const extra = words ? blanks.filter((b) => b.name.toLowerCase().startsWith(w) || b.tags.some((t) => t.startsWith(w))) : blanks;
    return [...lib, ...extra];
  }, [q, recipes, blanks]);
  useEffect(() => setAt(0), [q]);
  const key = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(found.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && found[at]) { e.preventDefault(); onPick(found[at]!); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };
  return (
    <div className="pa-summon" ref={box} style={{ left: x, top: y }} role="dialog" aria-label="Add a panel" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input ref={input} className="pa-summon-q" value={q} placeholder="What do you need?" aria-label="Search pieces" onChange={(e) => setQ(e.target.value)} onKeyDown={key} />
      <div className="pa-summon-list" role="listbox">
        {found.map((r, i) => (
          <button key={r.id} type="button" role="option" aria-selected={i === at} data-recipe={r.id} className={i === at ? "is-on" : ""} onMouseEnter={() => setAt(i)} onClick={() => onPick(r)}>
            <b>{r.name}</b><span>{r.id.startsWith("blank.") ? "Blank" : DOMAIN_NAMES[r.domain]} · {r.about}</span>
          </button>
        ))}
        {!found.length && <p className="pa-note">Nothing called that. Ask Autora below: it can make one.</p>}
      </div>
    </div>
  );
}
