import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconCode, IconCube, IconFile, IconGame, IconGlobe, IconImage, IconMusic, IconSlides, IconSparkle, IconTable, IconTerminal, IconVideo } from "../Icons";

type WindowKey = "widgets" | "browser" | "app" | "pdf" | "video" | "studio" | "panacea" | "pages" | "sheets" | "slides" | "cad" | "game" | "photo" | "terminal";

type ToolsState = {
  config: Record<WindowKey, { enabled: boolean }>;
  groups: { group: string; available: boolean; enabled: boolean; detail: string }[];
};

const WINDOWS: { key: WindowKey; name: string; icon: ReactNode; what: string }[] = [
  {
    key: "widgets",
    name: "Explainers",
    icon: <IconSparkle size={18} />,
    what: "Interactive explainers built in the thread: a mechanism you can turn, a graph you can drag.",
  },
  {
    key: "browser",
    name: "Web",
    icon: <IconGlobe size={18} />,
    what: "A real Chromium the agent drives. Watch it, or take over.",
  },
  {
    key: "app",
    name: "Apps & code",
    icon: <IconCode size={18} />,
    what: "Websites and apps the agent builds, live beside the chat to click through, comment on and review.",
  },
  {
    key: "pdf",
    name: "PDF",
    icon: <IconFile size={18} />,
    what: "Write, read, fill, sign, mark up, edit, redact, merge, split and shrink PDFs, beside the chat. Move what the agent placed and add your own.",
  },
  {
    key: "video",
    name: "Video",
    icon: <IconVideo size={18} />,
    what: "Video in OpenCut's editor. The agent imports footage and builds the cut (trims, splits, titles, subtitles) while you watch the timeline. Take over any time.",
  },
  {
    key: "studio",
    name: "Music",
    icon: <IconMusic size={18} />,
    what: "Music beside the chat: instruments, drums, piano roll, mixer and WAV export. Ask for chords, a bass line or a beat, or write the tune yourself and have the agent fix timing and balance. The music stays yours.",
  },
  {
    key: "panacea",
    name: "Canvas",
    icon: <IconSparkle size={18} />,
    what: "A blank canvas where the controls come to the work: drop a photo or a table, or say what you want to do, and the sliders, charts and switches for it appear, and go when you move on. You and the agent both use them.",
  },
  {
    key: "pages",
    name: "Documents",
    icon: <IconFile size={18} />,
    what: "Word documents (.docx) the agent writes, edits and converts. They open beside the chat, and you can type in them too (on a phone, as page pictures you can point at).",
  },
  {
    key: "sheets",
    name: "Spreadsheets",
    icon: <IconTable size={18} />,
    what: "Spreadsheets (.xlsx) with tables, formulas and charts the agent builds. Edit the cells yourself beside the chat.",
  },
  {
    key: "slides",
    name: "Presentations",
    icon: <IconSlides size={18} />,
    what: "Presentations (.pptx) the agent designs and edits. Change any slide yourself beside the chat.",
  },
  {
    key: "terminal",
    name: "Shell commands",
    icon: <IconTerminal size={18} />,
    what: "Non-interactive commands run in the background and keep their streaming output, status and duration in collapsible chat cards. No separate terminal or shared interactive shell.",
  },
  {
    key: "cad",
    name: "3D",
    icon: <IconCube size={18} />,
    what: "3D models built from simple shapes. The agent sketches, extrudes, bevels and cuts, and checks they will print; you push and pull the same model by hand. Exports STL and GLB.",
  },
  {
    key: "game",
    name: "Games",
    icon: <IconGame size={18} />,
    what: "Games in GDevelop's editor beside the chat. The agent does the technical work (wiring, physics, events); the idea, story, look and feel stay yours, and you can change anything by hand. GDevelop's own AI and online services are not included.",
  },
  {
    key: "photo",
    name: "Images",
    icon: <IconImage size={18} />,
    what: "Photos in PhotoCraft's editor beside the chat: layers, masks, filters, type, brushes and real PSD files. The agent does the technical work (cut-outs, resizing, retouching, exports); the look and mood stay yours, and you can paint by hand.",
  },
];

/**
 * Tools: the built-in windows, each switched on or off. Off takes its tools
 * away from the agent from the next turn and tells it so.
 */
export function ToolsPage() {
  const [state, setState] = useState<ToolsState | null>(null);
  const [busy, setBusy] = useState<WindowKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((body: any) => {
    if (body?.tools?.config) setState(body.tools as ToolsState);
  }, []);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(adopt).catch(() => setError("Could not load the tools."));
  }, [adopt]);

  const toggle = async (key: WindowKey, enabled: boolean) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: { [key]: { enabled } } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.detail ?? "Could not change that.");
      else adopt(body);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <section className="tw-card on">
          <div className="tw-head"><span className="tw-icon"><IconSparkle size={18} /></span><b>Panacea</b></div>
          <p className="jf-hint">One workspace for creative and productivity work. Choose a capability from the wrench in chat or
            Capabilities in Panacea. Native surfaces and all retained engines live together in one pannable, zoomable scene.
            Bottom-left icons jump to existing work; Show all work frames everything. No tabs or exclusive work modes.</p>
          <h3>Capability configuration</h3>
          <p className="jf-hint">These switches control abilities inside Panacea, not separate applications. Turning one off removes its tools
            from the agent on the next turn. Shell commands stay in the conversation.</p>
        {error && <p className="set-warn">{error}</p>}
        {state === null && !error && <p className="jf-hint">Loading…</p>}
        {state && (
          <div className="tw-grid pw-capability-settings">
            {WINDOWS.map((w) => {
              const on = state.config[w.key]?.enabled !== false;
              const group = w.key === "browser" ? state.groups.find((g) => g.group === "browser") : null;
              const trouble = on && group && !group.available ? group.detail : null;
              return (
                <section key={w.key} className={`pw-capability${on ? " on" : ""}`}>
                  <div className="tw-head">
                    <span className="tw-icon">{w.icon}</span>
                    <b>{w.name}</b>
                    <span className={`tool-state ${on ? (trouble ? "warn" : "ok") : ""}`}>
                      {on ? (trouble ? "not usable" : "on") : "off"}
                    </span>
                    <div className="spacer" />
                    <button
                      className={`job-switch ${on ? "on" : ""}`}
                      role="switch"
                      aria-checked={on}
                      aria-label={`${w.name}: ${on ? "on" : "off"}`}
                      disabled={busy !== null}
                      onClick={() => void toggle(w.key, !on)}
                    >
                      <span className="job-knob" />
                    </button>
                  </div>
                  <p className="jf-hint">{w.what}</p>
                  {trouble && <p className="set-warn">{trouble}</p>}
                </section>
              );
            })}
          </div>
        )}
        </section>
      </div>
    </div>
  );
}
