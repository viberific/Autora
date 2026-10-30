import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Value } from "../lib/panacea/atoms";
import { stateOf, toMarkdown, type DocMode, type DocState } from "../lib/panacea/document";
import { estimateHeight, fade, nearestFree, refocus, removeSurface, restore, setValue, surfaceParams, uid, valueAt, valueProblem, type Canvas, type Panel, type Surface } from "../lib/panacea/canvas";
import { KINDS, type SurfaceKind } from "../lib/panacea/kinds";
import type { Recipe } from "../lib/panacea/library";
import { BUILTINS } from "../lib/panacea/library";
import { densityOf, newProfile, normalizeProfile, noteUse, preferredSide, quieted, usageKey, type Profile } from "../lib/panacea/profile";
import { bindsOf, parseBind, type Node } from "../lib/panacea/recipe";
import { addSurfaceTo, placeRecipe, type SurfaceInput } from "../lib/panacea/rules";
import { filteredRows, splitDelimited, tableCsv, tableFrom } from "../lib/panacea/surfaces";
import { onPanaceaCommand } from "../lib/panacea";
import type { HandStep } from "../lib/panacea/handsteps";
import { Board, type BoardHandle } from "./panacea/Board";
import { standaloneSvg } from "./panacea/Chart";
import { PanaceaCtx, type PanaceaApi } from "./panacea/context";
import { History } from "./panacea/History";
import { runPanaceaHand } from "./panacea/hand";
import { autoSettings, renderFull } from "./panacea/imagegl";
import type { PanelActions } from "./panacea/PanelCard";
import { pictureOf } from "./panacea/Surfaces";
import { useCanvas } from "./panacea/useCanvas";
import { SaveButton, keptAs } from "./SaveButton";
import { LoadButton } from "./LoadButton";
import { IconSparkle, IconX } from "./Icons";

/** A ghost nobody took drifts off after this long. */
const GHOST_MS = 45_000;
/** A panel waved away is not offered again on this canvas for this long. */
const WAVED_MS = 10 * 60_000;

const show = (v: Value | undefined) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * Panacea: the canvas window, beside the conversation.
 *
 * A blank dotted grid. The person says what they want to do (in the chat, or the box along the bottom), or drops a
 * photo or a table on it, and the controls for that work appear around it: panels built from a library of small,
 * calm atoms, placed by the agent, by Panacea's own rules, or summoned by the person with a double-click. They move,
 * widen, pin and group; they fade when the work moves on and come back with a click; suggestions arrive as ghosts to
 * take or wave away. The canvas lives on the server (server/panacea.ts), where the agent's panacea_* tools work on it.
 */
export function PanaceaWindow({ sessionId }: { sessionId: string }) {
  const doc = useCanvas(sessionId);
  const { canvas, edit, quietly, live, saveNow } = doc;
  const base = `/api/panacea/${encodeURIComponent(sessionId)}`;
  const [recipes, setRecipes] = useState<Recipe[]>(BUILTINS);
  const [profile, setProfile] = useState<Profile>(() => newProfile());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [goneOpen, setGoneOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const board = useRef<BoardHandle | null>(null);
  const pending = useRef<{ id: string; at: { x: number; y: number } } | null>(null);
  const saveRef = useRef<HTMLSpanElement>(null);
  const touched = useRef(new Set<string>());
  const activityTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Recipes waved away lately, and when: not offered again for a while, whatever the profile says. */
  const waved = useRef(new Map<string, number>());

  const loadLibrary = useCallback(async () => {
    const got = (await fetch("/api/panacea/library").then((r) => r.json()).catch(() => null)) as { recipes?: Recipe[] } | null;
    if (got?.recipes?.length) setRecipes(got.recipes);
  }, []);
  useEffect(() => {
    void loadLibrary();
    void fetch("/api/panacea/profile").then((r) => r.json()).then((b: { profile?: unknown }) => setProfile(normalizeProfile(b?.profile))).catch(() => undefined);
  }, [loadLibrary]);
  // The agent may have composed something new: the picker should find it.
  useEffect(() => { void loadLibrary(); }, [canvas.panels.length, loadLibrary]);
  const find = useCallback((id: string) => recipes.find((r) => r.id === id) ?? BUILTINS.find((r) => r.id === id), [recipes]);

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 3200);
  }, []);

  // ------------------------------------------------------------- telling --

  /** What the person did, told to the server: the next turn, the companion, the suggester and the profile hear it. */
  const tell = useCallback(async (text: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/activity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, ...extra }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { offer?: { recipe: string; why: string; near: string } } | null;
    const offer = body?.offer;
    if (!offer) return;
    const r = find(offer.recipe);
    if (!r || live.current.panels.some((p) => p.state === "ghost" || (p.recipe === r.id && p.context === offer.near))) return;
    // An offer about a value that has moved on since, or one the person waved away a moment ago, is not made.
    if (typeof extra.bind === "string" && JSON.stringify(valueAt(live.current, extra.bind)) !== JSON.stringify(extra.value)) return;
    if (Date.now() - (waved.current.get(r.id) ?? 0) < WAVED_MS) return;
    quietly((d) => { placeRecipe(d, r, { near: offer.near, state: "ghost", why: offer.why, by: "rule", side: preferredSide(profile), view: board.current?.viewRect() }); });
  }, [base, find, live, quietly, profile]);

  const sendPrompt = useCallback((text: string) => {
    setSent(text);
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
      .then((r) => { if (!r.ok) setSent(null); }).catch(() => setSent(null));
    setTimeout(() => setSent(null), 3500);
  }, [sessionId]);

  // ----------------------------------------------------------- the api --

  const set = useCallback((key: string, v: Value, panel: Panel, label: string) => {
    const bad = valueProblem(live.current, key, v);
    if (bad) { setProblem(`That value does not fit: ${bad}.`); return; }
    const first = !panel.touched && !touched.current.has(panel.id);
    touched.current.add(panel.id);
    edit((d) => {
      setValue(d, key, v);
      const p = d.panels.find((x) => x.id === panel.id);
      if (p) p.touched = Date.now();
    }, label, key);
    setProfile((p) => { const next = { ...p, uses: { ...p.uses } }; noteUse(next, usageKey(key)); return next; });
    // The first use of a panel: a composed one joins the library; its recipe id is written on it.
    if (first) {
      void fetch(`${base}/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ panel }) })
        .then((r) => r.json()).then((b: { recipe?: string }) => {
          if (b?.recipe && b.recipe !== panel.recipe) quietly((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.recipe = b.recipe; });
        }).catch(() => undefined);
    }
    // Told once they settle, not on every frame of a drag.
    const timers = activityTimers.current;
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const { surface } = parseBind(key);
      const where = surface ? live.current.surfaces.find((s) => s.id === surface)?.title : null;
      void tell(`set ${label.replace(/ .*$/, "") || key} to ${show(valueAt(live.current, key))}${where ? ` on ${where}` : ""} (panel "${panel.title}")`, { bind: key, value: valueAt(live.current, key) });
    }, 650));
  }, [base, edit, live, quietly, tell]);

  const act = useCallback((bind: string) => {
    const { surface, param } = parseBind(bind);
    const s = live.current.surfaces.find((x) => x.id === surface);
    if (!s) return;
    if (param === "reset" || param === "clear") {
      const fresh = surfaceParams(s.kind, s.table);
      edit((d) => {
        const t = d.surfaces.find((x) => x.id === s.id)!;
        for (const [k, v] of Object.entries(fresh)) if (param === "reset" ? k !== "compare" : k.startsWith("filter.") || k === "search") t.params[k] = v;
      }, param === "reset" ? `Reset ${s.title}` : `Cleared filters on ${s.title}`);
      void tell(`${param === "reset" ? "reset" : "cleared the filters on"} ${s.title}`);
    } else if (param === "auto") {
      const img = pictureOf(s.id);
      if (!img) return;
      const auto = autoSettings(img);
      edit((d) => { const t = d.surfaces.find((x) => x.id === s.id)!; for (const [k, v] of Object.entries(auto)) t.params[k] = v; }, `Auto on ${s.title}`);
      void tell(`pressed Auto on ${s.title}: ${Object.entries(auto).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    } else if (param === "export") {
      void (async () => {
        try {
          let blob: Blob;
          let name = s.title;
          if (s.kind === "image") {
            const img = pictureOf(s.id);
            if (!img) throw new Error("The picture is not loaded yet.");
            blob = await renderFull(img, s.params, "png");
          } else if (s.kind === "doc") {
            blob = new Blob([toMarkdown(stateOf(s.doc!).doc)], { type: "text/markdown" });
          } else {
            blob = new Blob([tableCsv(s.table!.columns, filteredRows(s.table!, s.params))], { type: "text/csv" });
            name = `${s.title}`;
          }
          const res = await fetch(`${base}/deliver?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
          const body = (await res.json().catch(() => null)) as { name?: string; error?: string } | null;
          if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
          flash(`Saved ${body?.name ?? name} to the project.`);
          void tell(`exported ${body?.name ?? name}`);
        } catch (err) {
          setProblem(`Not exported: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
  }, [base, edit, flash, live, tell]);

  const ask = useCallback((text: string, panel: Panel) => {
    const vals = [...new Set(bindsOf(panel.tree))].map((b) => `${b}=${show(valueAt(live.current, b))}`).join(", ");
    sendPrompt(`${text}${vals ? `\n\n(From the Panacea panel "${panel.title}": ${vals}.)` : ""}`);
  }, [live, sendPrompt]);

  const expand = useCallback((panel: Panel, open: boolean) => {
    edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.expanded = open; }, open ? `More on ${panel.title}` : `Less on ${panel.title}`);
    if (open) void tell(`opened More on "${panel.title}"`);
  }, [edit, tell]);

  /** A document's words or caret moved in its view. Words are a step of history; a caret only brings its panels up to date. */
  const writeDoc = useCallback((id: string, next: DocState, content: boolean) => {
    const apply = (d: Canvas) => {
      const t = d.surfaces.find((x) => x.id === id);
      if (!t) return;
      t.doc = next;
      KINDS[t.kind].settle?.(t);
    };
    const title = live.current.surfaces.find((x) => x.id === id)?.title ?? "the document";
    if (!content) { quietly(apply); return; }
    edit(apply, `Edited ${title}`, `doc:${id}`);
    const timers = activityTimers.current;
    const t = timers.get(`doc:${id}`);
    if (t) clearTimeout(t);
    timers.set(`doc:${id}`, setTimeout(() => { timers.delete(`doc:${id}`); void tell(`edited the document ${title}`); }, 2500));
  }, [edit, live, quietly, tell]);

  const setMode = useCallback((id: string, mode: DocMode) => {
    const s = live.current.surfaces.find((x) => x.id === id);
    edit((d) => { const t = d.surfaces.find((x) => x.id === id); if (t?.doc) t.doc = { ...t.doc, mode }; }, mode === "agent" ? `Autora may write in ${s?.title ?? "the document"}` : `${s?.title ?? "The document"} is yours to write`);
    void tell(mode === "agent" ? `let you write in the document ${s?.title ?? ""}` : `took back writing the document ${s?.title ?? ""}: you format and structure, the words are theirs`);
  }, [edit, live, tell]);

  const hold = doc.hold;
  const api: PanaceaApi = useMemo(() => ({
    canvas, profile, sessionId, set, act, ask, hold, expand, writeDoc, setMode,
    value: (key: string) => valueAt(canvas, key),
  }), [canvas, profile, sessionId, set, act, ask, hold, expand, writeDoc, setMode]);

  // ------------------------------------------------------- panel actions --

  const dismiss = useCallback((panel: Panel) => {
    void fetch(`${base}/activity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "dismiss", recipe: panel.recipe ?? panel.id, text: `waved away "${panel.title}"` }) }).catch(() => undefined);
    if (panel.recipe) {
      waved.current.set(panel.recipe, Date.now());
      setProfile((p) => ({ ...p, dismissed: { ...p.dismissed, [panel.recipe!]: (p.dismissed[panel.recipe!] ?? 0) + 1 } }));
    }
  }, [base]);

  const actions = useMemo<Omit<PanelActions, "grab" | "widen">>(() => ({
    pin: (panel) => edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.pinned = !p.pinned; }, panel.pinned ? `Unpinned ${panel.title}` : `Pinned ${panel.title}`),
    writes: (panel) => {
      const agent = panel.writes !== "agent";
      edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (!p) return; if (agent) p.writes = "agent"; else delete p.writes; }, agent ? `Autora may write in ${panel.title}` : `${panel.title} is yours to write`);
      void tell(agent ? `let you fill "${panel.title}"` : `took back writing "${panel.title}": ask and suggest, the words are theirs`);
    },
    close: (panel) => {
      edit((d) => { fade(d, panel.id); }, `Put away ${panel.title}`);
      void tell(`put away "${panel.title}"`);
    },
    notThis: (panel) => {
      edit((d) => { fade(d, panel.id); }, `Not this: ${panel.title}`);
      dismiss(panel);
    },
    accept: (panel) => {
      edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) { p.state = "live"; p.at = Date.now(); } }, `Added ${panel.title}`);
      void tell(`took the suggestion "${panel.title}"`, panel.recipe ? { kind: "use", recipe: panel.recipe } : {});
    },
    wave: (panel) => {
      edit((d) => { d.panels = d.panels.filter((x) => x.id !== panel.id); }, `Not now: ${panel.title}`);
      dismiss(panel);
    },
    keep: (panel) => {
      edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.state = "live"; }, `Kept ${panel.title}`);
      void fetch(`${base}/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ panel: { ...panel, state: "live" } }) })
        .then((r) => r.json()).then((b: { recipe?: string }) => {
          if (b?.recipe) { quietly((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.recipe = b.recipe; }); flash(`"${panel.title}" is in the library now.`); void loadLibrary(); }
        }).catch(() => undefined);
      void tell(`kept the bespoke piece "${panel.title}" in the library`);
    },
    discard: (panel) => {
      edit((d) => { d.panels = d.panels.filter((x) => x.id !== panel.id); }, `Discarded ${panel.title}`);
      void tell(`discarded the draft "${panel.title}"`);
    },
    wake: (panel) => edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.state = "live"; }, `Brought back ${panel.title}`),
  }), [edit, quietly, tell, dismiss, base, flash, loadLibrary]);

  // ------------------------------------------------------------- board --

  const onPick = useCallback((r: Recipe, at: { x: number; y: number }) => {
    const forced = pending.current;
    let recipe = r;
    if (r.id.startsWith("blank.")) {
      // A blank piece gets a value of its own, so two sliders summoned are two values.
      let name = "value";
      for (let i = 2; live.current.values[name] !== undefined; i++) name = `value${i}`;
      const rebind = (n: Node): Node => ({ ...n, ...(n.bind ? { bind: name } : {}), ...(n.children ? { children: n.children.map(rebind) } : {}) });
      recipe = { ...r, tree: rebind(r.tree) };
    }
    let placed: Panel | null = null;
    edit((d) => {
      // Where the person asked for it, or the free spot nearest there: it never lands on top of something.
      const spot = forced?.at ?? nearestFree(d, recipe.w, estimateHeight(recipe.tree, recipe.w), { x: at.x + recipe.w / 2, y: at.y + 40 });
      const p = placeRecipe(d, recipe, { at: spot, ...(forced ? { id: forced.id } : {}), by: forced ? "agent" : "person", why: forced ? "Autora summoned it." : "You added it.", side: preferredSide(profile) });
      if ("error" in p) setProblem(p.error);
      else placed = p;
    }, `Summoned ${r.name}`);
    if (placed && !forced) void tell(`summoned "${r.name}"`, { kind: "use", recipe: r.id });
  }, [edit, live, profile, tell]);

  const onFocus = useCallback((id: string) => {
    const s = live.current.surfaces.find((x) => x.id === id);
    edit((d) => { refocus(d, id); }, `Worked on ${s?.title ?? "a surface"}`);
    void tell(`moved to working on ${s?.title ?? id}`);
  }, [edit, live, tell]);

  const addSurface = useCallback((input: SurfaceInput) => {
    let err: string | null = null;
    edit((d) => {
      const made = addSurfaceTo(d, input, find, { side: preferredSide(profile), quiet: (id) => quieted(profile, id), view: board.current?.viewRect() });
      if ("error" in made) err = made.error;
    }, `Added ${input.title ?? input.name}`);
    if (err) setProblem(err);
    else void tell(`added ${KINDS[input.kind].noun.replace(/^an? /, "the ")} ${input.name}`);
  }, [edit, find, profile, tell]);

  const onFiles = useCallback((files: File[], at: { x: number; y: number }) => {
    void (async () => {
      for (const [i, f] of files.slice(0, 4).entries()) {
        try {
          const res = await fetch(`${base}/import?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
          const body = (await res.json().catch(() => null)) as { kind?: SurfaceKind; artifact?: string; name?: string; px?: { w: number; h: number } | null; table?: SurfaceInput["table"]; doc?: SurfaceInput["doc"]; error?: string } | null;
          if (!res.ok || !body?.kind) throw new Error(body?.error ?? `Autora answered ${res.status}`);
          addSurface({ kind: body.kind, name: body.name ?? f.name, artifact: body.artifact, px: body.px, table: body.table, doc: body.doc, at: { x: at.x + i * 48, y: at.y + i * 48 } });
        } catch (err) {
          setProblem(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
  }, [base, addSurface]);

  const onPaste = useCallback((text: string, at: { x: number; y: number }) => {
    const table = tableFrom(splitDelimited(text));
    if (!table) { setProblem("That paste is not a table: a header row and rows, separated by tabs or commas."); return; }
    addSurface({ kind: "data", name: "Pasted table", title: "Pasted table", table, at });
  }, [addSurface]);

  const onRemoveSurface = useCallback((s: Surface) => {
    edit((d) => { removeSurface(d, s.id); }, `Removed ${s.title}`);
    void tell(`removed ${s.title} from the canvas`);
  }, [edit, tell]);

  const onSurfaceSize = useCallback((s: Surface, px: { w: number; h: number }) => {
    if (s.px?.w === px.w && s.px?.h === px.h) return;
    quietly((d) => { const t = d.surfaces.find((x) => x.id === s.id); if (t) t.px = px; });
  }, [quietly]);

  const onMoved = useCallback((panel: Panel, box: { x: number; y: number; w: number }) => {
    const anchor = live.current.surfaces.find((s) => s.id === panel.context);
    void tell(`moved "${panel.title}"`, anchor ? { kind: "move", box, anchor: { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h } } : {});
  }, [live, tell]);

  const select = useCallback((ids: Set<string>) => setSelected(ids), []);

  // Ghosts nobody took drift off.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const old = live.current.panels.filter((p) => p.state === "ghost" && now - p.at > GHOST_MS);
      if (old.length && !root.current?.querySelector(".pa-panel.is-ghost:hover")) quietly((d) => { d.panels = d.panels.filter((p) => !old.some((o) => o.id === p.id)); });
    }, 5000);
    return () => clearInterval(t);
  }, [live, quietly]);

  // ---------------------------------------------------------- commands --

  useEffect(() => {
    const off = onPanaceaCommand((cmd) => {
      void (async () => {
        const claim = (await fetch(`${base}/claim?id=${encodeURIComponent(cmd.id)}`, { method: "POST" }).then((r) => r.json()).catch(() => null)) as { won?: boolean } | null;
        if (!claim?.won) return;
        const reply = (ok: boolean, value: unknown) =>
          fetch(`${base}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cmd.id, ok, value }) }).catch(() => undefined);
        try {
          if (cmd.name === "hand") {
            const el = root.current;
            if (!el || !board.current) throw new Error("The canvas is not on screen.");
            const steps = Array.isArray(cmd.args.steps) ? (cmd.args.steps as HandStep[]) : [];
            const out = await runPanaceaHand(steps, { root: el, board: board.current, pending });
            await saveNow();
            await reply(true, out);
          } else if (cmd.name === "render") {
            const s = live.current.surfaces.find((x) => x.id === cmd.args.surface);
            const img = s ? pictureOf(s.id) : null;
            if (!s || !img) throw new Error("That picture is not loaded in the window.");
            const format = cmd.args.format === "jpeg" ? "jpeg" : "png";
            const blob = await renderFull(img, s.params, format);
            const res = await fetch(`${base}/deliver?name=${encodeURIComponent(String(cmd.args.name ?? s.title))}`, { method: "POST", headers: { "Content-Type": `image/${format}` }, body: blob });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Autora answered ${res.status}`);
            await reply(true, body);
          } else if (cmd.name === "chart") {
            const svg = root.current?.querySelector<SVGSVGElement>(`[data-panel="${CSS.escape(String(cmd.args.panel))}"] svg.pa-chart`);
            if (!svg) throw new Error("That panel has no chart on screen.");
            const res = await fetch(`${base}/deliver?name=${encodeURIComponent(String(cmd.args.name ?? "chart"))}`, { method: "POST", headers: { "Content-Type": "image/svg+xml" }, body: standaloneSvg(svg) });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Autora answered ${res.status}`);
            await reply(true, body);
          } else await reply(false, { message: `The window does not know ${cmd.name}.` });
        } catch (err) {
          await reply(false, { message: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
    void fetch(`${base}/ready`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ready: true }) }).catch(() => undefined);
    return () => {
      off();
      void fetch(`${base}/ready`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ready: false }), keepalive: true }).catch(() => undefined);
    };
  }, [base, live, saveNow]);

  // -------------------------------------------------------------- keys --

  const putAwaySelected = useCallback(() => {
    if (!selected.size) return;
    const ids = [...selected];
    edit((d) => { for (const id of ids) { const p = d.panels.find((x) => x.id === id); if (p && !p.pinned) fade(d, id); } }, ids.length > 1 ? `Put away ${ids.length} panels` : "Put away a panel");
    setSelected(new Set());
  }, [selected, edit]);

  const group = useCallback(() => {
    const ids = [...selected];
    if (ids.length < 2) return;
    const grouped = ids.every((id) => { const g = live.current.panels.find((p) => p.id === ids[0])?.group; return g && live.current.panels.find((p) => p.id === id)?.group === g; });
    const g = uid("g");
    edit((d) => { for (const p of d.panels) if (ids.includes(p.id)) { if (grouped) delete p.group; else p.group = g; } }, grouped ? "Ungrouped panels" : "Grouped panels");
  }, [selected, edit, live]);

  const onKey = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current?.querySelector("button")?.click(); return; }
    if (target.closest("input, textarea, select, iframe")) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doc.redo(); else doc.undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doc.redo(); }
    else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); group(); }
    else if (e.key === "/") { e.preventDefault(); board.current?.summonHere(); }
    else if (e.key === "Delete" || e.key === "Backspace") { if (selected.size) { e.preventDefault(); putAwaySelected(); } }
    else if (e.key === "Escape") setSelected(new Set());
  };

  const keep = useCallback(async () => {
    await doc.saveNow();
    return keptAs(await fetch(`${base}/keep`, { method: "POST" }));
  }, [doc, base]);

  const empty = !canvas.surfaces.length && !canvas.panels.length;
  const note = doc.notice ?? problem;
  const selectionGrouped = selected.size > 1 && (() => { const ids = [...selected]; const g = canvas.panels.find((p) => p.id === ids[0])?.group; return !!g && ids.every((id) => canvas.panels.find((p) => p.id === id)?.group === g); })();

  return (
    <PanaceaCtx.Provider value={api}>
      <div ref={root} className="pa-window" data-density={densityOf(profile)} tabIndex={0} onKeyDown={onKey} aria-label="Panacea">
        <div className="pdf-bar">
          <span className="pdf-bar-ico" aria-hidden="true"><IconSparkle size={14} /></span>
          <span className="pdf-bar-app">Panacea</span>
          <input className="st-song-name" value={canvas.name} size={Math.max(4, canvas.name.length + 1)} maxLength={80} aria-label="Canvas name"
            onChange={(e) => { const name = e.target.value; edit((d) => { d.name = name; }, "Renamed the canvas", "name"); }} />
          <span className={`pdf-bar-note st-save is-${doc.save}`}>{doc.save === "saving" ? "Saving…" : doc.save === "error" ? "Not saved" : "Saved as you go"}</span>
          <div className="spacer" />
          <span ref={saveRef} className="st-save-btn"><LoadButton app="panacea" session={sessionId} phone={false} /><SaveButton onSave={keep} /></span>
        </div>
        {note && (
          <div className="pdf-problem" role="status">
            {note}
            <button className="st-x" onClick={() => { setProblem(null); doc.dismiss(); }} aria-label="Dismiss"><IconX size={11} /></button>
          </div>
        )}
        <Board
          canvas={canvas}
          fresh={doc.fresh}
          edit={edit}
          hold={doc.hold}
          recipes={recipes}
          actions={actions}
          selected={selected}
          setSelected={select}
          onPick={onPick}
          onFocus={onFocus}
          onFiles={onFiles}
          onPaste={onPaste}
          onRemoveSurface={onRemoveSurface}
          onSurfaceSize={onSurfaceSize}
          onMoved={onMoved}
          handle={board}
        >
          {empty && doc.ready && (
            <div className="pa-empty pa-chrome">
              <h3>What do you want to do?</h3>
              <p>Tell Autora below, or drop a photo or a table here. Double-click anywhere for a piece of your own.</p>
            </div>
          )}
          {selected.size > 1 && (
            <div className="pa-selbar pa-chrome" role="toolbar" aria-label="Picked panels">
              <span>{selected.size} picked</span>
              <button type="button" onClick={group}>{selectionGrouped ? "Ungroup" : "Group"}</button>
              <button type="button" onClick={putAwaySelected}>Put away</button>
            </div>
          )}
          <div className="pa-dock pa-chrome">
            {canvas.gone.length > 0 && (
              <div className="pa-gone">
                <button type="button" className="pa-gone-btn" aria-expanded={goneOpen} onClick={() => setGoneOpen(!goneOpen)}>{canvas.gone.length} put away</button>
                {goneOpen && (
                  <div className="pa-gone-list">
                    {[...canvas.gone].reverse().map((g) => (
                      <button key={g.id} type="button" onClick={() => { edit((d) => { restore(d, g.id); }, `Brought back ${g.title}`); void tell(`brought back "${g.title}"`); setGoneOpen(false); }}>
                        <b>{g.title}</b><span>Bring back</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <form className="pa-ask" onSubmit={(e) => { e.preventDefault(); const t = prompt.trim(); if (!t) return; sendPrompt(t); setPrompt(""); }}>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={sent ? "Sent to Autora. Watch the canvas." : empty ? "What do you want to do?" : "Ask Autora…"} aria-label="Ask Autora" />
              <button type="submit" disabled={!prompt.trim()} aria-label="Send">↑</button>
            </form>
            <History past={doc.track.past} future={doc.track.future} onScrub={doc.scrub} onUndo={doc.undo} onRedo={doc.redo} />
          </div>
          {toast && <div className="pa-toast pa-chrome" role="status">{toast}</div>}
        </Board>
      </div>
    </PanaceaCtx.Provider>
  );
}
