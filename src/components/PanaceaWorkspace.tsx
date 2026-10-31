import { Suspense, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { NativeWorkspaceActions, WorkspaceMode } from "../lib/workspace";
import { hostedWork } from "../lib/workspaceScene";
import { PanaceaWindow } from "./lazyWindows";
import type { BoardHandle } from "./panacea/Board";
import { IconChevron, IconMaximize, IconMinimize, IconSparkle, IconWrench } from "./Icons";
import { ToolsSheet } from "./ToolsSheet";
import { VisibleWork } from "./VisibleWork";

/** Every engine and native surface shares the Board's world and camera. */
export function PanaceaWorkspace({
  sessionId, modes, active, following, onPick, onFollow, onCloseMode, onAsk, children,
  phone = false, collapsed = false, expanded = false, onToggle, onExpand, navigationHost, nativeActionsRef,
}: {
  sessionId: string;
  modes: readonly WorkspaceMode[];
  active: WorkspaceMode;
  following: boolean;
  onPick: (mode: WorkspaceMode) => void;
  onFollow: () => void;
  onCloseMode?: (mode: WorkspaceMode) => void;
  onAsk?: (text: string) => void;
  children: ReactNode;
  phone?: boolean;
  collapsed?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onExpand?: () => void;
  navigationHost?: HTMLElement | null;
  nativeActionsRef?: MutableRefObject<NativeWorkspaceActions | null>;
}) {
  const [chooser, setChooser] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const scene = useRef<BoardHandle | null>(null);
  const ownNativeActions = useRef<NativeWorkspaceActions | null>(null);
  const nativeActions = nativeActionsRef ?? ownNativeActions;
  const hosted = useMemo(() => hostedWork(children), [children]);
  const pick = (mode: WorkspaceMode) => {
    onPick(mode);
    if (phone && !expanded) onExpand?.();
  };
  const jump = (mode: WorkspaceMode) => {
    pick(mode);
    scene.current?.jump(mode === "panacea" ? null : `engine:${mode}`);
  };
  return (
    <section className={`panacea-workspace${phone ? " is-phone" : ""}${collapsed ? " is-collapsed" : ""}`} aria-label="Panacea workspace" data-mode={active}>
      <header className="pw-bar">
        <IconSparkle size={16} />
        <b>Panacea</b>
        <button className="btn ghost pw-choose" type="button" onClick={() => setChooser(true)} aria-expanded={chooser}>
          <IconWrench size={14} /> Capabilities
        </button>
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
      {problem && <p className="set-warn" role="status">{problem}</p>}
      <div className="pw-surfaces" hidden={collapsed}>
        <Suspense fallback={<p className="jf-hint">Opening the workspace…</p>}>
          <PanaceaWindow sessionId={sessionId} hosted={hosted} nativeOpen={modes.includes("panacea")} scene={scene}
            followTarget={following ? active : null} onJump={pick} onCloseWork={onCloseMode} navigationHost={navigationHost} nativeActions={nativeActions} />
        </Suspense>
      </div>
      {chooser && <ToolsSheet session={sessionId} onClose={() => setChooser(false)} onTrouble={setProblem}
        onFlowchart={async () => {
          if (!nativeActions.current) throw new Error("The workspace is still opening. Try again in a moment.");
          await nativeActions.current.createFlowchart();
        }}
        openModes={modes} onSelect={jump}
        onOpened={(_name, _app, mode) => { if (mode) jump(mode); }}
        onAsk={(text) => onAsk?.(text)} />}
    </section>
  );
}
