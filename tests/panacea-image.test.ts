/**
 * Panacea's image engine: selections as pixels (every tool's shape, add / subtract / intersect, grow, feather, invert,
 * the magic wand and colour range on real pixels, Remove's fill), the photo's model (layers, layer masks, local
 * adjustments), every command the person and the agent share, the geometry between the picture as shown and the photo,
 * and the controls a command's result brings to the canvas.
 *
 *   npx tsx tests/panacea-image.test.ts
 */
import assert from "node:assert/strict";
import { checkTree } from "../src/lib/panacea/recipe";
import { contextOf, newCanvas, normalizeCanvas, surfaceParams, valueProblem, describeCanvas } from "../src/lib/panacea/canvas";
import { BUILTINS } from "../src/lib/panacea/library";
import { runCommand } from "../src/lib/panacea/rules";
import { coverage, heal, maskBounds, maskEdge, rasterize, type Pixels } from "../src/lib/panacea/mask";
import {
  IMAGE_COMMANDS, MAX_MASKS, TOOLS, imageWords, newImageDoc, normalizeImageDoc, runImageCommand, selectionOf, shapeBounds, toOutput, toSource,
  type ImageTarget, type Selection,
} from "../src/lib/panacea/image";
import { commandsOf, engineWords, findParam, paramsOf } from "../src/lib/panacea/surfaces";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const sel = (ops: Selection["ops"], extra: Partial<Selection> = {}): Selection => ({ ops, feather: 0, grow: 0, invert: false, ...extra });
const near = (a: number, b: number, d = 0.02) => assert.ok(Math.abs(a - b) <= d, `${a} is about ${b}`);

/** 100x100: the left half dark blue, the right half orange, and a white square in the top left that touches nothing. */
function picture(): Pixels {
  const w = 100; const h = 100;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const square = x >= 10 && x < 20 && y >= 10 && y < 20;
    const [r, g, b] = square ? [255, 255, 255] : x < 50 ? [20, 30, 120] : [240, 140, 30];
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { w, h, data };
}

function target(): ImageTarget {
  const image = newImageDoc();
  return { image, params: surfaceParams({ kind: "image", image }), px: { w: 400, h: 300 } };
}

// ------------------------------------------------------------- rasterizing --

await test("every drawn shape fills what it covers: a box, an ellipse, a lasso, a brush stroke, all", () => {
  near(coverage(rasterize(sel([{ op: "add", shape: { type: "rect", x: 0, y: 0, w: 0.5, h: 0.5 } }]), 100, 100)), 0.25);
  near(coverage(rasterize(sel([{ op: "add", shape: { type: "ellipse", x: 0, y: 0, w: 1, h: 1 } }]), 200, 200)), Math.PI / 4);
  near(coverage(rasterize(sel([{ op: "add", shape: { type: "polygon", points: [0, 0, 1, 0, 0, 1] } }]), 200, 200)), 0.5);
  const line = rasterize(sel([{ op: "add", shape: { type: "stroke", points: [0, 0.5, 1, 0.5], size: 0.1, hardness: 1 } }]), 100, 100);
  near(coverage(line), 0.1, 0.02);
  assert.equal(coverage(rasterize(sel([{ op: "add", shape: { type: "all" } }]), 10, 10)), 1);
});

await test("shapes combine: add joins, subtract takes away, intersect keeps the overlap; invert, grow and feather act on the whole", () => {
  const a = { type: "rect" as const, x: 0, y: 0, w: 0.5, h: 1 };
  const b = { type: "rect" as const, x: 0.25, y: 0, w: 0.5, h: 1 };
  near(coverage(rasterize(sel([{ op: "add", shape: a }, { op: "add", shape: b }]), 100, 100)), 0.75);
  near(coverage(rasterize(sel([{ op: "add", shape: a }, { op: "subtract", shape: b }]), 100, 100)), 0.25);
  near(coverage(rasterize(sel([{ op: "add", shape: a }, { op: "intersect", shape: b }]), 100, 100)), 0.25);
  near(coverage(rasterize(sel([{ op: "add", shape: a }], { invert: true }), 100, 100)), 0.5);
  near(coverage(rasterize(sel([{ op: "add", shape: { type: "rect", x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }], { grow: 10 }), 100, 100)), 0.16);
  near(coverage(rasterize(sel([{ op: "add", shape: { type: "rect", x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }], { grow: -5 }), 100, 100)), 0.01);
  const soft = rasterize(sel([{ op: "add", shape: a }], { feather: 12 }), 100, 100);
  assert.ok(soft[50 * 100 + 50]! > 0 && soft[50 * 100 + 50]! < 255, "the edge is soft");
  assert.equal(soft[50 * 100 + 5], 255, "well inside is selected");
  // A feather is in the photo's pixels: at half size it is half as many.
  const half = rasterize(sel([{ op: "add", shape: a }], { feather: 12 }), 50, 50, null, undefined, 0.5);
  assert.ok(half[25 * 50 + 25]! > 0 && half[25 * 50 + 25]! < 255);
});

await test("the magic wand takes the colour clicked and what touches it, or that colour anywhere; colour range takes every pixel like it", () => {
  const px = picture();
  const blue = rasterize(sel([{ op: "add", shape: { type: "wand", x: 0.3, y: 0.6, tolerance: 10, contiguous: true } }]), 100, 100, px);
  near(coverage(blue), 0.49, 0.005);
  assert.equal(blue[15 * 100 + 15], 0, "the white square is not the blue");
  const white = rasterize(sel([{ op: "add", shape: { type: "wand", x: 0.15, y: 0.15, tolerance: 10, contiguous: true } }]), 100, 100, px);
  near(coverage(white), 0.01, 0.001);
  const orange = rasterize(sel([{ op: "add", shape: { type: "color", color: "#f08c1e", range: 10 } }]), 100, 100, px);
  near(coverage(orange), 0.5, 0.01);
  assert.equal(coverage(rasterize(sel([{ op: "add", shape: { type: "wand", x: 0.3, y: 0.6, tolerance: 10, contiguous: true } }]), 100, 100, null)), 0, "no pixels, no wand");
});

await test("an object the model found is its mask; the box around a mask and its edge are found", () => {
  const m = new Uint8Array(100 * 100);
  for (let y = 20; y < 40; y++) for (let x = 30; x < 70; x++) m[y * 100 + x] = 255;
  const got = rasterize(sel([{ op: "add", shape: { type: "object", x: 0.5, y: 0.3, mask: "abc" } }]), 100, 100, null, (id, w, h) => (id === "abc" && w === 100 && h === 100 ? m : null));
  near(coverage(got), 0.08, 0.001);
  assert.deepEqual(maskBounds(got, 100, 100), { x: 0.3, y: 0.2, w: 0.4, h: 0.2 });
  const edge = maskEdge(got, 100, 100);
  assert.equal(edge.reduce((a, v) => a + v, 0), 2 * 40 + 2 * 18, "the edge is the outline only");
});

await test("Remove fills what is selected from around it, and leaves the rest alone", () => {
  const px = picture();
  const m = new Uint8Array(100 * 100);
  for (let y = 8; y < 22; y++) for (let x = 8; x < 22; x++) m[y * 100 + x] = 255;
  const before = px.data[(80 * 100 + 80) * 4];
  heal(px, m);
  const i = (15 * 100 + 15) * 4;
  assert.ok(px.data[i]! < 80 && px.data[i + 2]! > 80, `the white square became the blue around it (${px.data[i]},${px.data[i + 1]},${px.data[i + 2]})`);
  assert.equal(px.data[(80 * 100 + 80) * 4], before, "far away is untouched");
});

// ------------------------------------------------------------- the model --

await test("selecting by command: each shape, the tool's mode, feather, grow, invert and none", () => {
  const t = target();
  assert.ok(runImageCommand(t, "select.rect", { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }).ok);
  assert.equal(t.image.selection.length, 1);
  assert.ok(runImageCommand(t, "select.ellipse", { x: 0.5, y: 0.5, w: 0.2, h: 0.2, mode: "add" }).ok);
  assert.equal(t.image.selection.length, 2);
  t.params["tool.mode"] = "subtract";
  assert.ok(runImageCommand(t, "select.polygon", { points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }).ok);
  assert.equal(t.image.selection.at(-1)!.op, "subtract");
  assert.ok(runImageCommand(t, "select.rect", { x: 0, y: 0, w: 1, h: 1, mode: "new" }).ok);
  assert.equal(t.image.selection.length, 1, "new replaces it");
  runImageCommand(t, "select.feather", { px: 30 });
  runImageCommand(t, "select.grow", { px: -4 });
  runImageCommand(t, "select.invert");
  const s = selectionOf(t.image, t.params)!;
  assert.deepEqual([s.feather, s.grow, s.invert], [30, -4, true]);
  assert.match(imageWords(t.image, t.params), /Selection: rect 0\.000,0\.000,1\.000,1\.000; feather 30px; shrunk 4px; inverted/);
  runImageCommand(t, "select.none");
  assert.equal(selectionOf(t.image, t.params), null);
  const bad = runImageCommand(t, "select.polygon", { points: [[0, 0]] });
  assert.ok(!bad.ok && /three points/.test(bad.error));
  const needs = runImageCommand(t, "layer.erase");
  assert.ok(!needs.ok && /nothing is selected/.test(needs.error), "a command that needs a selection says so");
  const model = runImageCommand(t, "select.object", { x: 0.5, y: 0.5 });
  assert.ok(!model.ok && model.window, "finding an object needs the window");
});

await test("layers: copy and cut the selection, fill it, delete it from a layer, remove it, text, paint, a placed picture; order and delete", () => {
  const t = target();
  runImageCommand(t, "select.rect", { x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
  const cut = runImageCommand(t, "layer.cut");
  assert.ok(cut.ok && cut.layer);
  assert.equal(t.image.layers.length, 2);
  assert.equal(t.image.layers[1]!.kind, "copy");
  assert.equal(t.image.layers[0]!.mask!.at(-1)!.op, "subtract", "the photo has a hole where it was cut");
  assert.equal(t.image.selection.length, 0, "the selection goes with it");
  assert.equal(t.image.active, cut.layer);
  runImageCommand(t, "select.all");
  const fill = runImageCommand(t, "layer.fill", { color: "#336699" });
  assert.ok(fill.ok);
  assert.equal(t.params[`layer.${fill.layer}.color`], "#336699");
  runImageCommand(t, "select.rect", { x: 0, y: 0, w: 0.1, h: 0.1 });
  runImageCommand(t, "layer.erase");
  assert.equal(t.image.layers.find((l) => l.id === fill.layer)!.mask!.at(-1)!.op, "subtract", "Delete takes it out of the active layer");
  runImageCommand(t, "select.ellipse", { x: 0.7, y: 0.7, w: 0.05, h: 0.05 });
  const heal = runImageCommand(t, "layer.remove");
  assert.ok(heal.ok && t.image.layers.at(-1)!.kind === "heal");
  runImageCommand(t, "select.ellipse", { x: 0.1, y: 0.7, w: 0.05, h: 0.05 });
  runImageCommand(t, "layer.remove");
  assert.equal(t.image.layers.filter((l) => l.kind === "heal").length, 1, "a second removal joins the heal layer on top");
  const text = runImageCommand(t, "layer.text", { text: "Hello", size: 12, color: "#ff0000" });
  assert.ok(text.ok);
  assert.equal(t.params[`layer.${text.layer}.text`], "Hello");
  const paint = runImageCommand(t, "layer.paint", { points: [[0.1, 0.1], [0.5, 0.5]], size: 2 });
  assert.ok(paint.ok);
  const p = t.image.layers.find((l) => l.id === paint.layer)!;
  assert.equal(p.kind, "paint");
  runImageCommand(t, "layer.paint", { points: [[0.2, 0.1], [0.5, 0.6]] });
  assert.equal(p.strokes!.length, 2, "a second stroke goes on the same paint layer");
  const placed = runImageCommand(t, "layer.place", { artifact: "file_abc" });
  assert.ok(placed.ok && t.image.layers.find((l) => l.id === placed.layer)!.artifact === "file_abc");
  assert.ok(!runImageCommand(t, "layer.delete", { id: "photo" }).ok, "the photo stays");
  const blocked = runImageCommand(t, "layer.delete", { id: "photo" });
  assert.ok(!blocked.ok);
  assert.ok(runImageCommand(t, "layer.down", { id: placed.layer }).ok);
  assert.ok(runImageCommand(t, "layer.delete", { id: text.layer }).ok);
  assert.equal(t.params[`layer.${text.layer}.text`], undefined, "its values go with it");
  assert.ok(!runImageCommand(t, "layer.up", { id: "photo" }).ok);
  assert.match(imageWords(t.image, t.params), /photo "Photo"/);
});

await test("a local adjustment keeps the selection with sliders of its own; at most six", () => {
  const t = target();
  runImageCommand(t, "select.rect", { x: 0, y: 0, w: 1, h: 0.4 });
  const r = runImageCommand(t, "mask.add", { name: "Sky", exposure: -0.6, saturation: 20 });
  assert.ok(r.ok && r.mask);
  assert.equal(t.image.masks[0]!.name, "Sky");
  assert.equal(t.params[`mask.${r.mask}.exposure`], -0.6);
  assert.ok(findParam({ kind: "image", image: t.image }, `mask.${r.mask}.clarity`), "its sliders are parameters");
  runImageCommand(t, "select.rect", { x: 0, y: 0, w: 0.5, h: 0.5, mode: "add" });
  assert.equal(t.image.masks[0]!.sel.ops.length, 1, "the kept selection does not follow later edits");
  for (let i = 1; i < MAX_MASKS; i++) assert.ok(runImageCommand(t, "mask.add").ok);
  assert.ok(!runImageCommand(t, "mask.add").ok);
  assert.ok(runImageCommand(t, "mask.delete", { id: r.mask }).ok);
  assert.equal(t.params[`mask.${r.mask}.exposure`], undefined);
});

await test("the picture as shown and the photo: a point maps there and back through crop, rotation and flips", () => {
  const params = { ...surfaceParams({ kind: "image" }), rotate: "90", flip_h: true, straighten: 7, crop: [0.1, 0.2, 0.5, 0.6] };
  for (const [x, y] of [[0.2, 0.3], [0.9, 0.1], [0.5, 0.5]]) {
    const [sx, sy] = toSource(params, { w: 400, h: 300 }, x!, y!);
    const [ox, oy] = toOutput(params, { w: 400, h: 300 }, sx, sy);
    near(ox, x!, 1e-6);
    near(oy, y!, 1e-6);
  }
  const plain = surfaceParams({ kind: "image" });
  assert.deepEqual(toSource(plain, { w: 400, h: 300 }, 0.25, 0.75).map((v) => Math.round(v * 1000) / 1000), [0.25, 0.75]);
});

await test("crop to a box, to the selection (from its shapes, or the window's pixels), and back", () => {
  const t = target();
  runImageCommand(t, "image.crop", { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  assert.deepEqual(t.params.crop, [0.1, 0.1, 0.5, 0.5]);
  runImageCommand(t, "image.uncrop");
  runImageCommand(t, "select.rect", { x: 0.2, y: 0.3, w: 0.4, h: 0.2 });
  const b = shapeBounds(selectionOf(t.image, t.params)!)!;
  [b.x, b.y, b.w, b.h].forEach((v, i) => near(v, [0.2, 0.3, 0.4, 0.2][i]!, 1e-9));
  assert.ok(runImageCommand(t, "image.crop_selection").ok);
  (t.params.crop as number[]).forEach((v, i) => near(v, [0.2, 0.3, 0.4, 0.2][i]!, 1e-4));
  runImageCommand(t, "select.wand", { x: 0.5, y: 0.5 });
  const no = runImageCommand(t, "image.crop_selection");
  assert.ok(!no.ok && no.window, "a wand's bounds need the pixels");
  assert.ok(runImageCommand(t, "image.crop_selection", {}, { bounds: () => ({ x: 0, y: 0, w: 0.5, h: 0.5 }) }).ok);
});

await test("the engine's map: every command has a group and its arguments, every tool a key; the agent's index lists them", () => {
  assert.ok(IMAGE_COMMANDS.length >= 35);
  assert.equal(new Set(IMAGE_COMMANDS.map((c) => c.name)).size, IMAGE_COMMANDS.length);
  for (const c of IMAGE_COMMANDS) assert.ok(c.group && c.label && c.about, c.name);
  assert.equal(new Set(TOOLS.map((t) => t.key)).size, TOOLS.length, "no two tools share a key");
  const words = engineWords({ kind: "image" });
  for (const name of ["select.wand", "select.object", "layer.cut", "mask.add", "image.crop_selection", "lasso"]) assert.ok(words.includes(name), name);
  assert.deepEqual(commandsOf({ kind: "data" }).map((c) => c.name), ["export", "clear"]);
  assert.ok(paramsOf({ kind: "image" }).some((p) => p.name === "hsl.blue.sat"));
});

await test("a model read back from anywhere is repaired: bad shapes dropped, copies of lost layers gone, the photo always first", () => {
  const doc = normalizeImageDoc({
    layers: [{ id: "x1", kind: "copy", of: "gone", name: "Lost" }, { id: "photo", kind: "photo" }, { id: "t1", kind: "text", name: "T" }, { id: "t1", kind: "text" }, { id: "b", kind: "nope" }],
    active: "zzz",
    masks: [{ id: "m1", name: "Sky", sel: { ops: [{ op: "add", shape: { type: "rect", x: 0, y: 0, w: 1, h: 0.5 } }] } }, { id: "m2", sel: { ops: [{ shape: { type: "bad" } }] } }],
    selection: [{ op: "add", shape: { type: "polygon", points: [0, 0, 1, 0, 1, 1] } }, { op: "add", shape: { type: "polygon", points: [1] } }],
  });
  assert.deepEqual(doc.layers.map((l) => l.id), ["photo", "t1"]);
  assert.equal(doc.active, "t1");
  assert.deepEqual(doc.masks.map((m) => m.id), ["m1"]);
  assert.equal(doc.selection.length, 1);
  assert.deepEqual(normalizeImageDoc(null), newImageDoc());
});

// ------------------------------------------------------------- the canvas --

const find = (id: string) => BUILTINS.find((r) => r.id === id);

await test("on the canvas: a selection brings the Selection panel and deselecting puts it away; an adjustment brings its sliders; text its words; layers the Layers panel", () => {
  const c = newCanvas();
  const image = newImageDoc();
  c.surfaces.push({ id: "img1", kind: "image", title: "Photo", x: 0, y: 0, w: 512, h: 384, name: "p.jpg", params: surfaceParams({ kind: "image", image }), image, px: { w: 400, h: 300 } });
  const r1 = runCommand(c, "img1", "select.rect", { x: 0, y: 0, w: 1, h: 0.4 }, find, { by: "person" });
  assert.ok(r1.ok && r1.panels?.length === 1);
  assert.equal(c.panels[0]!.recipe, "photo.selection");
  const r2 = runCommand(c, "img1", "mask.add", { name: "Sky" }, find, { by: "person" });
  assert.ok(r2.ok);
  const sky = c.panels.find((p) => p.title === "Sky")!;
  assert.ok(sky, "the adjustment's own panel is on the canvas");
  assert.ok(checkTree(sky.tree, contextOf(c)).controls <= 8, "and it is calm");
  runCommand(c, "img1", "select.none", {}, find, { by: "person" });
  assert.ok(!c.panels.some((p) => p.recipe === "photo.selection"), "deselected: the Selection panel went");
  assert.ok(c.gone.some((p) => p.recipe === "photo.selection"), "and can be brought back");
  const r3 = runCommand(c, "img1", "layer.text", { text: "Hi" }, find, { by: "agent" });
  assert.ok(r3.ok);
  assert.ok(c.panels.some((p) => p.title === "Text: Hi"));
  assert.ok(c.panels.some((p) => p.recipe === "photo.layers"));
  runCommand(c, "img1", "mask.delete", { id: r2.mask }, find, { by: "person" });
  assert.ok(!c.panels.some((p) => p.title === "Sky"), "the adjustment's panel goes with it");
  assert.ok(valueProblem(c, `@img1.layer.${r3.layer}.font`, "serif") === null);
  assert.ok(valueProblem(c, `@img1.layer.${r3.layer}.font`, "comic") !== null);
  assert.match(describeCanvas(c), /Layers, top first: l\w+ text "Hi"/);
  const back = normalizeCanvas(JSON.parse(JSON.stringify(c)))!;
  assert.deepEqual(back.surfaces[0]!.image, c.surfaces[0]!.image, "the model survives a save");
  const reset = runCommand(c, "img1", "reset", {}, find, { by: "person" });
  assert.ok(reset.ok);
  assert.equal(c.surfaces[0]!.image!.layers.length, 2, "reset leaves the layers");
});

await test("panels drive the engine: a command button with its args, a tool picked by a button, the tools palette; wrong args are refused", () => {
  const c = newCanvas();
  const image = newImageDoc();
  c.surfaces.push({ id: "img1", kind: "image", title: "Photo", x: 0, y: 0, w: 512, h: 384, name: "p.jpg", params: surfaceParams({ kind: "image", image }), image });
  const ctx = contextOf(c);
  const ok = checkTree({ atom: "stack", children: [
    { atom: "tools", bind: "@image.tool" },
    { atom: "button", props: { label: "Wand", action: "set:@image.tool=\"wand\"" } },
    { atom: "button", props: { label: "Top", action: "@image.select.rect", args: { x: 0, y: 0, w: 1, h: 0.5 } } },
    { atom: "layers", props: { surface: "@image" } },
  ] }, ctx);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.tree!.children![1]!.props!.action, "set:@img1.tool=\"wand\"");
  const bad = checkTree({ atom: "stack", children: [
    { atom: "button", props: { label: "x", action: "@image.select.rect", args: { x: 0 } } },
    { atom: "button", props: { label: "y", action: "@image.select.rect", args: { x: 0, y: 0, w: 1, h: 1, colour: 1 } } },
    { atom: "button", props: { label: "z", action: "set:@image.tool=\"spray\"" } },
  ] }, ctx);
  assert.match(bad.errors.join(" "), /needs y, w, h/);
  assert.match(bad.errors.join(" "), /takes no argument "colour"/);
  assert.match(bad.errors.join(" "), /cannot be "spray"/);
  for (const id of ["photo.tools", "photo.selection", "photo.layers", "photo.brush", "photo.remove", "photo.object", "photo.mix", "photo.grade", "photo.sharpen", "photo.text"]) assert.ok(find(id), id);
});

console.log(`panacea-image: ${passed} passed`);
