import { IconRotateCcw, IconRotateCw } from "../Icons";
import type { Step } from "./useCanvas";

/** The history: Undo and Redo, each naming the step it would take back or put back. */
export function History({ past, future, onUndo, onRedo }: {
  past: Step[];
  future: Step[];
  onUndo: () => void;
  onRedo: () => void;
}) {
  /* With nothing to take back or put back it has nothing to offer: it stays where it is, so nothing moves when it is needed,
     but unseen and out of reach until the first change. */
  const idle = past.length + future.length === 0;
  return (
    <div className="pa-history" aria-label="History" data-idle={idle ? "" : undefined} {...(idle ? ({ inert: "" } as object) : {})}>
      <button type="button" className="pa-hbtn" onClick={onUndo} disabled={!past.length} aria-label="Undo" title={past.length ? `Undo: ${past.at(-1)!.label}` : "Undo"}><IconRotateCcw size={13} /></button>
      <button type="button" className="pa-hbtn" onClick={onRedo} disabled={!future.length} aria-label="Redo" title={future.length ? `Redo: ${future.at(-1)!.label}` : "Redo"}><IconRotateCw size={13} /></button>
    </div>
  );
}
