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
import { blendMesh, loftMesh, smoothMesh, subdivide } from "../autora-3d/src/utils/organic";

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

console.log("sculpt tests passed");
