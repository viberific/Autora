/**
 * Panacea: the atoms and the rulebook a panel must pass, the library and its placeholders, the canvas (placement, focus
 * and fading, values), the local rules, what is learned about the person, the agent's panacea_* tools, and the routes
 * between the server and the window.
 *
 *   npx tsx tests/panacea.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Surface } from "../src/lib/panacea/canvas";
import type { Node } from "../src/lib/panacea/recipe";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const { checkTree, fingerprint, generalize, treeWords } = await import("../src/lib/panacea/recipe");
const { BUILTINS, DOMAINS, instantiate, searchLibrary } = await import("../src/lib/panacea/library");
const canvasLib = await import("../src/lib/panacea/canvas");
const { contextOf, newCanvas, normalizeCanvas, placeFor, refocus, restore, setValue, surfaceParams, valueAt, valueProblem, describeCanvas } = canvasLib;
const { addSurfaceTo, placeRecipe, suggestFor, starters } = await import("../src/lib/panacea/rules");
const { createDoc } = await import("../src/lib/panacea/document");
const { KINDS } = await import("../src/lib/panacea/kinds");
const { filteredRows, aggregate, splitDelimited, tableFrom, tableCsv } = await import("../src/lib/panacea/surfaces");
const profileLib = await import("../src/lib/panacea/profile");
const { panaceaSteps } = await import("../src/lib/panacea/handsteps");
const panacea = await import("../server/panacea");
const { panaceaSPECS } = await import("../server/specs/panacea");
const { windowOff, toolSettings } = await import("../server/tools");
const { loadedFamilies } = await import("../server/toolload");
const { looksOnly } = await import("../server/modes");
const { manualId, manualText } = await import("../server/handbook");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const CSV = "Month,Region,Revenue,Units\n2024-01,EU,120,5\n2024-01,US,200,8\n2024-02,EU,150,6\n2024-02,US,\"1,180\",7\n2024-03,APAC,90,3\n";
const table = tableFrom(splitDelimited(CSV))!;
const find = (id: string) => BUILTINS.find((r) => r.id === id);

function withSurfaces() {
  const c = newCanvas("Test");
  c.surfaces.push({ id: "img1", kind: "image", title: "Photo", x: 0, y: 0, w: 512, h: 320, name: "p.jpg", params: surfaceParams("image", null) });
  c.surfaces.push({ id: "dat1", kind: "data", title: "Sales", x: 0, y: 600, w: 576, h: 352, name: "s.csv", params: surfaceParams("data", table), table });
  const note: Surface = { id: "doc1", kind: "doc", title: "Notes", x: 0, y: 1400, w: 640, h: 592, name: "notes.md", params: surfaceParams("doc", null), doc: createDoc("# Notes\n\nA first line.") };
  KINDS.doc.settle?.(note);
  c.surfaces.push(note);
  return c;
}

// ------------------------------------------------------------- the tables --

await test("tables read as typed columns: dates, words, numbers with thousands separators", () => {
  assert.deepEqual(table.columns.map((c) => `${c.name}:${c.type}`), ["Month:date", "Region:text", "Revenue:number", "Units:number"]);
  assert.equal(table.rows[3]![2], 1180);
  assert.equal(tableFrom(splitDelimited("a\tb\n1\t2\n"))!.columns.length, 2, "tabs too");
  assert.equal(tableFrom([["only a header"]]), null);
});

await test("filters, search and sort decide the rows; charts aggregate them", () => {
  const params = { ...surfaceParams("data", table), "filter.Region": ["EU"] };
  assert.equal(filteredRows(table, params).length, 2);
  assert.equal(filteredRows(table, { ...surfaceParams("data", table), "filter.Revenue": [100, 160] }).length, 2);
  assert.equal(filteredRows(table, { ...surfaceParams("data", table), search: "apac" }).length, 1);
  const sorted = filteredRows(table, { ...surfaceParams("data", table), sort: "Revenue", descending: true });
  assert.equal(sorted[0]![2], 1180);
  const agg = aggregate(table, table.rows, "Region", ["Revenue"], "sum");
  assert.deepEqual(agg.labels, ["EU", "US", "APAC"]);
  assert.deepEqual(agg.series[0]!.values, [270, 1380, 90]);
  assert.deepEqual(aggregate(table, table.rows, "Month", [], "count").series[0]!.values, [2, 2, 1]);
  assert.match(tableCsv(table.columns, table.rows.slice(0, 1)), /^Month,Region,Revenue,Units\n2024-01,EU,120,5$/);
});

// ------------------------------------------------------------ the rulebook --

await test("the rulebook takes a calm panel of real atoms bound to what a surface declares", () => {
  const c = withSurfaces();
  const out = checkTree({ atom: "group", props: { label: "Light" }, children: [
    { atom: "slider", bind: "@image.exposure", props: { label: "Exposure", min: -99 } },
    { atom: "toggle", bind: "@img1.compare" },
    { atom: "segmented", bind: "mood", props: { options: ["Calm", { value: "wild", label: "Wild", color: "#ff0000" }] } },
  ] }, contextOf(c));
  assert.deepEqual(out.errors, []);
  assert.equal(out.tree!.children![0]!.bind, "@img1.exposure", "@image resolved to the photo");
  assert.equal(out.controls, 3);
});

await test("the rulebook refuses what is outside it, and says why", () => {
  const c = withSurfaces();
  const ctx = contextOf(c);
  assert.match(checkTree({ atom: "wobble" }, ctx).errors.join(), /"wobble" is not an atom/);
  assert.match(checkTree({ atom: "slider", bind: "@img1.sparkle" }, ctx).errors.join(), /no parameter "sparkle". It has: exposure/);
  assert.match(checkTree({ atom: "toggle", bind: "@img1.exposure" }, ctx).errors.join(), /is number, and this atom holds bool/);
  assert.match(checkTree({ atom: "slider" }, ctx).errors.join(), /needs a bind/);
  assert.match(checkTree({ atom: "slider", bind: "9lives" }, ctx).errors.join(), /not a value name/);
  assert.match(checkTree({ atom: "chart", props: { x: "Nope", y: ["Revenue"] } }, ctx).errors.join(), /no column "Nope"/);
  assert.match(checkTree({ atom: "button", props: { action: "@img1.explode" } }, ctx).errors.join(), /not a surface's action/);
  const loud = { atom: "stack", children: Array.from({ length: 9 }, (_, i) => ({ atom: "slider", bind: `v${i}` })) };
  assert.match(checkTree(loud, ctx).errors.join(), /9 controls in view: a panel shows at most 8. Mark the rarer ones "advanced"/);
  const calm = { atom: "stack", children: Array.from({ length: 9 }, (_, i) => ({ atom: "slider", bind: `v${i}`, ...(i > 5 ? { advanced: true } : {}) })) };
  assert.deepEqual(checkTree(calm, ctx).errors, [], "the rest behind More is fine");
  let deep: unknown = { atom: "label", props: { text: "x" } };
  for (let i = 0; i < 6; i++) deep = { atom: "stack", children: [deep] };
  assert.match(checkTree(deep, ctx).errors.join(), /nested deeper than 5/);
});

await test("a panel's shape is its fingerprint: other words and values, same shape; another bind, another shape", () => {
  const a: Node = { atom: "stack", children: [{ atom: "slider", bind: "@img1.exposure", props: { label: "Exposure" } }] };
  const b: Node = { atom: "stack", children: [{ atom: "slider", bind: "@img7.exposure", props: { label: "Brightness" } }] };
  const c2: Node = { atom: "stack", children: [{ atom: "slider", bind: "@img1.contrast", props: { label: "Exposure" } }] };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c2));
  assert.equal(generalize(a, { img1: "image" }).children![0]!.bind, "@image.exposure");
  assert.equal(treeWords(a), 'stack[slider "Exposure" =@img1.exposure]');
});

// ------------------------------------------------------------- the library --

await test("the library has twenty pieces for each kind of work, every one passes the rulebook on a canvas", () => {
  for (const d of DOMAINS) assert.equal(BUILTINS.filter((r) => r.domain === d).length, 20, d);
  assert.equal(new Set(BUILTINS.map((r) => r.id)).size, BUILTINS.length, "ids are unique");
  const c = withSurfaces();
  for (const r of BUILTINS) {
    const made = instantiate(r, contextOf(c));
    assert.ok(!("error" in made), `${r.id}: ${"error" in made ? made.error : ""}`);
    assert.ok(checkTree(r.tree, { ...contextOf(c), lenient: true }).controls <= 8, `${r.id} is calm`);
  }
});

await test("data recipes take the table's own columns; one that needs what the table lacks says so", () => {
  const c = withSurfaces();
  const bar = instantiate(find("data.bar")!, contextOf(c));
  assert.ok(!("error" in bar));
  if (!("error" in bar)) assert.deepEqual([bar.tree.children![0]!.props!.x, bar.tree.children![0]!.props!.y], ["Region", ["Revenue"]]);
  const words = tableFrom([["A", "B"], ["x", "y"]])!;
  const plain = newCanvas();
  plain.surfaces.push({ id: "d", kind: "data", title: "W", x: 0, y: 0, w: 400, h: 300, name: "w.csv", params: surfaceParams("data", words), table: words });
  const scatter = instantiate(find("data.scatter")!, contextOf(plain));
  assert.ok("error" in scatter && /numeric column/.test(scatter.error));
});

await test("searching the library finds by name and tags, best first", () => {
  assert.equal(searchLibrary(BUILTINS, "crop")[0]!.id, "photo.crop");
  assert.ok(searchLibrary(BUILTINS, "drum beat").some((r) => r.id === "music.drums"));
  assert.ok(searchLibrary(BUILTINS, "slippery").some((r) => r.id === "game.physics"));
  assert.ok(searchLibrary(BUILTINS, "chart", "data").every((r) => r.domain === "data"));
});

// -------------------------------------------------------------- the canvas --

await test("a surface brings its starters beside it, on the person's side, never on top of anything", () => {
  const c = newCanvas();
  const made = addSurfaceTo(c, { kind: "image", name: "sunset.jpg", artifact: "file_0000000000000000", px: { w: 1600, h: 1000 } }, find);
  assert.ok(!("error" in made));
  if ("error" in made) return;
  assert.equal(made.surface.h, 320, "as tall as the picture's shape");
  assert.deepEqual(made.panels.map((p) => `${p.recipe}:${p.state}`), ["photo.light:live", "photo.colour:live", "photo.looks:ghost"]);
  assert.equal(c.focus, made.surface.id);
  const boxes = [made.surface, ...made.panels].map((b) => ({ ...b, h: b.h || canvasLib.estimateHeight((b as { tree?: never }).tree ?? { atom: "stack" }, b.w) }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!; const b = boxes[j]!;
    assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), `${i} and ${j} overlap`);
  }
  assert.ok(made.panels.filter((p) => p.state === "live").every((p) => p.x >= made.surface.x + made.surface.w), "to the right");
  const left = newCanvas();
  const sl = addSurfaceTo(left, { kind: "image", name: "a.jpg" }, find, { side: "left" });
  if (!("error" in sl)) assert.ok(sl.panels[0]!.x < sl.surface.x, "or the side they like");
  const t = addSurfaceTo(newCanvas(), { kind: "data", name: "sales.csv", table }, find);
  if (!("error" in t)) assert.deepEqual(t.panels.map((p) => p.recipe), ["data.line", "data.filter-category", "data.explore"]);
  assert.deepEqual(starters({ id: "x", kind: "data", title: "", x: 0, y: 0, w: 1, h: 1, name: "", params: {}, table: tableFrom([["a", "b"], ["x", "y"]])! }).live, []);
});

await test("moving to other work dims the old work's panels; moving on again puts them away; one click brings one back", () => {
  const c = withSurfaces();
  c.focus = "img1";
  const light = placeRecipe(c, find("photo.light")!, { near: "img1", why: "x", by: "agent" });
  const pinned = placeRecipe(c, find("photo.colour")!, { near: "img1", why: "x", by: "agent" });
  const chart = placeRecipe(c, find("data.bar")!, { near: "dat1", why: "x", by: "agent" });
  assert.ok(!("error" in light) && !("error" in pinned) && !("error" in chart));
  if ("error" in light || "error" in pinned || "error" in chart) return;
  pinned.pinned = true;
  assert.deepEqual(refocus(c, "dat1"), { dimmed: 1, gone: 0, back: 0 });
  assert.equal(c.panels.find((p) => p.id === light.id)!.state, "dim");
  assert.equal(c.panels.find((p) => p.id === pinned.id)!.state, "live", "pinned stays");
  refocus(c, "img1");
  assert.equal(c.panels.find((p) => p.id === light.id)!.state, "live", "back to it: it wakes");
  refocus(c, "dat1");
  refocus(c, null);
  assert.ok(!c.panels.some((p) => p.id === light.id), "the work moved on twice: it went");
  assert.ok(c.gone.some((p) => p.id === light.id));
  assert.ok(restore(c, light.id));
  assert.equal(c.panels.find((p) => p.id === light.id)!.state, "live");
});

await test("values are checked against what they are, and clamped to a parameter's range", () => {
  const c = withSurfaces();
  assert.equal(valueProblem(c, "@img1.exposure", "bright"), "@img1.exposure is number");
  assert.match(valueProblem(c, "@img1.look", "sepia")!, /one of none, warm/);
  assert.equal(valueProblem(c, "@img1.exposure", 1), null);
  setValue(c, "@img1.exposure", 9);
  assert.equal(valueAt(c, "@img1.exposure"), 3);
  setValue(c, "budget", 1200);
  assert.equal(valueAt(c, "budget"), 1200);
  placeRecipe(c, find("general.budget")!, { why: "x", by: "agent" });
  assert.match(valueProblem(c, "budget", "lots")!, /holds number/);
});

await test("the canvas reads back repaired: broken panels dropped, numbers snapped, unknown surfaces refused", () => {
  const c = withSurfaces();
  const p = placeRecipe(c, find("photo.light")!, { why: "x", by: "agent" });
  assert.ok(!("error" in p));
  const raw = JSON.parse(JSON.stringify(c));
  raw.panels.push({ id: "bad", tree: { atom: "wobble" } }, { id: "p" + "x", tree: { atom: "label", props: { text: "hi" } }, x: 13, y: 7, w: 5 });
  raw.surfaces.push({ id: "z", kind: "video" });
  const back = normalizeCanvas(raw)!;
  assert.equal(back.surfaces.length, c.surfaces.length, "every real surface kept, the unknown kind refused");
  assert.ok(!back.panels.some((x) => x.id === "bad"));
  const label = back.panels.find((x) => x.id === "px")!;
  assert.deepEqual([label.x, label.y, label.w], [16, 0, 176]);
  assert.match(describeCanvas(back), /surface img1: image "Photo"/);
});

await test("placement finds free room beside the anchor, and falls back to the middle of the view", () => {
  const c = withSurfaces();
  const a = placeFor(c, 288, 200, "img1");
  assert.equal(a.x, 512 + 32);
  c.panels.push({ id: "blk", title: "", tree: { atom: "stack", children: [] }, x: a.x, y: a.y, w: 288, h: 320, state: "live", context: "img1", why: "", by: "agent", at: 0 });
  const b = placeFor(c, 288, 200, "img1");
  assert.notDeepEqual(b, a);
  const empty = newCanvas();
  assert.deepEqual(placeFor(empty, 200, 100, null, "right", { x: 0, y: 0, w: 1000, h: 600 }), { x: 400, y: 144 });
});

// ------------------------------------------------------------ local rules --

await test("telling values offer the next panel, once, and never one waved away twice", () => {
  const c = withSurfaces();
  const none = () => false;
  assert.equal(suggestFor(c, "@img1.exposure", 1.6, none)!.recipe, "photo.histogram");
  assert.equal(suggestFor(c, "@img1.exposure", 0.4, none), null);
  assert.equal(suggestFor(c, "@img1.saturation", -100, none)!.recipe, "photo.mono");
  assert.equal(suggestFor(c, "@dat1.filter.Region", ["EU"], none)!.recipe, "data.top");
  assert.equal(suggestFor(c, "@dat1.filter.Region", ["EU"], (id) => id === "data.top"), null);
  placeRecipe(c, find("data.top")!, { near: "dat1", why: "x", by: "agent" });
  assert.equal(suggestFor(c, "@dat1.filter.Region", ["EU"], none), null, "already there");
  assert.equal(suggestFor(c, "budget", 3, none), null);
});

// ------------------------------------------------------------ the profile --

await test("Panacea learns: controls come out from behind More, waved panels go quiet, density follows skill", () => {
  const p = profileLib.newProfile();
  assert.equal(profileLib.revealed(p, "@img9.clarity"), false);
  for (let i = 0; i < 3; i++) profileLib.noteUse(p, profileLib.usageKey("@img1.clarity"));
  assert.equal(profileLib.revealed(p, "@img9.clarity"), true, "learned by name, on any photo");
  profileLib.noteDismiss(p, "photo.looks");
  assert.equal(profileLib.quieted(p, "photo.looks"), false);
  profileLib.noteDismiss(p, "photo.looks");
  assert.equal(profileLib.quieted(p, "photo.looks"), true);
  assert.equal(profileLib.densityOf(p), "calm");
  for (const a of ["whites", "blacks", "clarity", "fade", "vignette", "grain", "zoom"]) for (let i = 0; i < 3; i++) profileLib.noteUse(p, `param:${a}`);
  assert.equal(profileLib.densityOf(p), "dense");
  for (let i = 0; i < 3; i++) profileLib.noteSide(p, "below");
  assert.equal(profileLib.preferredSide(p), "below");
  assert.equal(profileLib.sideOf({ x: 600, y: 0, w: 100 }, { x: 0, y: 0, w: 500, h: 300 }), "right");
  assert.match(profileLib.profileWords(p)!, /has waved away photo.looks/);
  assert.deepEqual(profileLib.normalizeProfile({ uses: { a: -1, b: 2, c: "x" } }).uses, { b: 2 });
});

// -------------------------------------------------------------- the hand --

await test("the hand's steps go from the canvas as it is to the canvas as the call leaves it", () => {
  const before = withSurfaces();
  const light = placeRecipe(before, find("photo.light")!, { near: "img1", why: "x", by: "agent" });
  if ("error" in light) throw new Error(light.error);
  const after = structuredClone(before);
  setValue(after, "@img1.exposure", 0.5);
  setValue(after, "@img1.grain", 20);
  const placed = placeRecipe(after, find("photo.colour")!, { near: "img1", why: "x", by: "agent" });
  if ("error" in placed) throw new Error(placed.error);
  after.panels.find((p) => p.id === light.id)!.x += 64;
  const plan = panaceaSteps(before, after);
  assert.deepEqual(plan.steps.map((s) => s.op).sort(), ["move", "place", "set"]);
  assert.equal(plan.steps.find((s) => s.op === "set")!.op === "set" && (plan.steps.find((s) => s.op === "set") as { key: string }).key, "@img1.exposure");
  assert.equal(plan.skipped, 1, "grain has no control on screen");
});

// --------------------------------------------------------------- the tools --

const S = "panaceatest";
const run = (name: string, args: Record<string, unknown>) => panacea.runPanaceaTool(S, name, args, { cwd: dir });
const art = path.join(dir, "sales.csv");
fs.writeFileSync(art, CSV);

const app = express();
const sent: Array<Record<string, unknown>> = [];
panacea.panaceaRoutes(app, { exists: (id) => id === S || id === "panaceainc", incognito: (id) => id === "panaceainc", off: () => false, push: (_id, m) => { sent.push(m); } });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown, raw?: Buffer, type = "application/json"): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + url, { method, headers: { "content-type": raw ? type : "application/json" }, body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

await test("the tools are a family of their own, read-only where they only look, and switch off with the window", () => {
  assert.deepEqual(panaceaSPECS.map((s) => s.name), ["panacea_open", "panacea_look", "panacea_surface", "panacea_place", "panacea_set", "panacea_arrange", "panacea_bespoke", "panacea_doc", "panacea_export"]);
  assert.ok(loadedFamilies({ events: [], said: "open the panacea canvas", hasPdf: false, lazy: true }).has("panacea"));
  assert.equal(looksOnly("panacea_look", {}), true);
  assert.equal(looksOnly("panacea_open", {}), true);
  assert.equal(looksOnly("panacea_open", { new: "x" }), false);
  assert.equal(looksOnly("panacea_place", {}), false);
  assert.equal(windowOff("panacea_look", { ...toolSettings(), panacea: { enabled: false } }), true);
  assert.equal(windowOff("panacea_look"), false);
  assert.equal(manualId("panacea_place"), "panacea");
  assert.match(manualText("panacea"), /panacea_bespoke/);
});

await test("opening it from a tool opens the window, and shows the library's index", async () => {
  const out = await run("panacea_open", {});
  assert.ok(out.ok);
  assert.equal(panacea.panaceaState(S).open, true);
  assert.match(out.summary, /general.budget/);
});

await test("panacea_surface adds a table from a file, with its starters, and says what opened", async () => {
  const out = await run("panacea_surface", { file: art });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /Added data surface dat\w+ \(5 rows; Month date, Region text, Revenue number, Units number\)/);
  assert.match(out.summary, /Line chart/);
  const bad = await run("panacea_surface", { csv: "just words" });
  assert.equal(bad.ok, false);
});

await test("panacea_place: a recipe, a composed tree (kept for the hand), a refusal with the reason, and a why is required", async () => {
  const noWhy = await run("panacea_place", { recipe: "general.budget" });
  assert.equal(noWhy.ok, false);
  assert.match(noWhy.summary, /Say `why`/);
  const r = await run("panacea_place", { recipe: "general.budget", why: "To set the budget.", values: { budget: 900 } });
  assert.ok(r.ok, r.summary);
  const look = await run("panacea_look", {});
  assert.match(look.summary, /budget=900/);
  const composed = await run("panacea_place", { title: "Shoot", why: "Plan it.", tree: { atom: "stack", children: [{ atom: "segmented", bind: "shoot", props: { options: ["Dawn", "Dusk"] } }] } });
  assert.ok(composed.ok, composed.summary);
  const lib = await call("GET", "/api/panacea/library");
  assert.ok(!lib.body.recipes.some((x: { name: string }) => x.name === "Shoot"), "not in the library until the person uses it");
  const refused = await run("panacea_place", { title: "X", why: "y", tree: { atom: "slider", bind: "@nowhere.zoom" } });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /no surface "nowhere"/);
});

await test("panacea_set checks each value; panacea_arrange moves, puts away (not pinned ones), restores, groups and refocuses", async () => {
  const c = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  const dat = c.surfaces[0].id;
  const set = await run("panacea_set", { values: { [`@${dat}.filter.Region`]: ["EU"], budget: "lots" } });
  assert.ok(set.ok);
  assert.match(set.summary, /Not set: budget: budget is shown by a control that holds number/);
  const ids: string[] = c.panels.filter((p: { state: string }) => p.state === "live").map((p: { id: string }) => p.id);
  const moved = await run("panacea_arrange", { move: [{ id: ids[0], x: 1000, y: 1000 }], group: ids.slice(0, 2), remove: [ids[1]] });
  assert.ok(moved.ok, moved.summary);
  const after = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  const first = after.panels.find((p: { id: string }) => p.id === ids[0]);
  assert.deepEqual([first.x, first.y], [1008, 1008], "snapped to the grid");
  assert.ok(first.group && after.panels.find((p: { id: string }) => p.id === ids[0]).group === first.group);
  assert.ok(after.gone.some((p: { id: string }) => p.id === ids[1]));
  const back = await run("panacea_arrange", { restore: [ids[1]] });
  assert.match(back.summary, /brought back/);
  const unknown = await run("panacea_arrange", { remove: ["nope"] });
  assert.equal(unknown.ok, false);
});

await test("a panel's words are the person's: set and place refuse them until it says Autora writes, and the person can take it back", async () => {
  const map = { atom: "row", children: ["who", "what", "where", "when"].map((k) => ({ atom: "list", bind: `map.${k}`, props: { label: k } })) };
  const placed = await run("panacea_place", { title: "Story map", why: "To gather who, what, where and when.", tree: map, values: { "map.who": ["Mara"] } });
  assert.ok(placed.ok, placed.summary);
  assert.match(placed.summary, /Values not set: map\.who: the words in "Story map" \(\w+\) are the person's to write/);
  const id = /panel (\w+) "Story map"/.exec(placed.summary)![1]!;
  const refused = await run("panacea_set", { values: { "map.what": ["A heist"] } });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /person's to write.*panacea_arrange writes/);
  assert.match((await run("panacea_look", {})).summary, /"Story map".*its words are the person's/);
  assert.ok((await run("panacea_set", { values: { budget: 800 } })).ok, "other values are still the agent's to set");

  const let_ = await run("panacea_arrange", { writes: { [id]: "agent" } });
  assert.ok(let_.ok, let_.summary);
  assert.ok((await run("panacea_set", { values: { "map.what": ["A heist"] } })).ok);
  assert.match((await run("panacea_look", {})).summary, /"Story map".*you may write in it/);
  assert.ok((await run("panacea_arrange", { writes: { [id]: "person" } })).ok);
  assert.equal((await run("panacea_set", { values: { "map.when": ["1920"] } })).ok, false, "given back, refused again");

  const todo = await run("panacea_place", { recipe: "general.todo", why: "The packing list you asked for.", writes: "agent", values: { todo: ["Passport"] } });
  assert.ok(todo.ok && !/Values not set/.test(todo.summary), todo.summary);
  assert.equal((await run("panacea_arrange", { writes: { [id]: "maybe" } })).ok, false);
  const doc = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  assert.equal(doc.panels.find((p: { title: string }) => p.title === "To do").writes, "agent", "kept on the canvas");
});

await test("a person's save is refused when the agent changed the canvas since; a fresh one is taken", async () => {
  const got = (await call("GET", `/api/panacea/${S}/doc`)).body;
  await run("panacea_set", { values: { budget: 1000 } });
  const stale = await call("PUT", `/api/panacea/${S}/doc`, { doc: got.doc, rev: got.rev });
  assert.equal(stale.status, 409);
  const fresh = (await call("GET", `/api/panacea/${S}/doc`)).body;
  fresh.doc.name = "Renamed";
  assert.equal((await call("PUT", `/api/panacea/${S}/doc`, { doc: fresh.doc, rev: fresh.rev })).status, 200);
  assert.equal(panacea.panaceaState(S).name, "Renamed");
  assert.equal((await call("PUT", `/api/panacea/${S}/doc`, { doc: { nope: 1 }, rev: Date.now() * 2 })).status, 400);
});

await test("a composed panel joins the library when the person uses it, deduped by shape; a builtin's use is counted", async () => {
  const doc = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  const shoot = doc.panels.find((p: { title: string }) => p.title === "Shoot");
  const used = await call("POST", `/api/panacea/${S}/use`, { panel: shoot });
  assert.match(used.body.recipe, /^made\./);
  const again = await call("POST", `/api/panacea/${S}/use`, { panel: { ...shoot, id: "other", title: "Shoot two" } });
  assert.equal(again.body.recipe, used.body.recipe, "same shape, same recipe");
  const lib = (await call("GET", "/api/panacea/library")).body.recipes;
  const made = lib.find((r: { id: string }) => r.id === used.body.recipe);
  assert.equal(made.uses, 2);
  const budget = doc.panels.find((p: { recipe: string }) => p.recipe === "general.budget");
  assert.equal((await call("POST", `/api/panacea/${S}/use`, { panel: budget })).body.recipe, "general.budget");
  assert.equal((await call("GET", "/api/panacea/profile")).body.profile.uses["recipe:general.budget"], 1);
  assert.equal((await call("PATCH", `/api/panacea/library/${used.body.recipe}`, { name: "Shoot plan" })).body.recipe.name, "Shoot plan");
  assert.equal((await call("DELETE", "/api/panacea/library/photo.light")).status, 404, "the built-ins stay");
});

await test("activity is told to the next turn and teaches the profile; a telling value comes back with an offer", async () => {
  const doc = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  const dat = doc.surfaces[0].id;
  await run("panacea_set", { values: { [`@${dat}.filter.Region`]: ["US"] } });
  const offered = await call("POST", `/api/panacea/${S}/activity`, { text: "set Region", bind: `@${dat}.filter.Region`, value: ["US"] });
  assert.equal(offered.body.offer?.recipe, "data.top");
  await call("POST", `/api/panacea/${S}/activity`, { kind: "dismiss", recipe: "data.top", text: "waved away Top rows" });
  assert.equal((await call("GET", "/api/panacea/profile")).body.profile.dismissed["data.top"], 1);
  assert.match(panacea.panaceaTurnNote(S)!, /What the person did on it lately: .*waved away Top rows/);
  assert.match(panacea.panaceaTurnNote(S)!, /The Panacea window is open/);
});

await test("bespoke pieces: drafted dashed, revised, kept into the library; refused when not a page", async () => {
  const bad = await run("panacea_bespoke", { action: "draft", title: "Wheel", why: "Brand wheel.", html: "" });
  assert.equal(bad.ok, false);
  const d = await run("panacea_bespoke", { action: "draft", title: "Wheel", why: "Their brand colours on a wheel.", html: "<div id=w></div><script>parent.postMessage({type:'panacea:set',key:'hue',value:'#ff0000'},'*')</script>", binds: ["hue"], height: 200 });
  assert.ok(d.ok, d.summary);
  const doc = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  const draft = doc.panels.find((p: { state: string }) => p.state === "draft");
  assert.equal(draft.tree.atom, "bespoke");
  assert.ok((await run("panacea_bespoke", { action: "revise", id: draft.id, height: 260 })).ok);
  const kept = await run("panacea_bespoke", { action: "keep", id: draft.id });
  assert.match(kept.summary, /in the library as bespoke\./);
  const lib = (await call("GET", "/api/panacea/library")).body.recipes;
  assert.ok(lib.some((r: { origin: string; name: string }) => r.origin === "bespoke" && r.name === "Wheel"));
});

await test("export: a table's filtered rows as CSV in the project; a dropped file is read and kept", async () => {
  const doc = (await call("GET", `/api/panacea/${S}/doc`)).body.doc;
  const out = await run("panacea_export", { surface: doc.surfaces[0].id });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /\(2 rows, as filtered\)/);
  const imp = await call("POST", `/api/panacea/${S}/import?name=more.csv`, undefined, Buffer.from(CSV), "text/csv");
  assert.equal(imp.body.kind, "data");
  assert.equal(imp.body.table.rows.length, 5);
  const pic = Buffer.from("89504e470d0a1a0a0000000d4948445200000280000001e00806000000", "hex");
  const img = await call("POST", `/api/panacea/${S}/import?name=p.png`, undefined, Buffer.concat([pic, Buffer.alloc(20)]), "image/png");
  assert.deepEqual(img.body.px, { w: 640, h: 480 });
  assert.equal((await call("POST", `/api/panacea/${S}/import?name=x.exe`, undefined, Buffer.from("MZ"), "application/octet-stream")).status, 415);
  const csv = await call("POST", `/api/panacea/${S}/deliver?name=rows`, undefined, Buffer.from("a,b\n1,2\n"), "text/csv");
  assert.equal(csv.body.name, "rows.csv");
});

await test("an incognito chat has no canvas; a chat closed lets go of its canvas", async () => {
  assert.equal((await call("POST", "/api/panacea/panaceainc/open")).status, 409);
  panacea.dropPanacea(S);
  assert.equal(fs.existsSync(path.join(dir, `panacea-${S}.json`)), false);
});

await test("an xlsx's first sheet reads as a table", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const xlsx = Buffer.from(zipSync({
    "xl/sharedStrings.xml": strToU8('<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Ada</t></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>9.5</v></c></row></sheetData></worksheet>'),
  }));
  const t = panacea.readTable("s.xlsx", xlsx)!;
  assert.deepEqual(t.columns, [{ name: "Name", type: "text" }, { name: "Score", type: "number" }]);
  assert.deepEqual(t.rows, [["Ada", 9.5]]);
});

// ---------------------------------------------------------------- documents --

/** The document surface on this chat's canvas, as the server holds it. */
const docOf = async () => ((await call("GET", `/api/panacea/${S}/doc`)).body.doc.surfaces as Array<{ id: string; kind: string; doc?: { mode: string; json: unknown }; params: Record<string, unknown> }>).find((x) => x.kind === "doc")!;
const blockIds = async () => {
  const d = await docOf();
  const { blocksOf } = await import("../src/lib/panacea/document");
  return blocksOf(stateOf(d.doc as never).doc);
};
const { stateOf } = await import("../src/lib/panacea/document");

await test("panacea_surface makes a document from Markdown: the person's to write, with its starters beside it", async () => {
  panacea.dropPanacea(S);
  const out = await run("panacea_surface", { document: "# Minutes\n\nWe met.\n\n- agreed\n- agreed again", title: "Minutes" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /document surface doc\w+ "Minutes"/);
  assert.match(out.summary, /person's to write/);
  assert.match(out.summary, /Text style/);
  const d = await docOf();
  assert.equal(d.doc!.mode, "guide");
  assert.equal(d.params.words, 6);
  assert.equal(d.params.block, "h1", "the caret starts in the first block");
});

await test("panacea_look doc reads the outline and every block with its id", async () => {
  const out = await run("panacea_look", { doc: "" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /Outline:\n\[b\w+\] Minutes/);
  assert.match(out.summary, /h1 "Minutes"/);
  assert.match(out.summary, /bullet "agreed"/);
  assert.match(out.summary, /the person writes it/);
});

await test("in guide the agent formats and structures but may not write; refusals change nothing", async () => {
  const [title, , first] = await blockIds();
  const fmt = await run("panacea_doc", { ops: [{ op: "format", id: title!.id, set: { align: "center" } }, { op: "format", id: first!.id, set: { bold: true } }, { op: "style", set: { font: "Georgia", size: 12 } }] });
  assert.ok(fmt.ok, fmt.summary);
  assert.match(fmt.summary, /Blocks now/);
  const d = await docOf();
  assert.equal(d.params.font, "Georgia");
  assert.equal(d.params.size, 12);
  const before = JSON.stringify(d.doc);
  for (const op of [{ op: "insert", markdown: "Sneaky." }, { op: "replace", id: title!.id, text: "Mine" }, { op: "delete", id: first!.id }]) {
    const refused = await run("panacea_doc", { ops: [{ op: "format", id: title!.id, set: { align: "left" } }, op] });
    assert.equal(refused.ok, false);
    assert.match(refused.summary, /theirs to write/);
  }
  assert.equal(JSON.stringify((await docOf()).doc), before, "a refused call is all-or-nothing: even its allowed first op was undone");
});

await test("switching a document to Autora lets it write, every op checked, ids returned for the next", async () => {
  const [title] = await blockIds();
  const w = await run("panacea_doc", { ops: [
    { op: "mode", mode: "agent" },
    { op: "insert", after: title!.id, markdown: "## Decisions\n\nShip on Friday." },
    { op: "format", id: title!.id, set: { align: "left" } },
  ] });
  assert.ok(w.ok, w.summary);
  assert.match(w.summary, /switched the document to Autora writing/);
  assert.match(w.summary, /\[b\w+\] h2 "Decisions"/);
  const ids = await blockIds();
  assert.deepEqual(ids.map((b) => b.kind).slice(0, 4), ["h1", "h2", "p", "p"]);
  const decisions = ids.find((b) => b.text === "Decisions")!;
  const rewrite = await run("panacea_doc", { ops: [{ op: "replace", id: decisions.id, text: "Decided" }, { op: "delete", id: ids.find((b) => b.text === "agreed again")!.id }] });
  assert.ok(rewrite.ok, rewrite.summary);
  assert.ok((await blockIds()).some((b) => b.text === "Decided") && !(await blockIds()).some((b) => b.text === "agreed again"));
  const bad = await run("panacea_doc", { ops: [{ op: "replace", id: "nope", text: "x" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /no block nope/);
  assert.equal((await run("panacea_doc", { ops: [] })).ok, false);
  assert.equal((await run("panacea_doc", { ops: [{ op: "dance" }] })).ok, false);
  assert.equal((await run("panacea_doc", { surface: "nothing", ops: [{ op: "mode", mode: "guide" }] })).ok, false);
});

await test("panacea_set on a document parameter applies it to the selection; a read-only one is refused", async () => {
  const d = await docOf();
  const before = d.params.bold;
  const set = await run("panacea_set", { values: { [`@${d.id}.bold`]: !before } });
  assert.ok(set.ok, set.summary);
  assert.equal((await docOf()).params.bold, !before, "read back off the selection");
  const ro = await run("panacea_set", { values: { [`@${d.id}.words`]: 5 } });
  assert.equal(ro.ok, false);
  assert.match(ro.summary, /worked out/);
});

await test("a document is exported as Markdown; a dropped .md or a .txt that is not a table opens as a document, a table .txt stays a table", async () => {
  const d = await docOf();
  const out = await run("panacea_export", { surface: d.id });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /as Markdown/);
  const md = await call("POST", `/api/panacea/${S}/import?name=notes.md`, undefined, Buffer.from("# Notes\n\nHello **there**."), "text/markdown");
  assert.equal(md.body.kind, "doc");
  assert.ok(stateOf(md.body.doc).doc.textContent.includes("Hello there."));
  const prose = await call("POST", `/api/panacea/${S}/import?name=letter.txt`, undefined, Buffer.from("Dear friend,\n\nThanks."), "text/plain");
  assert.equal(prose.body.kind, "doc");
  const grid = await call("POST", `/api/panacea/${S}/import?name=grid.txt`, undefined, Buffer.from("a\tb\n1\t2\n"), "text/plain");
  assert.equal(grid.body.kind, "data", "a text file that reads as a table is still a table");
  const huge = await call("POST", `/api/panacea/${S}/import?name=big.md`, undefined, Buffer.alloc(700_000, 97), "text/markdown");
  assert.equal(huge.status, 413);
});

await test("a document survives the canvas going to disk and back", async () => {
  const d = await docOf();
  const doc = (await call("GET", `/api/panacea/${S}/doc`)).body;
  const back = normalizeCanvas(JSON.parse(JSON.stringify(doc.doc)))!;
  const again = back.surfaces.find((x) => x.id === d.id)!;
  assert.equal(again.doc!.mode, "agent");
  assert.equal(again.params.words, d.params.words);
  assert.match(describeCanvas(back), /document "Minutes", \d+ words in \d+ blocks; Autora may write in it/);
});

server.close();
console.log(`\n${passed} passed`);
process.exit(0);
