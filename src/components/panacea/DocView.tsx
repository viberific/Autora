import { useEffect, useRef } from "react";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";
import type { Surface } from "../../lib/panacea/canvas";
import { docStateOf, idPlugin, schema, stateOf, type DocState } from "../../lib/panacea/document";
import { usePanacea } from "./context";

const N = schema.nodes;
const M = schema.marks;

/** Typing `# `, `- `, `1. `, `> ` or three backticks makes the block it means. */
const PLUGINS: Plugin[] = [
  inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,3})\s$/, N.heading!, (m) => ({ level: m[1]!.length })),
      wrappingInputRule(/^\s*([-+*])\s$/, N.bullet_list!),
      wrappingInputRule(/^(\d+)\.\s$/, N.ordered_list!),
      wrappingInputRule(/^\s*>\s$/, N.blockquote!),
      textblockTypeInputRule(/^```$/, N.code_block!),
    ],
  }),
  // No undo of its own: Ctrl+Z is the canvas's history, so one track holds every step.
  keymap({
    "Mod-b": toggleMark(M.strong!),
    "Mod-i": toggleMark(M.em!),
    "Mod-u": toggleMark(M.underline!),
    Enter: splitListItem(N.list_item!),
    Tab: sinkListItem(N.list_item!),
    "Shift-Tab": liftListItem(N.list_item!),
  }),
  keymap(baseKeymap),
  idPlugin,
];

const FAMILY: Record<string, string> = {
  Inter: "Inter, system-ui, sans-serif",
  Georgia: "Georgia, serif",
  "Source Serif": "\"Source Serif 4\", \"Source Serif Pro\", Georgia, serif",
  "IBM Plex Sans": "\"IBM Plex Sans\", system-ui, sans-serif",
  "JetBrains Mono": "\"JetBrains Mono\", ui-monospace, monospace",
};

/** The text, the caret and the pending marks as one string: what tells the view's own echo from a change made elsewhere. */
const signature = (text: string, d: Pick<DocState, "sel" | "marks">) => `${text}|${d.sel?.anchor ?? ""}:${d.sel?.head ?? ""}|${d.marks ? JSON.stringify(d.marks) : ""}`;

const fresh = (surface: Surface, plugins = PLUGINS) => {
  const s = stateOf(surface.doc!);
  return EditorState.create({ doc: s.doc, selection: s.selection, plugins });
};

/**
 * A document surface: the text, edited in place. The tree lives on the surface (so the agent and the panels act on the
 * same one); this view sends what is typed out as canvas edits and takes back what changes it from outside, a panel's
 * Bold or the agent's rewrite or an undo.
 */
export function DocView({ surface }: { surface: Surface }) {
  const api = usePanacea();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** What the view last sent out or took in (see `signature`), and its text alone, kept so a caret move need not rewrite it. */
  const known = useRef("");
  const text = useRef("");
  const latest = useRef(surface);
  latest.current = surface;
  const apiRef = useRef(api);
  apiRef.current = api;
  const blurredAt = useRef(0);
  const has = !!surface.doc;

  useEffect(() => {
    const first = latest.current;
    if (!first.doc || !host.current) return;
    text.current = JSON.stringify(first.doc.json);
    known.current = signature(text.current, first.doc);
    const v: EditorView = new EditorView(host.current, {
      state: fresh(first),
      dispatchTransaction: (tr) => {
        const next = v.state.apply(tr);
        v.updateState(next);
        const cur = latest.current;
        if (!cur.doc) return;
        if (tr.docChanged) {
          const sent = docStateOf(next, cur.doc.mode);
          text.current = JSON.stringify(sent.json);
          known.current = signature(text.current, sent);
          apiRef.current.writeDoc(cur.id, sent, true);
        } else if (tr.selectionSet) {
          const { anchor, head } = next.selection;
          if (cur.doc.sel?.anchor !== anchor || cur.doc.sel?.head !== head || cur.doc.marks) {
            const moved = { sel: { anchor, head } };
            known.current = signature(text.current, moved);
            apiRef.current.writeDoc(cur.id, { json: cur.doc.json, ...moved, mode: cur.doc.mode }, false);
          }
        }
      },
      handleDOMEvents: { blur: () => { blurredAt.current = Date.now(); return false; } },
      attributes: { spellcheck: "true", "aria-label": `${first.title}, a document`, "aria-multiline": "true", role: "textbox" },
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, [has]);

  useEffect(() => {
    const v = view.current;
    if (!v || !surface.doc) return;
    const incoming = JSON.stringify(surface.doc.json);
    const sig = signature(incoming, surface.doc);
    if (sig === known.current) return;
    // The document changed under the view: a panel applied a style, the agent wrote, or history stepped back.
    v.updateState(fresh(surface));
    text.current = incoming;
    known.current = sig;
    // A button on a panel took the focus on its way: give it back, so typing carries on where it was.
    if (Date.now() - blurredAt.current < 1500 && document.activeElement?.tagName === "BUTTON" && document.activeElement.closest(".pa-panel")) v.focus();
  }, [surface]);

  if (!surface.doc) return <div className="pa-chart-empty">This document's text is gone.</div>;
  const mode = surface.doc.mode;
  const p = surface.params;
  return (
    <div className="pa-doc">
      <div className="pa-doc-bar">
        <button
          type="button"
          className="pa-doc-mode"
          aria-pressed={mode === "agent"}
          title={mode === "agent" ? "Autora may write in this document, and you can undo it. Press to write it yourself." : "You write the words; Autora formats and structures. Press to let Autora write."}
          onClick={() => api.setMode(surface.id, mode === "agent" ? "guide" : "agent")}
        >
          {mode === "agent" ? "Autora writes" : "You write"}
        </button>
        <span>{mode === "agent" ? "Every change is a step you can undo" : "Autora formats and structures; the words are yours"}</span>
      </div>
      <div className="pa-doc-scroll">
        <div
          ref={host}
          className="pa-doc-page"
          style={{ fontFamily: FAMILY[String(p.font)] ?? FAMILY.Inter, fontSize: `${Number(p.size) || 11}pt`, lineHeight: Number(p.leading) || 1.5 }}
        />
      </div>
    </div>
  );
}
