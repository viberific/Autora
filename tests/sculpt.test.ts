/**
 * Autora 3D's organic forms: sculpt_blend, sculpt_loft and sculpt_smooth make mesh shapes from numbers.
 * Needs the modeller's engine built (`npm --prefix autora-3d run build:engine`).
 *
 *   npx tsx tests/sculpt.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blendMesh, loftMesh, mirrored, smoothMesh, subdivide } from "../autora-3d/src/utils/organic";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-sculpt-"));

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

type Mesh = { positions: number[]; indices: number[] };
const volume = (m: Mesh) => {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
};
const range = (m: Mesh, axis: number) => {
  const v = m.positions.filter((_, i) => i % 3 === axis);
  return [Math.min(...v), Math.max(...v)];
};

await test("a sphere blends to a closed outward-facing ball of about the right volume", () => {
  const m = blendMesh([{ kind: "sphere", a: { x: 10, y: 20, z: 30 }, radius: 25 }], { smooth: 0, detail: 40 });
  const expected = (4 / 3) * Math.PI * 25 ** 3;
  assert.ok(Math.abs(volume(m) - expected) / expected < 0.06, `volume ${volume(m)} vs ${expected}`);
  const [lo, hi] = range(m, 0);
  assert.ok(Math.abs(lo - -15) < 1.5 && Math.abs(hi - 35) < 1.5, `${lo}..${hi}`);
});

await test("two overlapping parts become one joined surface, softer with smooth", () => {
  const parts = [
    { kind: "sphere" as const, a: { x: 0, y: 0, z: 0 }, radius: 20 },
    { kind: "capsule" as const, a: { x: 15, y: 0, z: 0 }, b: { x: 80, y: 0, z: 0 }, radius: 12, radius2: 6 },
  ];
  const sharp = blendMesh(parts, { smooth: 0, detail: 60 });
  const soft = blendMesh(parts, { smooth: 15, detail: 60 });
  assert.ok(volume(soft) > volume(sharp), "a soft join fills the crease");
  assert.ok(range(sharp, 0)[1] > 80 && range(sharp, 0)[1] < 90);
});

await test("an ellipsoid has its three half-sizes", () => {
  const m = blendMesh([{ kind: "ellipsoid", a: { x: 0, y: 0, z: 0 }, radii: { x: 40, y: 10, z: 20 } }], { smooth: 0, detail: 60 });
  const size = [0, 1, 2].map((a) => range(m, a)[1] - range(m, a)[0]);
  assert.ok(Math.abs(size[0] - 80) < 4 && Math.abs(size[1] - 20) < 2 && Math.abs(size[2] - 40) < 3, size.join(", "));
});

await test("a loft's caps face out of the tube, not into it", () => {
  // The whole-mesh volume check cannot catch this: one cap inverted still leaves the volume
  // positive, so the tube renders with a hole-like end. Check each cap face's own direction.
  const m = loftMesh([
    { at: { x: 0, y: 0, z: 0 }, radius: 20 },
    { at: { x: 0, y: 0, z: 60 }, radius: 20 },
  ], { sides: 12, steps: 2 });
  const idx = m.indices;
  const p = m.positions;
  const bottom = p.length / 3 - 2;
  const top = p.length / 3 - 1;
  let ok = 0;
  let bad = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    const a = tri[0] * 3;
    const b = tri[1] * 3;
    const c = tri[2] * 3;
    const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (tri.includes(bottom)) {
      if (nz < 0) ok++;
      else bad++;
    }
    if (tri.includes(top)) {
      if (nz > 0) ok++;
      else bad++;
    }
  }
  assert.equal(bad, 0, `${bad} of ${ok + bad} cap faces point into the tube`);
});

await test("a loft is a closed tube that follows its sections", () => {
  const m = loftMesh([
    { at: { x: 0, y: 0, z: 0 }, radius: 10 },
    { at: { x: 50, y: 0, z: 10 }, radius: 6, radius2: 12 },
    { at: { x: 100, y: 0, z: 0 }, radius: 3 },
  ], { sides: 16, steps: 4 });
  assert.ok(volume(m) > 0, "faces point outward");
  const [lo, hi] = range(m, 0);
  assert.ok(lo > -5 && hi > 99 && hi < 104, `${lo}..${hi}`);
  assert.throws(() => loftMesh([{ at: { x: 0, y: 0, z: 0 }, radius: 1 }], { sides: 8, steps: 1 }), /two sections/);
});

await test("smoothing evens out a lumpy surface without shrinking it much; subdivide quadruples triangles", () => {
  const ball = blendMesh([{ kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 30 }], { smooth: 0, detail: 30 });
  const fine = subdivide(ball);
  assert.equal(fine.indices.length, ball.indices.length * 4);
  const lumpy = { ...ball, positions: ball.positions.map((n, i) => n + ((i * 7919) % 13 - 6) * 0.2) };
  const smoothed = smoothMesh(lumpy, 3, 0.5);
  assert.ok(Math.abs(volume(smoothed) - volume(ball)) / volume(ball) < 0.08);
  const rough = (m: Mesh) => { const r = Array.from({ length: m.positions.length / 3 }, (_, i) => Math.hypot(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2])); const mean = r.reduce((s, x) => s + x) / r.length; return Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / r.length); };
  assert.ok(rough(smoothed) < rough(lumpy), `${rough(smoothed)} < ${rough(lumpy)}`);
});

// ------------------------------------------------------------------ the engine --

if (!fs.existsSync(new URL("../dist/autora-3d-engine/engine.mjs", import.meta.url))) {
  console.log("  skip  the 3D engine is not built (npm --prefix autora-3d run build:engine)");
  process.exit(0);
}
await test("a carved part takes its shape out of the form", () => {
  const whole = blendMesh([{ kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 30 }], { smooth: 0, detail: 48 });
  const bitten = blendMesh([
    { kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 30 },
    { kind: "sphere", a: { x: 30, y: 0, z: 0 }, radius: 15, carve: true },
  ], { smooth: 0, detail: 48 });
  // The bite is the part of the small ball inside the big one: a lens of about 0.42 x (4/3)pi 15^3.
  const lost = volume(whole) - volume(bitten);
  const lens = 0.42 * (4 / 3) * Math.PI * 15 ** 3;
  assert.ok(Math.abs(lost - lens) / lens < 0.25, `lost ${lost} vs ${lens}`);
  // Nothing of the surface is left inside the bite (bar the cut face itself, which lies on its edge).
  for (let i = 0; i < bitten.positions.length; i += 3) {
    const d = Math.hypot(bitten.positions[i] - 30, bitten.positions[i + 1], bitten.positions[i + 2]);
    assert.ok(d > 13.5, `a point ${d.toFixed(1)} mm from the bite's centre`);
  }
  assert.throws(() => blendMesh([{ kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 5, carve: true }], { smooth: 0, detail: 16 }), /at least one that adds/);
  // Parts apply in order: a ball added after the carve sits in the hole (an eyeball in its socket).
  const eye = blendMesh([
    { kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 30 },
    { kind: "sphere", a: { x: 30, y: 0, z: 0 }, radius: 15, carve: true },
    { kind: "sphere", a: { x: 24, y: 0, z: 0 }, radius: 6 },
  ], { smooth: 0, detail: 64 });
  let inSocket = 0;
  for (let i = 0; i < eye.positions.length; i += 3) if (Math.hypot(eye.positions[i] - 24, eye.positions[i + 1], eye.positions[i + 2]) < 7) inSocket++;
  assert.ok(inSocket > 10, `the eyeball is there: ${inSocket} points on it`);
});

await test("a box part has its size, rounds its corners, and turns", () => {
  const box = blendMesh([{ kind: "box", a: { x: 0, y: 0, z: 0 }, radii: { x: 20, y: 10, z: 5 } }], { smooth: 0, detail: 80 });
  const exact = 40 * 20 * 10;
  assert.ok(Math.abs(volume(box) - exact) / exact < 0.08, `volume ${volume(box)} vs ${exact}`);
  const round = blendMesh([{ kind: "box", a: { x: 0, y: 0, z: 0 }, radii: { x: 20, y: 10, z: 5 }, round: 4 }], { smooth: 0, detail: 80 });
  assert.ok(volume(round) < volume(box) * 0.97, "rounded corners take some away");
  const turned = blendMesh([{ kind: "box", a: { x: 0, y: 0, z: 0 }, radii: { x: 20, y: 5, z: 5 }, turn: { x: 0, y: 0, z: 90 } }], { smooth: 0, detail: 80 });
  const [xlo, xhi] = range(turned, 0);
  const [ylo, yhi] = range(turned, 1);
  assert.ok(xhi - xlo < 12 && yhi - ylo > 36, `turned a quarter about z: x ${xlo}..${xhi}, y ${ylo}..${yhi}`);
});

await test("a part's own smooth sets how softly it joins: a crisp lid beside soft cheeks", () => {
  const two = (smooth?: number) => blendMesh([
    { kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 20 },
    { kind: "sphere", a: { x: 26, y: 0, z: 0 }, radius: 10, ...(smooth === undefined ? {} : { smooth }) },
  ], { smooth: 10, detail: 64 });
  // A soft join fills the waist between the two with more than a crisp one does.
  assert.ok(volume(two()) > volume(two(0)) * 1.02, `${volume(two())} vs ${volume(two(0))}`);
});

await test("a mirror reflects a turned part's turn, so a tilted pair stays a pair", () => {
  const [, right] = mirrored([{ kind: "ellipsoid", a: { x: 10, y: 0, z: 0 }, radii: { x: 5, y: 2, z: 2 }, turn: { x: 10, y: 20, z: 30 } }], "x", 0);
  assert.deepEqual(right.turn, { x: 10, y: -20, z: -30 });
  assert.equal(right.a.x, -10);
});

await test("parts with a colour paint the surface where they are; the rest takes the shape's colour", () => {
  const m = blendMesh([
    { kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 20 },
    { kind: "sphere", a: { x: 30, y: 0, z: 0 }, radius: 12, color: "#ff0000" },
  ], { smooth: 6, detail: 48 });
  assert.ok(m.colors && m.colors.length === m.positions.length, "one colour per point");
  let red = 0;
  let own = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i];
    if (x > 32) { assert.deepEqual(m.colors.slice(i, i + 3), [1, 0, 0], `point at x ${x} is on the red part`); red++; }
    if (x < -5) { assert.equal(m.colors[i], -1, `point at x ${x} is the shape's own colour`); own++; }
  }
  assert.ok(red > 5 && own > 5);
  assert.equal(blendMesh([{ kind: "sphere", a: { x: 0, y: 0, z: 0 }, radius: 5 }], { smooth: 0, detail: 16 }).colors, undefined, "no paint, no colours");
  const finer = subdivide(m);
  assert.equal(finer.colors!.length, finer.positions.length, "subdividing carries the paint");
});

await test("a grid too big for the parts is made coarser and says so, rather than taking minutes", () => {
  const many = Array.from({ length: 90 }, (_, i) => ({ kind: "sphere" as const, a: { x: (i % 10) * 30, y: Math.floor(i / 10) * 30, z: 0 }, radius: 14 }));
  const t = Date.now();
  const m = blendMesh(many, { smooth: 4, detail: 256 });
  assert.ok(m.detail < 256, `made at ${m.detail}`);
  assert.ok(Date.now() - t < 20_000, `${Date.now() - t} ms`);
});

const core = await import(new URL("../dist/autora-3d-engine/engine.mjs", import.meta.url).href);
await core.initManifold();

await test("sculpt_blend with a mirror makes one mesh shape that stands where it was described", async () => {
  const e = new core.Engine(core.emptyDoc());
  const r = await e.execute("sculpt_blend", {
    name: "Horse",
    parts: [
      { kind: "ellipsoid", at: { x: 0, y: 0, z: 120 }, radii: { x: 90, y: 30, z: 40 } },
      { kind: "capsule", at: { x: 70, y: 0, z: 140 }, to: { x: 120, y: 0, z: 200 }, radius: 22, radius2: 14 },
      { kind: "capsule", at: { x: 60, y: 22, z: 100 }, to: { x: 62, y: 22, z: 4 }, radius: 12, radius2: 6 },
    ],
    mirror: { axis: "y", at: 0 },
    smooth: 12,
  });
  assert.ok(r.ok, JSON.stringify(r));
  const res = r.result as { id: string; triangles: number; size: { width: number; depth: number; height: number } };
  assert.ok(res.triangles > 500 && res.triangles <= 60000, `${res.triangles}`);
  assert.ok(res.size.depth > 50 && res.size.depth < 80, `both sides: ${res.size.depth}`);
  assert.ok(res.size.height > 200 && res.size.height < 225, `${res.size.height}`);
  const body = e.getDoc().bodies.find((b: { id: string }) => b.id === res.id);
  assert.equal(body.name, "Horse");
  assert.ok(body.mesh && body.elevation < 6, "its feet are on the ground");
  assert.ok((await e.execute("shape_move", { ids: [res.id], by: { x: 50 } })).ok, "it moves like any mesh");
});

await test("sculpt_smooth edits a mesh shape; other shapes and bad numbers are refused in words", async () => {
  const e = new core.Engine(core.emptyDoc());
  const box = (await e.execute("shape_add", { kind: "box", width: 10, depth: 10, height: 10 })).result as { id: string };
  const s = (await e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0, z: 30 }, radius: 25 }], detail: 24 })).result as { id: string; triangles: number };
  const sm = await e.execute("sculpt_smooth", { id: s.id, subdivide: 1, passes: 2 });
  assert.ok(sm.ok, JSON.stringify(sm));
  assert.equal((sm.result as { triangles: number }).triangles, s.triangles * 4);
  const no = await e.execute("sculpt_smooth", { id: box.id });
  assert.ok(!no.ok && /no mesh surface/.test(JSON.stringify(no)));
  assert.ok(!(await e.execute("sculpt_smooth", { id: s.id, subdivide: 5 })).ok);
  assert.ok(!(await e.execute("sculpt_blend", { parts: [] })).ok);
  assert.ok(!(await e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0 }, radius: -1 }] })).ok);
  assert.ok(!(await e.execute("sculpt_loft", { sections: [{ at: { x: 0, y: 0 }, radius: 1 }] })).ok);
});

await test("mesh_build makes a shape from written-out triangles, turns inside-out ones round, and says when it is open", async () => {
  const e = new core.Engine(core.emptyDoc());
  // A tetrahedron, its triangles wound clockwise (inside out) on purpose.
  const vertices = [[0, 0, 0], [40, 0, 0], [0, 40, 0], [0, 0, 40]];
  const inside = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  const r = await e.execute("mesh_build", { name: "Gem", vertices, triangles: inside, colors: ["#ff0000", null, null, null] });
  assert.ok(r.ok, JSON.stringify(r));
  const res = r.result as { id: string; triangles: number; note?: string };
  assert.equal(res.triangles, 4);
  assert.match(res.note ?? "", /turned round/);
  assert.doesNotMatch(res.note ?? "", /open/);
  const body = e.getDoc().bodies.find((b: { id: string }) => b.id === res.id);
  assert.equal(body.name, "Gem");
  assert.equal(body.mesh.colors.length, 12, "one colour per point");
  const sheet = await e.execute("mesh_build", { vertices: [[0, 0, 0], [10, 0, 0], [0, 10, 0]], triangles: [[0, 1, 2]] });
  assert.ok(sheet.ok);
  assert.match((sheet.result as { note: string }).note, /open: 3 edges/);
  const bad = await e.execute("mesh_build", { vertices, triangles: [[0, 1, 9]] });
  assert.ok(!bad.ok && /0 to 3/.test(JSON.stringify(bad)), JSON.stringify(bad));
  assert.ok(!(await e.execute("mesh_build", { vertices, triangles: inside, colors: ["#f00"] })).ok, "one colour per vertex");
});

await test("a painted blend keeps its paint through sculpt_blend and a smoothing that subdivides", async () => {
  const e = new core.Engine(core.emptyDoc());
  const r = await e.execute("sculpt_blend", {
    parts: [
      { kind: "ellipsoid", at: { x: 0, y: 0, z: 40 }, radii: { x: 40, y: 25, z: 25 } },
      { kind: "box", at: { x: 40, y: 0, z: 40 }, radii: { x: 12, y: 12, z: 12 }, round: 4, turn: { z: 45 }, color: "#111111" },
      { kind: "sphere", at: { x: -38, y: 0, z: 45 }, radius: 8, carve: true },
    ],
    detail: 64,
  });
  assert.ok(r.ok, JSON.stringify(r));
  const id = (r.result as { id: string }).id;
  const body = () => e.getDoc().bodies.find((b: { id: string }) => b.id === id);
  assert.equal(body().mesh.colors.length, body().mesh.positions.length);
  assert.ok((await e.execute("sculpt_smooth", { id, subdivide: 1 })).ok);
  assert.equal(body().mesh.colors.length, body().mesh.positions.length, "still one colour per point");
});

await test("mesh shapes join and cut as solids: one mesh shape comes out, each part keeping the colour it showed", async () => {
  const e = new core.Engine(core.emptyDoc());
  const ball = (x: number, color: string) => e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x, y: 0, z: 30 }, radius: 25 }], detail: 40, color });
  const a = ((await ball(0, "#ff0000")).result as { id: string }).id;
  const b = ((await ball(30, "#0000ff")).result as { id: string }).id;
  const box = ((await e.execute("shape_add", { kind: "box", x: -30, y: 0, width: 20, depth: 20, height: 20, color: "#00ff00" })).result as { id: string }).id;
  const j = await e.execute("shapes_join", { ids: [a, b, box] });
  assert.ok(j.ok, JSON.stringify(j));
  const bodies = e.getDoc().bodies;
  assert.equal(bodies.length, 1, "three shapes became one");
  const joined = bodies[0];
  assert.ok(joined.mesh && joined.mesh.colors.length === joined.mesh.positions.length, "the colours go with it as paint");
  const p = joined.mesh.positions;
  const colourAt = (want: (x: number) => boolean) => {
    for (let i = 0; i < p.length; i += 3) if (want(p[i])) return joined.mesh.colors.slice(i, i + 3).map((c: number) => Math.round(c * 10) / 10);
    return null;
  };
  assert.deepEqual(colourAt((x) => x > 50), [0, 0, 1], "the right ball is still blue");
  assert.deepEqual(colourAt((x) => x < -35), [0, 1, 0], "the box is still green");

  // Cut a hole: the cutter is used up and the shape keeps its id and name.
  const name = joined.name;
  const hole = ((await e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0, z: 30 }, radius: 12 }], detail: 30 })).result as { id: string }).id;
  const before = volume(e.getDoc().bodies[0].mesh);
  const cut = await e.execute("shapes_subtract", { from: [joined.id], cutters: [hole] });
  assert.ok(cut.ok, JSON.stringify(cut));
  const after = e.getDoc().bodies;
  assert.equal(after.length, 1, "the cutter is used up");
  assert.equal(after[0].id, joined.id);
  assert.equal(after[0].name, name);
  assert.ok(volume(after[0].mesh) < before * 0.97, `${volume(after[0].mesh)} < ${before}`);

  // An open sheet is not a solid: refused, with the reason.
  const sheet = ((await e.execute("mesh_build", { vertices: [[0, 0, 0], [10, 0, 0], [0, 10, 0]], triangles: [[0, 1, 2]] })).result as { id: string }).id;
  const no = await e.execute("shapes_join", { ids: [joined.id, sheet] });
  assert.ok(!no.ok && /not a closed solid/.test(JSON.stringify(no)), JSON.stringify(no));
});

await test("a Sphere is a stock shape: a ball that stands on the ground, sized by its width, and moves like any mesh", async () => {
  // Usability trial 2026-11-19 (F13): Shapes had no sphere; by hand a ball was a bevelled cylinder.
  const e = new core.Engine(core.emptyDoc());
  const r = await e.execute("shape_add", { kind: "sphere", width: 80, x: 100, y: 50, color: "#e8691c" });
  assert.ok(r.ok, JSON.stringify(r));
  const id = (r.result as { id: string }).id;
  const b = e.getDoc().bodies.find((x: { id: string }) => x.id === id);
  assert.ok(b.mesh && b.mesh.positions.length > 300, "a mesh");
  assert.equal(b.name, "Sphere 1");
  assert.equal(b.color, "#e8691c");
  assert.ok(Math.abs(b.extrusionHeight - 80) < 3, `as tall as it is wide: ${b.extrusionHeight}`);
  assert.ok((b.elevation ?? 0) < 1, "standing on the ground");
  const xs = b.points.map((p: { x: number }) => p.x);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 100) < 2, "centred where it was put");
  const up = await e.execute("shape_add", { kind: "sphere", onTopOf: id, width: 30 });
  assert.ok(up.ok, JSON.stringify(up));
  assert.ok(!(await e.execute("shape_add", { kind: "sphere", width: 0.2 })).ok, "too small is refused in words");
});

console.log("sculpt tests passed");
