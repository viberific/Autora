import { useEffect, useRef, useState } from "react";
import { IconCheck } from "./Icons";

export type Effort = "low" | "medium" | "high";

/** The providers whose model takes a thinking effort: Claude and Gemini, by subscription or (Claude) by key. */
export const takesEffort = (providerId: string | null): boolean =>
  providerId === "claude-cli" || providerId === "gemini-cli" || providerId === "anthropic";

const LEVELS: { id: Effort; label: string; blurb: string }[] = [
  { id: "low", label: "Low", blurb: "Quickest. Thinks least." },
  { id: "medium", label: "Medium", blurb: "The default. Good work without a long wait." },
  { id: "high", label: "High", blurb: "Thinks longest. For hard problems." },
];

/**
 * How hard the model thinks in this chat, in the header beside the chat's other choices. It shows only where the model takes
 * the setting (Claude, Gemini); unset, Autora picks a level for the model (server/modelprofile.ts autoEffort).
 */
export function EffortPill({ effort, onChange }: { effort: Effort | null; onChange: (effort: Effort | null) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = LEVELS.find((l) => l.id === (effort ?? "medium")) ?? LEVELS[1];
  return (
    <div className="effort-wrap" ref={wrap}>
      <button
        type="button"
        className={`effort-pill${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Thinking effort: ${shown.label}`}
        title={`Thinking effort: ${shown.label}. Press to change`}
        onClick={() => setOpen((o) => !o)}
      >
        {shown.label}
      </button>
      {open && (
        <div className="effort-menu" role="menu">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitemradio"
              aria-checked={l.id === shown.id}
              className={`effort-option${l.id === shown.id ? " on" : ""}`}
              onClick={() => { onChange(l.id); setOpen(false); }}
            >
              <span className="effort-option-top"><span>{l.label}</span>{l.id === shown.id && <IconCheck size={13} />}</span>
              <span className="effort-option-blurb">{l.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
