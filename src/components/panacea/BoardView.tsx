import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Surface } from "../../lib/panacea/canvas";
import { addCard, editCard, linkCards, moveCard, removeCard, unlink, type BoardState, type Card } from "../../lib/panacea/board";
import { IconX } from "../Icons";
import { usePanacea } from "./context";

/** A card's middle, for drawing a link to it; its height as last measured. */
const middle = (c: Card, h: number) => ({ x: c.x + c.w / 2, y: c.y + h / 2 });

/**
 * A board surface: cards anywhere on it, links between them, Autora's questions as cards of their own. Double-click the
 * space for a card, double-click a card to write in it, drag a card to move it, drag from its dot onto another card to
 * link them, Delete takes away what is selected. Its bar says whose words the cards are (as a document's does).
 */
export function BoardView({ surface }: { surface: Surface }) {
  const api = usePanacea();
  const board = surface.board;
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});

  // Cards are as tall as their words: measured after each draw, so links meet them in the middle.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const next: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-card]").forEach((c) => { next[c.dataset.card!] = c.offsetHeight; });
    setHeights((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  }, [board, editing]);

  if (!board) return <div className="pa-chart-empty">This board's cards are gone.</div>;
  const write = (next: BoardState, label: string | null) => api.writeBoard(surface.id, next, label);
  const take = (r: BoardState | string, label: string) => { if (typeof r !== "string") write(r, label); };
  /** The canvas is zoomed: a pointer's movement in the board's own pixels. */
  const scale = () => { const el = root.current; return el && el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1; };
  const at = (e: { clientX: number; clientY: number }) => {
    const el = root.current!;
    const r = el.getBoundingClientRect();
    const z = scale();
    return { x: (e.clientX - r.left) / z + el.scrollLeft, y: (e.clientY - r.top) / z + el.scrollTop };
  };
  const select = (id: string | undefined) => {
    if (board.sel === id) return;
    const next: BoardState = { ...board };
    delete next.sel;
    if (id) next.sel = id;
    write(next, null);
  };

  const newCard = (where: { x: number; y: number }, linkTo?: string) => {
    const made = addCard(board, { text: "", x: where.x, y: where.y, tone: surface.params.tone, by: "person" });
    if (typeof made === "string") return;
    let next: BoardState = { ...made.board, sel: made.card.id };
    if (linkTo) { const l = linkCards(next, linkTo, made.card.id); if (typeof l !== "string") next = l.board; }
    write(next, linkTo ? "Answered a question" : "Added a card");
    setEditing({ id: made.card.id, text: "", fresh: true });
  };

  const finish = (keep: boolean) => {
    if (!editing) return;
    const card = board.cards.find((c) => c.id === editing.id);
    setEditing(null);
    if (!card) return;
    const text = editing.text.trim();
    if (!keep || !text) { if (editing.fresh && !card.text) take(removeCard(board, card.id), "Took away an empty card"); return; }
    if (text !== card.text) take(editCard(board, card.id, { text }), `Wrote "${text.slice(0, 24)}"`);
  };

  const grab = (card: Card, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing?.id === card.id || (e.target as HTMLElement).closest("button, textarea, .pa-brd-dot")) return;
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    api.hold(true);
    setLink(null);
    const move = (ev: PointerEvent) => {
      const z = scale();
      const dx = (ev.clientX - start.x) / z;
      const dy = (ev.clientY - start.y) / z;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (moved) setDrag({ id: card.id, dx, dy });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      api.hold(false);
      setDrag(null);
      const z = scale();
      if (moved) take(moveCard({ ...board, sel: card.id }, card.id, card.x + (ev.clientX - start.x) / z, card.y + (ev.clientY - start.y) / z), "Moved a card");
      else select(card.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const pull = (card: Card, e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    api.hold(true);
    setLinking({ from: card.id, ...at(e) });
    const move = (ev: PointerEvent) => setLinking({ from: card.id, ...at(ev) });
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      api.hold(false);
      setLinking(null);
      const onto = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-card]")?.dataset.card;
      if (onto && onto !== card.id) { const l = linkCards(board, card.id, onto); if (typeof l !== "string") write(l.board, "Linked two cards"); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const key = (e: ReactKeyboardEvent) => {
    if (editing || (e.key !== "Delete" && e.key !== "Backspace")) return;
    if (link) { e.preventDefault(); e.stopPropagation(); take(unlink(board, link), "Took away a link"); setLink(null); }
    else if (board.sel) { e.preventDefault(); e.stopPropagation(); take(removeCard(board, board.sel), "Took away a card"); }
  };

  const h = (c: Card) => heights[c.id] ?? 64;
  const pos = (c: Card) => (drag?.id === c.id ? { ...c, x: c.x + drag.dx, y: c.y + drag.dy } : c);
  const byId = new Map(board.cards.map((c) => [c.id, pos(c)]));
  const room = {
    w: Math.max(...board.cards.map((c) => c.x + c.w), 0) + 320,
    h: Math.max(...board.cards.map((c) => c.y + h(c)), 0) + 240,
  };
  const mode = board.mode;

  return (
    <div className="pa-brd-wrap">
      <div className="pa-doc-bar">
        <button
          type="button"
          className="pa-doc-mode"
          aria-pressed={mode === "agent"}
          title={mode === "agent" ? "Autora may write cards here, and you can undo it. Press to write them yourself." : "The cards' words are yours; Autora arranges, links and asks. Press to let Autora write cards."}
          onClick={() => api.setMode(surface.id, mode === "agent" ? "guide" : "agent")}
        >
          {mode === "agent" ? "Autora writes" : "You write"}
        </button>
        <span>{board.cards.length ? "Double-click for a card · drag its dot onto another to link" : "Double-click anywhere for your first card"}</span>
      </div>
      <div
        ref={root}
        className="pa-brd"
        tabIndex={0}
        role="application"
        aria-label={`${surface.title}: a board of ${board.cards.length} cards`}
        onKeyDown={key}
        onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("pa-brd-space")) { setLink(null); select(undefined); } }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if ((e.target as HTMLElement).closest("[data-card]")) return;
          const p = at(e);
          newCard({ x: p.x - 88, y: p.y - 24 });
        }}
      >
        <div className="pa-brd-space" style={{ width: room.w, height: room.h }}>
          <svg className="pa-brd-links" width={room.w} height={room.h} aria-hidden="true">
            {board.links.map((l) => {
              const a = byId.get(l.from);
              const b = byId.get(l.to);
              if (!a || !b) return null;
              const p = middle(a, h(a));
              const q = middle(b, h(b));
              return (
                <g key={l.id} className={link === l.id ? "is-on" : ""}>
                  <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
                  <line className="pa-brd-hit" x1={p.x} y1={p.y} x2={q.x} y2={q.y} onPointerDown={(e) => { e.stopPropagation(); setLink(l.id); root.current?.focus(); }} />
                  {l.label && <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 6}>{l.label}</text>}
                </g>
              );
            })}
            {linking && (() => { const a = byId.get(linking.from); if (!a) return null; const p = middle(a, h(a)); return <line className="is-pulling" x1={p.x} y1={p.y} x2={linking.x} y2={linking.y} />; })()}
          </svg>
          {board.cards.map((raw) => {
            const c = pos(raw);
            const open = editing?.id === c.id;
            return (
              <div
                key={c.id}
                data-card={c.id}
                className={`pa-brd-card is-${c.tone}${c.ask ? " is-ask" : ""}${board.sel === c.id ? " is-selected" : ""}${drag?.id === c.id ? " is-moving" : ""}`}
                style={{ left: c.x, top: c.y, width: c.w }}
                onPointerDown={(e) => grab(raw, e)}
                onDoubleClick={(e) => { e.stopPropagation(); if (!c.ask) setEditing({ id: c.id, text: c.text, fresh: false }); }}
              >
                {c.ask && <span className="pa-brd-tag">Autora asks</span>}
                {open ? (
                  <textarea
                    autoFocus
                    value={editing.text}
                    maxLength={400}
                    aria-label="The card's words"
                    onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    onBlur={() => finish(true)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
                      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
                    }}
                  />
                ) : (
                  <p>{c.text || <i>Empty</i>}</p>
                )}
                {c.ask && (
                  <span className="pa-brd-acts">
                    <button type="button" onClick={() => newCard({ x: c.x + c.w + 24, y: c.y }, c.id)}>Answer</button>
                    <button type="button" aria-label="Not this question" onClick={() => take(removeCard(board, c.id), "Waved a question away")}><IconX size={10} /></button>
                  </span>
                )}
                {!open && <i className="pa-brd-dot" role="button" aria-label="Drag onto another card to link them" onPointerDown={(e) => pull(raw, e)} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
