import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/** One thing the board's menu can do, or a group of them that opens beside it. */
export type BoardMenuItem =
  | { label: string; icon?: ReactNode; act: () => void }
  | { label: string; icon?: ReactNode; items: { label: string; icon?: ReactNode; act: () => void }[] };

/**
 * A right-click on the empty board: one short vertical list at the pointer (New, Open file, Add piece, View), a group
 * opening beside it, the same shape as the right-click menu in the Office windows (docs/TOOL-RAIL.md, M1). The keys
 * work it: up and down, right into a group, left out of it, Enter, Escape. It goes on a click elsewhere or a wheel.
 */
export function BoardMenu({ x, y, items, onClose }: { x: number; y: number; items: BoardMenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [at, setAt] = useState({ x, y });
  const [subSide, setSubSide] = useState<"right" | "left">("right");
  const [subTop, setSubTop] = useState(0);
  // The open group's entries start level with its row.
  useLayoutEffect(() => {
    if (open === null) return;
    const row = box.current?.querySelectorAll<HTMLElement>(".pa-board-menu-list > button")[open];
    setSubTop((row?.offsetTop ?? 0) - 4);
  }, [open]);
  // At the pointer, kept inside the board: moved in from an edge, and a group opens on the side there is room.
  useLayoutEffect(() => {
    const el = box.current;
    const host = el?.offsetParent;
    if (!el || !(host instanceof HTMLElement)) return;
    const w = el.offsetWidth, h = el.offsetHeight, hw = host.clientWidth, hh = host.clientHeight;
    setAt({ x: Math.max(8, Math.min(x, hw - w - 8)), y: Math.max(8, Math.min(y, hh - h - 8)) });
    setSubSide(x + w * 2 + 16 > hw ? "left" : "right");
  }, [x, y]);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(".pa-board-menu-list > button")?.focus({ preventScroll: true });
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("wheel", away, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const rows = (sel: string) => [...(box.current?.querySelectorAll<HTMLButtonElement>(sel) ?? [])];
  const step = (sel: string, d: number) => {
    const all = rows(sel);
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + d + all.length) % all.length]!.focus();
  };
  const key = (e: ReactKeyboardEvent) => {
    const inSub = !!(e.target as HTMLElement).closest(".pa-board-menu-sub");
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (inSub) { const i = open; setOpen(null); if (i !== null) rows(".pa-board-menu-list > button")[i]?.focus(); } else onClose(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!inSub) setOpen(null);
      step(inSub ? ".pa-board-menu-sub button" : ".pa-board-menu-list > button", e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "ArrowLeft" && inSub) {
      e.preventDefault();
      const i = open;
      setOpen(null);
      if (i !== null) rows(".pa-board-menu-list > button")[i]?.focus();
    }
  };
  const run = (act: () => void) => { onClose(); act(); };
  const sub = open !== null ? items[open] : null;

  return (
    <div ref={box} className="pa-board-menu pa-chrome" style={{ left: at.x, top: at.y }} onKeyDown={key} onContextMenu={(e) => e.preventDefault()}>
      <div className="pa-board-menu-list" role="menu" aria-label="Board">
        {items.map((it, i) => "items" in it ? (
          <button
            key={it.label} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === i}
            className={open === i ? "is-open" : undefined}
            onPointerEnter={() => setOpen(i)}
            onClick={() => { setOpen(i); requestAnimationFrame(() => rows(".pa-board-menu-sub button")[0]?.focus()); }}
            onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); setOpen(i); requestAnimationFrame(() => rows(".pa-board-menu-sub button")[0]?.focus()); } }}
          >
            {it.icon}<span>{it.label}</span><i aria-hidden="true">›</i>
          </button>
        ) : (
          <button key={it.label} type="button" role="menuitem" onPointerEnter={() => setOpen(null)} onClick={() => run(it.act)}>
            {it.icon}<span>{it.label}</span>
          </button>
        ))}
      </div>
      {sub && "items" in sub && (
        <div
          className={`pa-board-menu-list pa-board-menu-sub is-${subSide}`} role="menu" aria-label={sub.label}
          style={{ top: subTop }}
        >
          {sub.items.map((it) => (
            <button key={it.label} type="button" role="menuitem" onClick={() => run(it.act)}>
              {it.icon}<span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
