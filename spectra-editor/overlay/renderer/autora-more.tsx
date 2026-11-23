// Autora (phone): the "⋯" on what a finger has picked.
//
// A long press selects here and never opens the menu (Brian's rule); the menu comes from this button, under the pick or
// above it where there is no room below, and never off the side. It is drawn by the canvas, not by the page cell, so the
// same button serves every pick the same way. A mouse's right-click still opens the menu itself.

import { useEffect, useRef, useState } from 'react';

const SIZE = 34;
const MARGIN = 8;

export function AutoraMore({ x, y, onOpen }: { x: number; y: number; onOpen: (at: { x: number; y: number }) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState({ x, y });
  useEffect(() => {
    const left = Math.max(MARGIN, Math.min(x - SIZE / 2, window.innerWidth - SIZE - MARGIN));
    const below = y + 6;
    const top = below + SIZE <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, y - SIZE - 6);
    setAt({ x: left, y: top });
    ref.current?.focus({ preventScroll: true });
  }, [x, y]);
  return (
    <button
      ref={ref}
      type="button"
      id="autora-more"
      aria-label="Menu for what is selected"
      aria-haspopup="menu"
      style={{ left: at.x, top: at.y }}
      // The press that opened it must not close it again.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        const box = ref.current?.getBoundingClientRect();
        onOpen({ x: box ? box.left : at.x, y: box ? box.bottom + 4 : at.y });
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="1.9" fill="currentColor" />
        <circle cx="12" cy="12" r="1.9" fill="currentColor" />
        <circle cx="19" cy="12" r="1.9" fill="currentColor" />
      </svg>
    </button>
  );
}
