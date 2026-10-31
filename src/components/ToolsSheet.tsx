/**
 * Panacea's capability chooser: start a work surface without a turn.
 *
 * Capabilities in the workspace or the composer's wrench opens this. Each row
 * works with nothing in it -- a blank PDF, document, workbook or deck -- so a
 * makes a real, empty file inside Panacea. The
 * browser, the app window and a widget are not here: they have nothing to show
 * until the agent puts something in them.
 *
 * Disabled capabilities stay visible so switched off never reads as missing.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceMode } from "../lib/workspace";
import { IconCode, IconCube, IconFile, IconGame, IconGlobe, IconImage, IconMusic, IconNotebook, IconSlides, IconSparkle, IconStar, IconTable, IconVideo, IconWrench, IconX } from "./Icons";

type Kind = "pdf" | "docx" | "xlsx" | "pptx" | "video" | "cad" | "game" | "photo" | "studio" | "panacea" | "flowchart";

type Tool = {
  kind: Kind;
  app: string;
  /** The setting on the Tools page that decides whether this app is on. */
  setting: WorkspaceMode;
  what: string;
  icon: (size: number) => JSX.Element;
};

const TOOLS: Tool[] = [
  { kind: "panacea", app: "Canvas", setting: "panacea", what: "Adaptive controls, documents, thinking boards, images and data", icon: (s) => <IconSparkle size={s} /> },
  { kind: "flowchart", app: "Flowchart", setting: "panacea", what: "Process, decision, start/end nodes and directed connectors", icon: (s) => <IconSparkle size={s} /> },
  { kind: "docx", app: "Documents", setting: "pages", what: "A blank Word document", icon: (s) => <IconNotebook size={s} /> },
  { kind: "xlsx", app: "Spreadsheets", setting: "sheets", what: "A blank workbook", icon: (s) => <IconTable size={s} /> },
  { kind: "pptx", app: "Presentations", setting: "slides", what: "A blank slide", icon: (s) => <IconSlides size={s} /> },
  { kind: "pdf", app: "PDF", setting: "pdf", what: "A blank page to edit, fill or sign", icon: (s) => <IconFile size={s} /> },
  { kind: "photo", app: "Images", setting: "photo", what: "Layers, masks and brushes", icon: (s) => <IconImage size={s} /> },
  { kind: "video", app: "Video", setting: "video", what: "A new video project", icon: (s) => <IconVideo size={s} /> },
  { kind: "studio", app: "Music", setting: "studio", what: "A new song", icon: (s) => <IconMusic size={s} /> },
  { kind: "cad", app: "3D", setting: "cad", what: "A block to shape", icon: (s) => <IconCube size={s} /> },
  { kind: "game", app: "Games", setting: "game", what: "A new game", icon: (s) => <IconGame size={s} /> },
];

export function ToolsSheet({ session, onClose, onTrouble, onOpened, onAsk, openModes = [], onSelect, onFlowchart }: {
  session: string;
  onClose: () => void;
  /** Put this at the start of the message, for the person to finish (the widget tile). */
  onAsk: (text: string) => void;
  onTrouble: (message: string) => void;
  /** What was opened, so the chat can say so and the window is already up. */
  onOpened: (name: string, app: string, mode?: WorkspaceMode) => void;
  openModes?: readonly WorkspaceMode[];
  onSelect?: (mode: WorkspaceMode) => void;
  onFlowchart?: () => Promise<void>;
}) {
  /* Which apps are on, from the same settings the Tools page writes. Held as
     null while it loads: unknown is not the same as off, and a row that said
     "switched off" for half a second would be wrong. */
  const [on, setOn] = useState<Record<string, { enabled?: boolean } | undefined> | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { if (live) setOn(s?.tools?.config ?? {}); })
      .catch(() => { if (live) setError("Could not load capability settings. Close and reopen Capabilities to try again."); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const buttons = [...(modal.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
        const next = e.shiftKey && document.activeElement === buttons[0] ? buttons.at(-1)
          : !e.shiftKey && document.activeElement === buttons.at(-1) ? buttons[0] : null;
        if (next) { e.preventDefault(); next.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const widgetsOff = on !== null && on.widgets?.enabled === false;

  const open = async (tool: Tool) => {
    if (busy) return;
    setBusy(tool.kind);
    setError(null);
    try {
      if (tool.kind === "flowchart") {
        if (!onFlowchart) throw new Error("Open Capabilities in the workspace to start a flowchart.");
        await onFlowchart();
        onOpened("Flowchart", "Flowchart", "panacea");
        onClose();
        return;
      }
      // The video editor opens on its own project; it makes a blank one itself when there is none.
      if (tool.kind === "video") {
        const res = await fetch(`/api/opencut/open?session=${encodeURIComponent(session)}`, { method: "POST" });
        if (!res.ok) {
          setError(`Autora Video was not opened (${res.status}).`);
          setBusy(null);
          return;
        }
        onOpened("a video project", tool.app, tool.setting);
        onClose();
        return;
      }
      /* Autora 3D has no file to make: the model is the chat's own (server/caddesk.ts), so opening it is its own route. */
      const res = tool.kind === "cad"
        ? await fetch(`/api/cad/${encodeURIComponent(session)}/open`, { method: "POST" })
        : tool.kind === "game"
        ? await fetch(`/api/game/${encodeURIComponent(session)}/open`, { method: "POST" })
        : tool.kind === "studio"
        ? await fetch(`/api/studio/${encodeURIComponent(session)}/open`, { method: "POST" })
        : tool.kind === "photo"
        ? await fetch(`/api/photo/${encodeURIComponent(session)}/open`, { method: "POST" })
        : tool.kind === "panacea"
        ? await fetch(`/api/panacea/${encodeURIComponent(session)}/open`, { method: "POST" })
        : await fetch(`/api/sessions/${session}/new`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: tool.kind }),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(body?.error ?? `A new file was not opened (${res.status}).`));
        setBusy(null);
        return;
      }
      onOpened(String(body?.name ?? "Untitled"), tool.app, tool.setting);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`A new file was not opened: ${message}`);
      onTrouble(message);
      setBusy(null);
    }
  };

  return createPortal(
    <div className="scrim tools-scrim" onClick={onClose} role="presentation">
      <div
        ref={modal}
        className="modal tools-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Panacea capabilities"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <IconWrench size={14} />
          <b>Panacea · Capabilities</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body tools-body">
          <p className="jf-hint">Start work inside Panacea with a blank file or project. Everything stays in one scene.
            Use the bottom-left icons to jump to work, or Show all work to zoom out and see it all.</p>
          {on === null && !error && <p className="jf-hint" role="status">Loading capabilities…</p>}
          <div className="tool-tiles">
            {TOOLS.map((tool) => {
              const off = on !== null && on[tool.setting]?.enabled === false;
              const opened = tool.kind !== "flowchart" && openModes.includes(tool.setting) && !!onSelect;
              return (
                <div className="tool-choice" key={tool.kind}>
                <button
                  type="button"
                  className={`tool-tile${off ? " is-off" : ""}${busy === tool.kind ? " is-busy" : ""}`}
                  disabled={on === null || off || busy !== null}
                  title={off ? `${tool.app} is switched off on the Tools page` : opened ? `Return to ${tool.app}` : `Open ${tool.app} in Panacea`}
                  onClick={() => { if (opened) { onSelect?.(tool.setting); onClose(); } else void open(tool); }}
                >
                  <span className="tool-tile-icon">{tool.icon(20)}</span>
                  <span className="tool-tile-main">
                    <b>{tool.app}</b>
                    <em>{off ? "switched off on the Tools page" : opened ? "Return to your open work" : tool.what}</em>
                  </span>
                  {busy === tool.kind && <span className="attach-spin" aria-hidden="true" />}
                </button>
                {opened && <button type="button" className="btn tiny ghost tool-new" disabled={off || busy !== null}
                  onClick={() => void open(tool)} title={`Create new ${tool.app} work, replacing the current file in this mode`}>
                  New · replace current
                </button>}
                </div>
              );
            })}
            {[
              { setting: "browser", name: "Web", text: "Browse a web page: ", what: "A live page you or the agent can use", icon: <IconGlobe size={20} /> },
              { setting: "app", name: "Apps & code", text: "Build an app that ", what: "Code and a live app to design and review", icon: <IconCode size={20} /> },
            ].map((capability) => {
              const off = on !== null && on[capability.setting]?.enabled === false;
              return <button key={capability.setting} type="button" className={`tool-tile${off ? " is-off" : ""}`}
                disabled={on === null || off || busy !== null} onClick={() => {
                  if (openModes.includes(capability.setting as WorkspaceMode) && onSelect) onSelect(capability.setting as WorkspaceMode);
                  else onAsk(capability.text);
                  onClose();
                }}>
                <span className="tool-tile-icon">{capability.icon}</span>
                <span className="tool-tile-main"><b>{capability.name}</b><em>{off ? "switched off on the Tools page" : capability.what}</em></span>
              </button>;
            })}
            <button
              type="button"
              className={`tool-tile${widgetsOff ? " is-off" : ""}`}
              disabled={on === null || widgetsOff || busy !== null}
              title={widgetsOff ? "Explainers are switched off in Panacea's capabilities" : "Ask for an interactive explainer"}
              onClick={() => { if (openModes.includes("widget") && onSelect) onSelect("widget"); else onAsk("Make an interactive widget that shows "); onClose(); }}
            >
              <span className="tool-tile-icon"><IconSparkle size={20} /></span>
              <span className="tool-tile-main">
                <b>Explainers</b>
                <em>{widgetsOff ? "switched off on the Tools page" : "An interactive explanation in Panacea"}</em>
              </span>
            </button>
          </div>
          {error && <p className="set-warn">{error}</p>}
          <p className="jf-hint tools-more">
            <IconStar size={12} /> Web and Apps &amp; code open in Panacea when you ask to browse a page or build an app.
            Commands run as collapsible cards in the conversation, not in a separate terminal.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
