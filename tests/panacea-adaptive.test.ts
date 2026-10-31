/** The local adaptive engine is pure: no model, browser, filesystem or editor builds. */
import assert from "node:assert/strict";
import type { Value } from "../src/lib/panacea/atoms";
import { rankRecipes, signalsFor } from "../src/lib/panacea/adaptive";
import { newCanvas, setValue, surfaceParams, wordsOwner, type Surface } from "../src/lib/panacea/canvas";
import { addCard, createBoard } from "../src/lib/panacea/board";
import { createDoc } from "../src/lib/panacea/document";
import { matchesValue, matchesWhen } from "../src/lib/panacea/intent";
import { KINDS } from "../src/lib/panacea/kinds";
import { assembleRecipe, BUILTINS, instantiate, type Recipe } from "../src/lib/panacea/library";
import { cooling, densityOf, newProfile, normalizeProfile, noteDismiss, noteUse, quieted, revealed, skillOf, usesFor } from "../src/lib/panacea/profile";
import { checkTree, fingerprint, generalize, readRecipePart, type RecipePart } from "../src/lib/panacea/recipe";
import { placeRecipe, suggestFor } from "../src/lib/panacea/rules";
import { splitDelimited, tableFrom } from "../src/lib/panacea/surfaces";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const find = (id: string) => BUILTINS.find((r) => r.id === id)!;
const table = tableFrom(splitDelimited("Region,Sales\nEU,4\nUS,6\n"))!;
const meta = { id: "composed.test", name: "My inspector", domain: "photo" as const, about: "Controls I chose", tags: ["inspector"], w: 320 };

function canvas() {
  const c = newCanvas();
  const surfaces: Surface[] = [
    { id: "img1", kind: "image", title: "Photo", name: "photo.jpg", x: 0, y: 0, w: 512, h: 320, params: surfaceParams("image", null) },
    { id: "dat1", kind: "data", title: "Sales", name: "sales.csv", x: 0, y: 500, w: 576, h: 352, params: surfaceParams("data", table), table },
    { id: "doc1", kind: "doc", title: "Notes", name: "notes.md", x: 0, y: 1000, w: 640, h: 592, params: surfaceParams("doc", null), doc: createDoc("The person's words.") },
    { id: "brd1", kind: "board", title: "Ideas", name: "ideas", x: 0, y: 1700, w: 832, h: 560, params: surfaceParams("board", null), board: createBoard() },
  ];
  for (const surface of surfaces) KINDS[surface.kind].settle?.(surface);
  c.surfaces = surfaces;
  c.focus = "img1";
  return c;
}

test("all existing value reflexes work through recipe data and the compatible registry API", () => {
  const c = canvas();
  const reflexes: Array<[string, Value, string]> = [
    ["@img1.exposure", 1.6, "photo.histogram"],
    ["@img1.saturation", -100, "photo.mono"],
    ["@img1.aspect", "square", "photo.straighten"],
    ["@img1.look", "warm", "photo.compare"],
    ["@dat1.filter.Region", ["EU"], "data.top"],
    ["@dat1.search", "EU", "data.table"],
    ["@doc1.align", "center", "document.paragraph"],
  ];
  for (const [key, value, recipe] of reflexes) {
    assert.equal(suggestFor(c, key, value, () => false)?.recipe, recipe);
  }
  assert.equal(suggestFor(c, "@img1.exposure", 0.4, () => false), null);
  assert.equal(suggestFor(c, "budget", 2, () => false), null);
  const image = c.surfaces[0]!;
  assert.equal(KINDS.image.suggest(image, "exposure", 2, { has: () => false, offer: (recipe, why) => ({ recipe, why }) })?.recipe, "photo.histogram");
});

test("selection and focus are registry signals, not photo-only branches", () => {
  const c = canvas();
  c.focus = "doc1";
  const doc = c.surfaces[2]!;
  doc.doc!.sel = { anchor: 1, head: 5 };
  const before = JSON.stringify(c);
  assert.equal(signalsFor(c, doc).selection, "range");
  assert.equal(rankRecipes(c, BUILTINS)[0]?.recipe.id, "document.paragraph");
  assert.equal(JSON.stringify(c), before, "ranking must not write words, move cards or change the selection");
  c.focus = "img1";
  assert.equal(rankRecipes(c, BUILTINS, { surface: "doc1" }).length, 0, "a background selection does not interrupt the focused work");
  c.focus = "brd1";
  const board = c.surfaces[3]!;
  const added = addCard(board.board!, { text: "My idea", by: "person" });
  if (typeof added === "string") assert.fail(added);
  added.board.sel = added.card.id;
  board.board = added.board;
  assert.equal(rankRecipes(c, BUILTINS)[0]?.recipe.id, "general.board");
});

test("wildcard value signals follow the changed parameter, not a different old filter", () => {
  const c = canvas();
  c.surfaces[1]!.params["filter.Region"] = ["EU"];
  assert.equal(suggestFor(c, "@dat1.filter.Other", [], () => false), null);
  assert.equal(matchesValue(Number.NaN, { op: "abs-gte", value: 1 }), false);
  assert.equal(matchesValue(" ", { op: "nonempty" }), false);
  assert.equal(matchesValue(undefined, { op: "not", values: ["none"] }), false);
  assert.equal(matchesWhen({ kind: "image", weight: 8, why: "Empty", all: [] }, signalsFor(c, c.surfaces[0]!)), false);
});

test("profile use changes ordering only after there is contextual evidence; ties are deterministic", () => {
  const c = canvas();
  setValue(c, "@img1.exposure", 2);
  setValue(c, "@img1.saturation", -100);
  assert.equal(rankRecipes(c, BUILTINS)[0]?.recipe.id, "photo.histogram");
  const profile = newProfile();
  for (let i = 0; i < 8; i++) noteUse(profile, "recipe:photo.mono", 1, "image");
  for (let i = 0; i < 100; i++) noteUse(profile, "recipe:photo.crop", 1, "image");
  assert.equal(rankRecipes(c, BUILTINS, { profile })[0]?.recipe.id, "photo.mono");
  assert.ok(!rankRecipes(c, BUILTINS, { profile }).some((r) => r.recipe.id === "photo.crop"), "familiarity alone is not intent");
  assert.deepEqual(rankRecipes(c, BUILTINS, { profile }).map((r) => r.recipe.id), rankRecipes(c, [...BUILTINS].reverse(), { profile }).map((r) => r.recipe.id));
  assert.ok(rankRecipes(c, BUILTINS, { profile })[0]!.evidence.some((e) => e.signal === "use"));
});

test("dismissals survive JSON and respect cooldown, soft preference, and permanent quiet", () => {
  const c = canvas();
  setValue(c, "@img1.exposure", 2);
  const p = newProfile();
  const now = 1_800_000_000_000;
  noteDismiss(p, "photo.histogram", now);
  const back = normalizeProfile(JSON.parse(JSON.stringify(p)));
  assert.equal(back.dismissedAt?.["photo.histogram"], now);
  assert.equal(quieted(back, "photo.histogram"), false, "the original two-refusal API is unchanged");
  assert.equal(cooling(back, "photo.histogram", now + 1), true);
  assert.equal(rankRecipes(c, BUILTINS, { profile: back, now: now + 1 }).length, 0);
  const later = rankRecipes(c, BUILTINS, { profile: back, now: now + 600_001 });
  assert.equal(later[0]?.recipe.id, "photo.histogram");
  assert.ok(later[0]!.evidence.some((e) => e.signal === "dismissal"));
  noteDismiss(back, "photo.histogram", now + 600_001);
  assert.equal(rankRecipes(c, BUILTINS, { profile: back, now: now + 9_000_000 }).length, 0);
});

test("quiet fingerprints, duplicate shapes, existing panels and the one-ghost limit are hard constraints", () => {
  const c = canvas();
  setValue(c, "@img1.exposure", 2);
  assert.equal(rankRecipes(c, BUILTINS, { quiet: (id) => id === fingerprint(find("photo.histogram").tree) }).length, 0);
  const histogram = placeRecipe(c, find("photo.histogram"), { near: "img1", by: "person", why: "Mine" });
  assert.ok(!("error" in histogram));
  const duplicate: Recipe = { ...find("photo.histogram"), id: "photo.other-histogram" };
  assert.equal(rankRecipes(c, [...BUILTINS, duplicate]).length, 0);
  const another = canvas();
  setValue(another, "@img1.exposure", 2);
  placeRecipe(another, find("photo.looks"), { near: "img1", by: "rule", state: "ghost", why: "Try it?" });
  assert.equal(rankRecipes(another, BUILTINS).length, 0);
});

test("next edges require a used live source, stay one hop, and do not move touched or pinned controls", () => {
  const c = canvas();
  const panel = placeRecipe(c, find("photo.histogram"), { near: "img1", by: "person", why: "Mine" });
  if ("error" in panel) assert.fail(panel.error);
  assert.equal(rankRecipes(c, BUILTINS).length, 0);
  panel.touched = 123;
  panel.pinned = true;
  const before = JSON.stringify(c);
  assert.equal(rankRecipes(c, BUILTINS)[0]?.recipe.id, "photo.curve");
  assert.equal(JSON.stringify(c), before);
  panel.state = "dim";
  assert.equal(rankRecipes(c, BUILTINS).length, 0);
});

test("incompatible recipe binds never reach the offer list", () => {
  const c = canvas();
  const invalid: Recipe = { ...find("photo.histogram"), id: "photo.invalid", tree: { atom: "toggle", bind: "@image.exposure" } };
  setValue(c, "@img1.exposure", 2);
  assert.equal(rankRecipes(c, [invalid]).length, 0);
});

test("skill, revelation and density are per kind while old unscoped profiles remain compatible", () => {
  const p = newProfile();
  for (const key of ["sort", "descending", "search"]) noteUse(p, `param:${key}`, 3, "data");
  assert.equal(densityOf(p, "data"), "dense");
  assert.equal(densityOf(p, "image"), "calm");
  assert.equal(densityOf(p), "dense", "old callers can see a data-only person's familiarity");
  assert.equal(revealed(p, "@dat9.search", "data"), true);
  assert.equal(skillOf(p, "image"), 0);
  assert.equal(usesFor(normalizeProfile(JSON.parse(JSON.stringify(p))), "param:sort", "data"), 3);
  noteUse(p, "param:sort", 10, "image");
  assert.equal(usesFor(p, "param:sort", "data"), 3, "another engine cannot inflate this engine's scoped count");
  const legacy = newProfile();
  for (const key of ["whites", "blacks", "clarity", "fade", "vignette", "grain", "zoom"]) noteUse(legacy, `param:${key}`, 3);
  assert.equal(densityOf(legacy), "dense");
  assert.equal(revealed(legacy, "@img9.clarity"), true);
  const filtering = newProfile();
  for (let i = 0; i < 10; i++) noteUse(filtering, `param:filter.Column${i}`, 3, "data");
  assert.equal(densityOf(filtering, "data"), "dense", "declared dynamic column filters count too");
  assert.equal(densityOf(filtering, "image"), "calm");
});

test("nested recipe assembly resolves binds, validates the combined eight-control budget and keeps shape identity", () => {
  const c = canvas();
  const ctx = { surfaces: c.surfaces, near: { image: "img1" } };
  const part: RecipePart = { atom: "group", props: { label: "My inspector" }, children: [
    { recipe: "photo.light" }, { atom: "stack", children: [{ recipe: "photo.colour" }] },
  ] };
  const made = assembleRecipe(part, BUILTINS, ctx, meta);
  if ("error" in made) assert.fail(made.error);
  assert.equal(checkTree(made.tree, ctx).controls, 8);
  assert.equal(made.fp, fingerprint(made.tree));
  assert.equal(made.fp, fingerprint(generalize(made.tree, { img1: "image" })));
  assert.equal(made.origin, "composed");
  assert.ok(!("error" in placeRecipe(c, made, { near: "img1", by: "person", why: "My chosen controls" })));
  const loud: RecipePart = { atom: "stack", children: [{ recipe: "photo.light" }, { recipe: "photo.colour" }, { recipe: "photo.detail" }] };
  const refused = assembleRecipe(loud, BUILTINS, ctx, meta);
  assert.ok("error" in refused && /at most 8/.test(refused.error));
  const calm = assembleRecipe({ atom: "stack", children: [...loud.children.slice(0, 2), { recipe: "photo.detail", advanced: true }] }, BUILTINS, ctx, meta);
  assert.ok(!("error" in calm));
});

test("assembly rejects unknown parts, conflicting defaults, excessive depth and executable props", () => {
  const ctx = { surfaces: canvas().surfaces };
  assert.ok("error" in assembleRecipe({ recipe: "missing" }, BUILTINS, ctx, meta));
  const a = { ...find("general.budget"), id: "a", values: { budget: 3 } };
  const b = { ...a, id: "b", values: { budget: 4 } };
  const conflict = assembleRecipe({ atom: "row", children: [{ recipe: "a" }, { recipe: "b" }] }, [a, b], ctx, meta);
  assert.ok("error" in conflict && /Conflicting defaults/.test(conflict.error));
  let deep: RecipePart = { recipe: "photo.histogram" };
  for (let i = 0; i < 8; i++) deep = { atom: "stack", children: [deep] };
  assert.ok("error" in assembleRecipe(deep, BUILTINS, ctx, meta));
  assert.ok("error" in assembleRecipe({ atom: "group", props: { onclick: "doSomething()" }, children: [{ recipe: "photo.detail" }] }, BUILTINS, ctx, meta));
});

test("composition wire reader is explicit, bounded and distinguishes shared references from cycles", () => {
  const leaf = { recipe: "photo.detail" };
  assert.ok("part" in readRecipePart({ atom: "row", children: [leaf, leaf] }));
  assert.ok("error" in readRecipePart({ recipe: "photo.detail", atom: "stack" }));
  assert.ok("error" in readRecipePart({ recipe: "photo.detail", advanced: "yes" }));
  assert.ok("error" in readRecipePart({ atom: "text", children: [leaf] }));
  const cycle: { atom: string; children: unknown[] } = { atom: "stack", children: [] };
  cycle.children.push(cycle);
  const refused = readRecipePart(cycle);
  assert.ok("error" in refused && /cyclic/.test(refused.error));
  assert.ok("error" in readRecipePart({ atom: "stack", children: Array.from({ length: 33 }, () => leaf) }));
});

test("a used composed recipe learns contextual relevance without a second storage or rendering format", () => {
  const c = canvas();
  const recipe = assembleRecipe({ atom: "group", children: [{ recipe: "photo.detail" }] }, BUILTINS, { surfaces: c.surfaces }, meta);
  if ("error" in recipe) assert.fail(recipe.error);
  assert.ok(!("error" in instantiate(recipe, { surfaces: c.surfaces })));
  assert.equal(rankRecipes(c, [recipe], { change: { param: "clarity", value: 20 } }).length, 0);
  recipe.uses = 1;
  assert.equal(rankRecipes(c, [recipe], { change: { param: "clarity", value: 20 } })[0]?.recipe.id, recipe.id);
  const p = newProfile();
  noteUse(p, "param:clarity", 3, "image");
  assert.equal(rankRecipes(c, [recipe], { profile: p })[0]?.recipe.id, recipe.id);
});

test("adaptive panels preserve creative ownership; assembly never overwrites shared values", () => {
  const c = canvas();
  const recipe = assembleRecipe({ atom: "group", children: [{ recipe: "general.notes" }] }, BUILTINS, { surfaces: c.surfaces }, { ...meta, domain: "general" });
  if ("error" in recipe) assert.fail(recipe.error);
  const panel = placeRecipe(c, recipe, { by: "rule", state: "ghost", why: "Only if useful" });
  if ("error" in panel) assert.fail(panel.error);
  const bind = panel.tree.children?.[0]?.children?.find((n) => n.bind)?.bind;
  assert.ok(bind);
  assert.equal(wordsOwner(c, bind!), panel, "the ordinary panel authority guard still owns the words");
  assert.equal(panel.writes, undefined);
  const budget = { ...find("general.budget"), values: { budget: 100 } };
  c.values.budget = 500;
  placeRecipe(c, budget, { by: "person", why: "My budget" });
  assert.equal(c.values.budget, 500);
});

console.log(`\n${passed} Panacea adaptive tests passed.`);
