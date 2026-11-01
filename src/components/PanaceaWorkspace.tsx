import { Suspense, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import type { NativeWorkspaceActions, WorkspaceMode } from "../lib/workspace";
import { hostedWork } from "../lib/workspaceScene";
import { PanaceaWindow } from "./lazyWindows";
import type { BoardHandle } from "./panacea/Board";
import { IconChevron, IconMaximize, IconMinimize } from "./Icons";
import { VisibleWork } from "./VisibleWork";

/** Every engine and native surface shares the Board's world and camera. */
export function PanaceaWorkspace({
  sessionId, modes, active, following, onPick, onFollow, onCloseMode, children,
  phone = false, collapsed = false, expanded = false, onToggle, onExpand, navigationHost, nativeActionsRef,
}: {
  sessionId: string;
  modes: readonly WorkspaceMode[];
  active: WorkspaceMode;
  following: boolean;
  onPick: (mode: WorkspaceMode) => void;
  onFollow: () => void;
  onCloseMode?: (mode: WorkspaceMode) => void;
  children: ReactNode;
  phone?: boolean;
  collapsed?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onExpand?: () => void;
  navigationHost?: HTMLElement | null;
  nativeActionsRef?: MutableRefObject<NativeWorkspaceActions | null>;
}) {
  const scene = useRef<BoardHandle | null>(null);
  const ownNativeActions = useRef<NativeWorkspaceActions | null>(null);
  const nativeActions = nativeActionsRef ?? ownNativeActions;
  const hosted = useMemo(() => hostedWork(children), [children]);
  const pick = (mode: WorkspaceMode) => {
    onPick(mode);
    if (phone && !expanded) onExpand?.();
  };
  return (
    <section className={`panacea-workspace${phone ? " is-phone" : ""}${collapsed ? " is-collapsed" : ""}`} aria-label="Panacea workspace" data-mode={active}>
      {/* In the app the workspace has no bar of its own: Follow and Visible work sit in the header (App). Only the
          pinned stage, which can fold and grow, keeps one for those two buttons. */}
      {(onToggle || onExpand) && (
        <header className="pw-bar">
          <div className="spacer" />
          <VisibleWork className={phone ? "stage-follow" : "pane-follow"} compact={phone} />
          <button type="button" className={`${phone ? "stage-follow" : "pane-follow"}${following ? " is-on" : ""}`} onClick={onFollow}
            aria-pressed={following} title={following ? "Following the agent — stop following" : "Follow the agent's work"}>
            <span className="watch-dot" aria-hidden="true" /> Follow
          </button>
          {onExpand && !collapsed && <button className="stage-expand" type="button" onClick={onExpand}
            aria-pressed={expanded} aria-label={expanded ? "Shrink Panacea" : "Expand Panacea"}>
            {expanded ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>}
          {onToggle && <button className="stage-fold" type="button" onClick={onToggle}
            aria-expanded={!collapsed} aria-label={collapsed ? "Show Panacea" : "Fold Panacea away"}>
            <IconChevron size={14} />
          </button>}
        </header>
      )}
      <div className="pw-surfaces" hidden={collapsed}>
        <Suspense fallback={<p className="jf-hint">Opening the workspace…</p>}>
          <PanaceaWindow sessionId={sessionId} hosted={hosted} nativeOpen={modes.includes("panacea")} scene={scene}
            followTarget={following ? active : null} onJump={pick} onCloseWork={onCloseMode} navigationHost={navigationHost} nativeActions={nativeActions} />
        </Suspense>
      </div>
    </section>
  );
}
