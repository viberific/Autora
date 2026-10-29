import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Value } from "../lib/panacea/atoms";
import { estimateHeight, fade, nearestFree, refocus, removeSurface, restore, setValue, uid, valueAt, valueProblem, type Panel, type Surface } from "../lib/panacea/canvas";
import { IMAGE_COMMANDS, selectionOf, TOOLS } from "../lib/panacea/image";
import type { Recipe } from "../lib/panacea/library";
import { BUILTINS } from "../lib/panacea/library";
import { densityOf, newProfile, normalizeProfile, noteUse, preferredSide, quieted, usageKey, type Profile } from "../lib/panacea/profile";
import { bindsOf, parseBind, type Node } from "../lib/panacea/recipe";
import { addSurfaceTo, placeRecipe, runCommand, type RunResult, type SurfaceInput } from "../lib/panacea/rules";
import { filteredRows, splitDelimited, tableCsv, tableFrom } from "../lib/panacea/surfaces";

/** A mask as a grey PNG, to keep beside the canvas. */
async function maskPng(mask: Uint8Array, w: number, h: number): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = mask[i]!; img.data[i * 4 + 3] = 255; }
  c.getContext("2d")!.putImageData(img, 0, 0);
  return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("no PNG"))), "image/png"));
}
import { onPanaceaCommand } from "../lib/panacea";
import type { HandStep } from "../lib/panacea/handsteps";
import { Board, type BoardHandle } from "./panacea/Board";
import { standaloneSvg } from "./panacea/Chart";
import { PanaceaCtx, type PanaceaApi } from "./panacea/context";
import { History } from "./panacea/History";
import { imageByHand, runPanaceaHand } from "./panacea/hand";
import { autoSettings } from "./panacea/imagegl";
import type { PanelActions } from "./panacea/PanelCard";
import { imageHandle, pictureOf, renderPicture } from "./panacea/Surfaces";
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

  /** A surface's values set from the surface itself (a tool, a drag), checked, as one step a quick run of them joins. */
  const setOn = useCallback((surfaceId: string, values: Record<string, Value>, label: string) => {
    const entries = Object.entries(values).map(([k, v]) => [`@${surfaceId}.${k}`, v] as const);
    const bad = entries.map(([k, v]) => valueProblem(live.current, k, v)).find(Boolean);
    if (bad) { setProblem(`That value does not fit: ${bad}.`); return; }
    edit((d) => { for (const [k, v] of entries) setValue(d, k, v); }, label, `${surfaceId}:${Object.keys(values).join(",")}`);
    const timers = activityTimers.current;
    const key = `on:${surfaceId}:${Object.keys(values).join(",")}`;
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const where = live.current.surfaces.find((s) => s.id === surfaceId)?.title;
      void tell(`${label.toLowerCase()}${where ? ` on ${where}` : ""}`);
    }, 650));
  }, [edit, live, tell]);

  /** What the last command run here did, for the agent's hand to report. */
  const lastRun = useRef<{ name: string; at: number; result: RunResult } | null>(null);
  /** The agent's hand is at work: what its pointer does on the picture is the agent's, not the person's. */
  const handing = useRef(false);

  /** Export a surface to the project: the picture at full size, or the rows as filtered. */
  const exportSurface = useCallback(async (s: Surface, format: "png" | "jpeg" = "png", given?: string) => {
    const blob = s.kind === "image" ? await renderPicture(s, sessionId, format) : new Blob([tableCsv(s.table!.columns, filteredRows(s.table!, s.params))], { type: "text/csv" });
    const res = await fetch(`${base}/deliver?name=${encodeURIComponent(given ?? s.title)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    const body = (await res.json().catch(() => null)) as { name?: string; error?: string; artifact?: string } | null;
    if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
    return body ?? {};
  }, [base, sessionId]);

  /**
   * Run a surface's command: the engine's one way in, for a button, a key, a tool on the picture, and the agent's hand.
   * What only the page can do happens here first: the model finds an object, the picture says where a selection is.
   */
  const run = useCallback(async (surfaceId: string, name: string, args: Record<string, unknown> = {}, label?: string, who: "person" | "agent" = "person"): Promise<RunResult> => {
    const by = handing.current ? "agent" : who;
    const s = live.current.surfaces.find((x) => x.id === surfaceId);
    const done = (result: RunResult) => { lastRun.current = { name, at: Date.now(), result }; if (!result.ok) setProblem(result.error); return result; };
    if (!s) return done({ ok: false, error: "That surface is gone." });
    const what = label ?? IMAGE_COMMANDS.find((c) => c.name === name)?.label ?? name;
    try {
      if (name === "export") {
        const out = await exportSurface(s);
        flash(`Saved ${out.name ?? s.title} to the project.`);
        void tell(`exported ${out.name ?? s.title}`);
        return done({ ok: true, said: `Exported ${out.name ?? s.title}.` });
      }
      if (name === "auto") {
        const img = pictureOf(s.id);
        if (!img) return done({ ok: false, error: "The picture is not loaded yet." });
        const auto = autoSettings(img);
        edit((d) => { const t = d.surfaces.find((x) => x.id === s.id)!; for (const [k, v] of Object.entries(auto)) t.params[k] = v; }, `Auto on ${s.title}`);
        void tell(`pressed Auto on ${s.title}: ${Object.entries(auto).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        return done({ ok: true, said: `Auto: ${Object.entries(auto).map(([k, v]) => `${k} ${v}`).join(", ")}.` });
      }
      const handle = imageHandle(s.id);
      let given = args;
      if ((name === "select.object" || name === "select.subject") && typeof args.mask !== "string") {
        const work = handle?.work();
        if (!work) return done({ ok: false, error: "The picture is not loaded yet." });
        const seg = await import("./panacea/segment");
        const found = name === "select.subject" ? await seg.subjectOf(work) : { mask: await seg.objectAt(work, Number(args.x), Number(args.y)), x: Number(args.x), y: Number(args.y) };
        const png = await maskPng(found.mask, work.width, work.height);
        const res = await fetch(`${base}/mask`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
        const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
        if (!res.ok || !body?.id) return done({ ok: false, error: body?.error ?? "The object's outline could not be kept." });
        given = { ...args, x: found.x, y: found.y, mask: body.id };
      }
      let result: RunResult = { ok: false, error: "Not done." };
      edit((d) => { result = runCommand(d, s.id, name, given, find, { by, side: preferredSide(profile), env: handle ? { bounds: handle.bounds } : {} }); }, by === "agent" ? `Autora: ${what}` : what);
      if (result.ok && by === "person") void tell(`${what.toLowerCase()} on ${s.title}`);
      return done(result);
    } catch (err) {
      return done({ ok: false, error: `${what}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [base, edit, exportSurface, find, flash, live, profile, tell]);

  const act = useCallback((bind: string, args?: Record<string, unknown>) => {
    const { surface, param } = parseBind(bind);
    if (surface) void run(surface, param, args ?? {});
  }, [run]);

  const ask = useCallback((text: string, panel: Panel) => {
    const vals = [...new Set(bindsOf(panel.tree))].map((b) => `${b}=${show(valueAt(live.current, b))}`).join(", ");
    sendPrompt(`${text}${vals ? `\n\n(From the Panacea panel "${panel.title}": ${vals}.)` : ""}`);
  }, [live, sendPrompt]);

  const expand = useCallback((panel: Panel, open: boolean) => {
    edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.expanded = open; }, open ? `More on ${panel.title}` : `Less on ${panel.title}`);
    if (open) void tell(`opened More on "${panel.title}"`);
  }, [edit, tell]);

  const hold = doc.hold;
  const api: PanaceaApi = useMemo(() => ({
    canvas, profile, sessionId, set, act, run, setOn, ask, hold, expand,
    value: (key: string) => valueAt(canvas, key),
  }), [canvas, profile, sessionId, set, act, run, setOn, ask, hold, expand]);

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
    else void tell(`added ${input.kind === "image" ? "the photo" : "the table"} ${input.name}`);
  }, [edit, find, profile, tell]);

  const onFiles = useCallback((files: File[], at: { x: number; y: number }) => {
    void (async () => {
      for (const [i, f] of files.slice(0, 4).entries()) {
        try {
          const res = await fetch(`${base}/import?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
          const body = (await res.json().catch(() => null)) as { kind?: "image" | "data"; artifact?: string; name?: string; px?: { w: number; h: number } | null; table?: SurfaceInput["table"]; error?: string } | null;
          if (!res.ok || !body?.kind) throw new Error(body?.error ?? `Autora answered ${res.status}`);
          addSurface({ kind: body.kind, name: body.name ?? f.name, artifact: body.artifact, px: body.px, table: body.table, at: { x: at.x + i * 48, y: at.y + i * 48 } });
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

  // The command listener stays put (it says the window is ready to the server); what it calls is read fresh each time.
  const latest = useRef({ run, setOn, exportSurface });
  latest.current = { run, setOn, exportSurface };
  useEffect(() => {
    const off = onPanaceaCommand((cmd) => {
      const { run, setOn, exportSurface } = latest.current;
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
            if (!s || !pictureOf(s.id)) throw new Error("That picture is not loaded in the window.");
            await reply(true, await exportSurface(s, cmd.args.format === "jpeg" ? "jpeg" : "png", String(cmd.args.name ?? s.title)));
          } else if (cmd.name === "do") {
            // The agent's commands on a surface, by hand (Visible work) or straight away, in order; stops at the first that fails.
            const surfaceId = String(cmd.args.surface);
            const list = Array.isArray(cmd.args.commands) ? (cmd.args.commands as Array<{ name: string; args?: Record<string, unknown> }>) : [];
            const results: Array<{ name: string; ok: boolean; said?: string; error?: string; hand?: boolean }> = [];
            for (const c of list) {
              let r: RunResult | null = null;
              let hand = false;
              if (cmd.args.hand === true && root.current && board.current) {
                handing.current = true;
                const did = await imageByHand(surfaceId, c.name, c.args ?? {}, { root: root.current, board: board.current, lastRun, setOn }).finally(() => { handing.current = false; });
                if (did) { r = did; hand = true; }
              }
              r ??= await run(surfaceId, c.name, c.args ?? {}, undefined, "agent");
              results.push({ name: c.name, ok: r.ok, ...(r.ok ? { said: r.said } : { error: r.error }), ...(hand ? { hand } : {}) });
              if (!r.ok) break;
            }
            await saveNow();
            await reply(true, { results });
          } else if (cmd.name === "snapshot") {
            const h = imageHandle(String(cmd.args.surface));
            const blob = h ? await h.snapshot(cmd.args.grid !== false) : null;
            if (!blob) throw new Error("That picture is not on screen.");
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            await reply(true, { base64: btoa(bin) });
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

  const focusImage = canvas.surfaces.find((s) => s.id === canvas.focus && s.kind === "image" && s.image) ?? null;

  /** The picture's keys, while it is the work: a tool's letter, and the engine's shortcuts (Ctrl+D deselects, Ctrl+J copies to a layer...). */
  const imageKey = (e: ReactKeyboardEvent): boolean => {
    if (!focusImage || selected.size) return false;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const combo = `${mod ? "mod+" : ""}${e.shiftKey ? "shift+" : ""}${k}`;
    const cmd = IMAGE_COMMANDS.find((c) => c.key === combo);
    if (cmd && cmd.name !== "layer.erase") { e.preventDefault(); void run(focusImage.id, cmd.name); return true; }
    if (!mod && !e.altKey && !e.shiftKey) {
      const t = TOOLS.find((x) => x.key === k || (x.key === "Escape" && e.key === "Escape" && focusImage.params.tool !== "pointer"));
      if (t) { e.preventDefault(); setOn(focusImage.id, { tool: t.name }, `${t.label} tool`); return true; }
    }
    return false;
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current?.querySelector("button")?.click(); return; }
    if (target.closest("input, textarea, select, iframe")) return;
    if (imageKey(e)) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doc.redo(); else doc.undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doc.redo(); }
    else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); group(); }
    else if (e.key === "/") { e.preventDefault(); board.current?.summonHere(); }
    else if (e.key === "Delete" || e.key === "Backspace") { if (selected.size) { e.preventDefault(); putAwaySelected(); } else if (focusImage && selectionOf(focusImage.image!, focusImage.params)) { e.preventDefault(); void run(focusImage.id, "layer.erase"); } }
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
