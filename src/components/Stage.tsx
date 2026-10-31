/**
 * The pinned stage, on a phone: the page, the plan and an explainer held above
 * the conversation instead of inside it. See lib/stage.ts for what is held.
 *
 * Every pane stays mounted and only the chosen one is shown, so switching
 * tabs never reloads the page's feed or restarts the explainer, and folding
 * the stage away costs nothing to bring back.
 */
import type { ReactNode } from "react";
import { PanaceaWorkspace } from "./PanaceaWorkspace";
import { workspaceMode, workspaceSurface, type WorkspaceMode } from "../lib/workspace";
import type { Surface, SurfaceKind } from "../lib/stage";
import { IconCube, IconGame, IconImage, IconFile, IconGlobe, IconList, IconMark, IconMonitor, IconMusic, IconSparkle, IconVideo } from "./Icons";

const ICON: Record<SurfaceKind, ReactNode> = {
  app: <IconMonitor size={14} />,
  pdf: <IconFile size={14} />,
  video: <IconVideo size={14} />,
  cad: <IconCube size={14} />,
  game: <IconGame size={14} />,
  photo: <IconImage size={14} />,
  panacea: <IconSparkle size={14} />,
  studio: <IconMusic size={14} />,
  docx: <IconFile size={14} />,
  pptx: <IconFile size={14} />,
  xlsx: <IconFile size={14} />,
  browser: <IconGlobe size={14} />,
  plan: <IconList size={14} />,
  widget: <IconMark size={14} />,
};

/** A tab is its name and nothing else: what is in it is what is below. The dot
    says the agent is at work in it. */
export const NAME: Record<SurfaceKind, string> = { app: "Apps & code", pdf: "PDF", video: "Video", cad: "3D", game: "Games", photo: "Images", panacea: "Canvas", studio: "Music", docx: "Documents", pptx: "Presentations", xlsx: "Spreadsheets", browser: "Web", plan: "To do", widget: "Explainers" };

export function Stage({
  sessionId, onAsk, surfaces, active, collapsed, expanded, following, onPick, onFollow, onToggle, onExpand, render,
}: {
  sessionId: string;
  onAsk?: (text: string) => void;
  surfaces: readonly Surface[];
  active: SurfaceKind;
  collapsed: boolean;
  /** The stage fills the screen's height, the conversation shrunk to a strip. */
  expanded: boolean;
  /** The stage is showing whatever the agent touched last, by itself. */
  following: boolean;
  onPick: (kind: SurfaceKind) => void;
  onFollow: () => void;
  onToggle: () => void;
  onExpand: () => void;
  render: (surface: Surface) => ReactNode;
}) {
  const modes = surfaces.flatMap((s) => { const mode = workspaceMode(s.kind); return mode ? [mode] : []; });
  const picked = (mode: WorkspaceMode) => onPick(workspaceSurface(mode) as SurfaceKind);
  return (
    <section
      className={`stage${collapsed ? " is-collapsed" : ""}${expanded && !collapsed ? " is-expanded" : ""}${surfaces.length > 2 ? " is-tight" : ""}`}
      aria-label="Pinned Panacea workspace"
    >
      <PanaceaWorkspace sessionId={sessionId} modes={modes} active={workspaceMode(active) ?? "panacea"} phone
        following={following} onPick={picked} onFollow={onFollow} onAsk={onAsk}
        collapsed={collapsed} expanded={expanded} onToggle={onToggle} onExpand={onExpand}>
        {surfaces.map((surface) => (
          <div
            key={surface.key}
            className="stage-pane"
            data-pane={workspaceMode(surface.kind) ?? ""}
            aria-label={`${NAME[surface.kind]} surface`}
          >
            {render(surface)}
          </div>
        ))}
      </PanaceaWorkspace>
    </section>
  );
}

/**
 * What the thread keeps where a held card was: a line saying where it went, so
 * the conversation still reads in order. The words the agent said while it
 * worked the page stay under it, in the thread, where they can be scrolled.
 */
export function StageStub({
  kind, title, note, onOpen, children,
}: { kind: SurfaceKind; title: string; note: string; /** Where it went, when it can be brought up: a window beside the chat. */ onOpen?: () => void; children?: ReactNode }) {
  const body = (
    <>
      <span className="stage-stub-ico" aria-hidden="true">{ICON[kind]}</span>
      <b className="stage-stub-title">{title}</b>
      <span className="stage-stub-note">{note}</span>
    </>
  );
  return (
    <>
      {onOpen ? (
        <button type="button" className="stage-stub is-open" onClick={onOpen} title={note}>{body}</button>
      ) : (
        <div className="stage-stub">{body}</div>
      )}
      {children}
    </>
  );
}
