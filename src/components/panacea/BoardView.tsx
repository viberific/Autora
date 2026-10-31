import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Surface } from "../../lib/panacea/canvas";
import { addCard, boardBounds, boardPoint, cardHeight, cardShape, connectorPoints, DIRECTIONS, editCard, editLink, freeSpot, linkCards, linkDirection, linkLabelPoint, moveCard, removeCard, SHAPES, shapePath, unlink, type BoardState, type Card } from "../../lib/panacea/board";
import { IconX } from "../Icons";
import { usePanacea } from "./context";
import "./BoardView.css";

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
  const svg = useRef<SVGSVGElement>(null);
  const arrow = useId().replace(/:/g, "");
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  // Cards are as tall as their words: measured after each draw, so links meet them in the middle.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const next: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-card]").forEach((c) => { next[c.dataset.card!] = c.offsetHeight; });
    setHeights((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  }, [board, editing]);

  if (!board) return <div className="pa-chart-empty">This board's cards are gone.</div>;
  const link = board.selLink;
  const flow = board.diagram === "flowchart";
  const write = (next: BoardState, label: string | null) => api.writeBoard(surface.id, next, label);
  const take = (r: BoardState | string, label: string) => { if (typeof r === "string") setError(r); else { setError(null); write(r, label); } };
  const at = (e: { clientX: number; clientY: number }) => {
    const matrix = svg.current?.getScreenCTM();
    return matrix ? boardPoint(matrix, { x: e.clientX, y: e.clientY }) : null;
  };
  const select = (id: string | undefined) => {
    setError(null);
    if (board.sel === id) return;
    const next: BoardState = { ...board };
    delete next.sel;
    delete next.selLink;
    if (id) next.sel = id;
    write(next, null);
  };
  const selectLink = (id: string) => {
    setError(null);
    const next = { ...board, selLink: id };
    delete next.sel;
    write(next, null);
    root.current?.focus();
  };

  const newCard = (where: { x: number; y: number }, linkTo?: string) => {
    const made = addCard(board, { text: "", x: where.x, y: where.y, tone: surface.params.tone, shape: surface.params.shape, by: "person" });
    if (typeof made === "string") { setError(made); return; }
    setError(null);
    let next: BoardState = { ...made.board, sel: made.card.id };
    delete next.selLink;
    if (linkTo) { const l = linkCards(next, linkTo, made.card.id, "", surface.params.direction); if (typeof l !== "string") next = l.board; }
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
    const start = at(e);
    if (!start) return;
    const screen = { x: e.clientX, y: e.clientY };
    let moved = false;
    api.hold(true);
    const move = (ev: PointerEvent) => {
      const point = at(ev);
      if (!point) return;
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      if (Math.abs(ev.clientX - screen.x) + Math.abs(ev.clientY - screen.y) > 3) moved = true;
      if (moved) setDrag({ id: card.id, dx, dy });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      api.hold(false);
      setDrag(null);
      if (ev.type === "pointercancel") return;
      const point = at(ev);
      if (moved && point) {
        const next = { ...board, sel: card.id };
        delete next.selLink;
        take(moveCard(next, card.id, card.x + point.x - start.x, card.y + point.y - start.y), "Moved a card");
      }
      else select(card.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up, { once: true });
  };

  const pull = (card: Card, e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const point = at(e);
    if (!point) return;
    api.hold(true);
    setLinking({ from: card.id, ...point });
    const move = (ev: PointerEvent) => { const next = at(ev); if (next) setLinking({ from: card.id, ...next }); };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      api.hold(false);
      setLinking(null);
      const onto = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-card]")?.dataset.card;
      if (ev.type !== "pointercancel" && onto && onto !== card.id) { const l = linkCards(board, card.id, onto, "", surface.params.direction); take(typeof l === "string" ? l : l.board, "Linked two cards"); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up, { once: true });
  };

  const key = (e: ReactKeyboardEvent) => {
    if (editing || (e.target as HTMLElement).closest("input, textarea, select, button") || (e.key !== "Delete" && e.key !== "Backspace")) return;
    if (link) { e.preventDefault(); e.stopPropagation(); take(unlink(board, link), "Took away a link"); }
    else if (board.sel) { e.preventDefault(); e.stopPropagation(); take(removeCard(board, board.sel), "Took away a card"); }
  };

  const h = (c: Card) => flow ? cardHeight(board, c) : heights[c.id] ?? 64;
  const pos = (c: Card) => (drag?.id === c.id ? { ...c, x: c.x + drag.dx, y: c.y + drag.dy } : c);
  const byId = new Map(board.cards.map((c) => [c.id, pos(c)]));
  const bounds = boardBounds(board);
  const room = { x: board.diagram !== undefined ? bounds.x : 0, y: board.diagram !== undefined ? bounds.y : 0, w: Math.max(bounds.w, 320), h: Math.max(bounds.h, 240) };
  const mode = board.mode;
  const selected = board.cards.find((c) => c.id === board.sel);
  const selectedLink = board.links.find((l) => l.id === link);

  return (
    <div className={`pa-brd-wrap${flow ? " pa-flowchart" : ""}`}>
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
        <span>{flow ? "Double-click for a node · drag its dot to connect" : board.cards.length ? "Double-click for a card · drag its dot onto another to link" : "Double-click anywhere for your first card"}</span>
        {flow && <button type="button" onClick={() => newCard(freeSpot(board))}>Add node</button>}
      </div>
      {(flow || selectedLink) && <div className="pa-brd-controls">
        {flow && selected && <label>Shape <select className="jf-field" aria-label="Selected node shape" value={cardShape(board, selected)} onChange={(e) => take(editCard(board, selected.id, { shape: e.target.value }), "Changed node shape")}>{SHAPES.map((shape) => <option key={shape}>{shape}</option>)}</select></label>}
        {selectedLink && <>
          <label>Direction <select className="jf-field" aria-label="Selected connector direction" value={linkDirection(board, selectedLink)} onChange={(e) => take(editLink(board, selectedLink.id, { direction: e.target.value }), "Changed connector direction")}>{DIRECTIONS.map((direction) => <option key={direction}>{direction}</option>)}</select></label>
          <label>Label <input className="jf-field" aria-label="Selected connector label" maxLength={40} key={`${selectedLink.id}:${selectedLink.label}`} defaultValue={selectedLink.label} onBlur={(e) => { if (e.target.value !== selectedLink.label) take(editLink(board, selectedLink.id, { label: e.target.value }), "Changed connector label"); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
          <button type="button" onClick={() => take(unlink(board, selectedLink.id), "Removed connector")}>Remove connector</button>
        </>}
        {flow && selected && <label>Connect to <select className="jf-field" aria-label="Connect selected node to" value="" onChange={(e) => { if (e.target.value) { const result = linkCards(board, selected.id, e.target.value, "", surface.params.direction); take(typeof result === "string" ? result : result.board, "Connected nodes"); } }}><option value="">Choose node</option>{board.cards.filter((c) => c.id !== selected.id).map((c) => <option key={c.id} value={c.id}>{c.text || c.id}</option>)}</select></label>}
      </div>}
      {error && <div className="pa-brd-error" role="alert">{error}</div>}
      <div
        ref={root}
        className="pa-brd"
        tabIndex={0}
        role="application"
        aria-label={`${surface.title}: a board of ${board.cards.length} cards`}
        onKeyDown={key}
        onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("pa-brd-space")) select(undefined); }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if ((e.target as HTMLElement).closest("[data-card]")) return;
          const p = at(e);
          if (p) newCard({ x: p.x - 88, y: p.y - 24 });
        }}
      >
        <div className="pa-brd-space" style={{ width: room.w, height: room.h }}>
          <svg ref={svg} className="pa-brd-links" width={room.w} height={room.h} viewBox={`${room.x} ${room.y} ${room.w} ${room.h}`}>
            <defs>
              <marker id={`${arrow}-end`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="var(--border-strong)" /></marker>
              <marker id={`${arrow}-start`} markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M 8 0 L 0 4 L 8 8 Z" fill="var(--border-strong)" /></marker>
            </defs>
            {board.links.map((l) => {
              const a = byId.get(l.from);
              const b = byId.get(l.to);
              if (!a || !b) return null;
              const { p, q } = flow ? connectorPoints(board, a, b, h(a), h(b)) : { p: middle(a, h(a)), q: middle(b, h(b)) };
              const direction = linkDirection(board, l);
              const label = linkLabelPoint(board, l, p, q);
              return (
                <g key={l.id} className={link === l.id ? "is-on" : ""}>
                  <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} markerStart={direction === "backward" || direction === "both" ? `url(#${arrow}-start)` : undefined} markerEnd={direction === "forward" || direction === "both" ? `url(#${arrow}-end)` : undefined} />
                  <line className="pa-brd-hit" x1={p.x} y1={p.y} x2={q.x} y2={q.y} tabIndex={0} role="button" aria-label={`Select connector ${a.text} to ${b.text}${l.label ? `: ${l.label}` : ""}`} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectLink(l.id); } }} onPointerDown={(e) => { e.stopPropagation(); selectLink(l.id); }} />
                  {l.label && <text className="pa-brd-label" x={label.x} y={label.y} onPointerDown={(e) => { e.stopPropagation(); selectLink(l.id); }}>{l.label}</text>}
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
                className={`pa-brd-card is-${c.tone}${flow ? ` pa-flow-node shape-${cardShape(board, c)}` : ""}${c.ask ? " is-ask" : ""}${board.sel === c.id ? " is-selected" : ""}${drag?.id === c.id ? " is-moving" : ""}`}
                style={{ left: c.x - room.x, top: c.y - room.y, width: c.w, ...(flow ? { minHeight: h(c) } : {}) }}
                tabIndex={0}
                aria-label={`${flow ? cardShape(board, c) : "Card"}: ${c.text || "Empty"}`}
                onFocus={() => { if (!editing) select(c.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !editing && !c.ask) { e.preventDefault(); setEditing({ id: c.id, text: c.text, fresh: false }); } }}
                onPointerDown={(e) => grab(raw, e)}
                onDoubleClick={(e) => { e.stopPropagation(); if (!c.ask) setEditing({ id: c.id, text: c.text, fresh: false }); }}
              >
                {flow && <svg className="pa-flow-shape" viewBox={`0 0 ${c.w} ${h(c)}`} aria-hidden="true"><path d={shapePath(cardShape(board, c), c.w, h(c))} /></svg>}
                {c.ask && <span className="pa-brd-tag">Autora asks</span>}
                {open ? (
                  <textarea
                    className="jf-field"
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
