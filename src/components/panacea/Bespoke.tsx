import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Value } from "../../lib/panacea/atoms";
import type { Panel } from "../../lib/panacea/canvas";
import type { Node } from "../../lib/panacea/recipe";
import { widgetDocument, type WidgetPalette } from "../../lib/widget";
import { usePanacea } from "./context";

/** The page's colours, as a bespoke piece is given them. */
function palette(): WidgetPalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, d: string) => cs.getPropertyValue(name).trim() || d;
  return {
    bg: v("--s1", "#151824"), surface: v("--s2", "#1b1f2c"), text: v("--text", "#edeff5"), muted: v("--text-2", "#98a1b6"),
    accent: v("--accent", "#6e5bff"), accent2: v("--live", "#22d3ee"), border: v("--border", "rgba(255,255,255,0.11)"),
    font: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif",
  };
}

/**
 * A bespoke piece: code the agent wrote with the person, run in a sandboxed frame (scripts only: no same origin, so it
 * cannot reach Autora, its cookies or its API). It talks to the canvas by messages alone: it is sent the values it
 * binds whenever they change, and may set one of them, never anything else.
 */
export function Bespoke({ node, panel }: { node: Node; panel: Panel }) {
  const api = usePanacea();
  const frame = useRef<HTMLIFrameElement>(null);
  const html = String(node.props?.html ?? "");
  const given = node.props?.binds;
  const binds = useMemo(() => (Array.isArray(given) ? (given as string[]) : []), [given]);
  const height = Number(node.props?.height ?? 240);
  const doc = useMemo(() => widgetDocument({ title: panel.title, html, palette: palette() }), [html, panel.title]);
  const values = useMemo(() => Object.fromEntries(binds.map((b) => [b, api.value(b) ?? null])), [binds, api]);
  const valuesKey = JSON.stringify(values);

  const latest = useRef(values);
  latest.current = values;
  const send = useCallback(() => frame.current?.contentWindow?.postMessage({ type: "panacea:values", values: latest.current }, "*"), []);
  useEffect(() => { send(); }, [valuesKey, send]);

  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as { type?: unknown; key?: unknown; value?: unknown };
      if (m?.type === "panacea:ready") send();
      if (m?.type !== "panacea:set" || typeof m.key !== "string" || !binds.includes(m.key)) return;
      apiRef.current.set(m.key, m.value as Value, panel, panel.title);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [binds, panel, send]);

  return (
    <iframe
      ref={frame}
      className="pa-bespoke"
      title={panel.title}
      sandbox="allow-scripts"
      srcDoc={doc}
      style={{ height }}
      onLoad={send}
      data-atom="bespoke"
    />
  );
}
