import { useEffect, useRef, useState } from "react";
import type { Bucket } from "./derive";
import type { WorkspaceMode } from "./workspace";

export type WorkspaceSnapshot = { mode: WorkspaceMode; open: boolean; since?: number; revision?: string | number };

/** Actual engine state wins over a dispatching tool's name (panacea_surface may open another engine). */
export function latestWorkspaceChange(before: readonly WorkspaceSnapshot[], after: readonly WorkspaceSnapshot[]): WorkspaceMode | null {
  const changed = after.filter((next) => {
    const previous = before.find((s) => s.mode === next.mode);
    return next.open && (!previous?.open || next.since !== previous.since || next.revision !== previous.revision);
  });
  return changed.length ? changed.reduce((best, next) => (next.since ?? 0) >= (best.since ?? 0) ? next : best).mode : null;
}

export function workspaceToolKey(buckets: readonly Bucket[]): number {
  for (let b = buckets.length - 1; b >= 0; b--) {
    for (let c = buckets[b].cells.length - 1; c >= 0; c--) {
      const cell = buckets[b].cells[c];
      if (cell.kind === "tool" || cell.kind === "terminal") return cell.seq;
    }
  }
  return -1;
}

export function useWorkspaceFocus(snapshots: readonly WorkspaceSnapshot[], toolKey: number): WorkspaceMode | null {
  const signature = JSON.stringify(snapshots);
  const previous = useRef<WorkspaceSnapshot[] | null>(null);
  const [activity, setActivity] = useState<{ tool: number; mode: WorkspaceMode | null }>({ tool: -1, mode: null });
  useEffect(() => {
    const next = JSON.parse(signature) as WorkspaceSnapshot[];
    const changed = previous.current ? latestWorkspaceChange(previous.current, next) : null;
    previous.current = next;
    setActivity((was) => ({ tool: toolKey, mode: changed ?? (was.tool === toolKey ? was.mode : null) }));
  }, [signature, toolKey]);
  return activity.tool === toolKey ? activity.mode : null;
}
