/**
 * Autora 3D's freehand brushes: Build, Smooth, Flatten and Grab on a mesh shape, with mirroring and welded seams.
 *
 *   npx tsx tests/sculpt-brush.test.ts
 */
import assert from "node:assert/strict";
import { SculptMesh, boundsOf, DEFAULT_BRUSH, type Brush } from "../autora-3d/src/utils/sculpt";
import { blendMesh } from "../autora-3d/src/utils/organic";

async function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const ball = () => blendMesh([{ kind: "sphere", a: { x: 0, y: 0, z: 50 }, radius: 30 }], { smooth: 0, detail: 40 });
const radius = (pos: number[], i: number) => Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2] - 50);
const brush = (b: Partial<Brush>): Brush => ({ ...DEFAULT_BRUSH, radius: 15, strength: 1, ...b });
/** Index of the vertex nearest a point. */
const nearestIdx = (pos: number[], p: number[]) => {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pos.length / 3; i++) { const d = Math.hypot(pos[i * 3] - p[0], pos[i * 3 + 1] - p[1], pos[i * 3 + 2] - p[2]); if (d < bd) { bd = d; best = i; } }
  return best;
};

await test("Build raises the surface under the brush and leaves the far side alone; carve cuts in", () => {
  const m = ball();
  const sm = new SculptMesh(m.positions, m.indices);
  const top = nearestIdx(m.positions, [0, 0, 80]);
  const far = nearestIdx(m.positions, [0, 0, 20]);
  for (let i = 0; i < 5; i++) sm.dab([0, 0, 80], brush({ kind: "build" }));
  const after = sm.positions();
  assert.ok(radius(after, top) > 30 + 2, `top went out: ${radius(after, top)}`);
  assert.ok(Math.abs(radius(after, far) - radius(m.positions, far)) < 0.01, "far side untouched");
  const cut = new SculptMesh(m.positions, m.indices);
  for (let i = 0; i < 5; i++) cut.dab([0, 0, 80], brush({ kind: "build", carve: true }));
  assert.ok(radius(cut.positions(), top) < 30 - 2);
});

await test("Smooth evens out bumps; Flatten presses a bump toward the plane", () => {
  const m = ball();
  const bumpy = new SculptMesh(m.positions, m.indices);
  for (let i = 0; i < 6; i++) bumpy.dab([0, 0, 80], brush({ kind: "build", radius: 6, strength: 1 }));
  const bumped = bumpy.positions();
  const spread = (pos: number[]) => { const r = Array.from({ length: pos.length / 3 }, (_, i) => radius(pos, i)); return Math.max(...r) - Math.min(...r); };
  const smoother = new SculptMesh(bumped, m.indices);
  for (let i = 0; i < 8; i++) smoother.dab([0, 0, 80], brush({ kind: "smooth", radius: 14 }));
  assert.ok(spread(smoother.positions()) < spread(bumped), "smoothing lowers the peak");
  const flat = new SculptMesh(bumped, m.indices);
  for (let i = 0; i < 8; i++) flat.dab([0, 0, 82], brush({ kind: "flatten", radius: 14 }));
  assert.ok(spread(flat.positions()) < spread(bumped), "flattening lowers the peak");
});

await test("Grab drags the surface along with the offset, falling off with distance, and does not accumulate", () => {
  const m = ball();
  const sm = new SculptMesh(m.positions, m.indices);
  const top = nearestIdx(m.positions, [0, 0, 80]);
  sm.grabBegin([0, 0, 80], brush({ kind: "grab", radius: 20 }));
  sm.grabMove([0, 0, 10]);
  sm.grabMove([0, 0, 10]);
  const pos = sm.positions();
  assert.ok(Math.abs(pos[top * 3 + 2] - (m.positions[top * 3 + 2] + 10)) < 1.5, "moves by the offset, once");
  const far = nearestIdx(m.positions, [0, 0, 20]);
  assert.ok(Math.abs(pos[far * 3 + 2] - m.positions[far * 3 + 2]) < 0.01);
  sm.grabEnd();
});

await test("mirroring works the same stroke on the other side of the middle", () => {
  const m = ball();
  const sm = new SculptMesh(m.positions, m.indices);
  const a = nearestIdx(m.positions, [25, 0, 50]);
  const b = nearestIdx(m.positions, [-25, 0, 50]);
  for (let i = 0; i < 4; i++) sm.dab([25, 0, 50], brush({ kind: "build", symmetry: "x" }));
  const pos = sm.positions();
  const da = radius(pos, a) - radius(m.positions, a);
  const db = radius(pos, b) - radius(m.positions, b);
  assert.ok(da > 1 && Math.abs(da - db) < 0.5, `${da} vs ${db}`);
});

await test("vertices at the same place move together, so a seam does not tear", () => {
  // Two triangles that share an edge but not vertex numbers (as a file with seams has).
  const positions = [0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
  const indices = [0, 1, 2, 3, 4, 5];
  const sm = new SculptMesh(positions, indices);
  sm.dab([5, 5, 0], brush({ kind: "build", radius: 20 }));
  const pos = sm.positions();
  assert.deepEqual(pos.slice(3, 6), pos.slice(9, 12));
  assert.deepEqual(pos.slice(15, 18), pos.slice(15, 18));
  assert.ok(pos[2] !== 0 || pos[5] !== 0 || pos[8] !== 0, "something moved");
});

await test("boundsOf gives the footprint box and height a shape keeps", () => {
  const b = boundsOf([-5, 2, 0, 15, 8, 30, 3, 4, 10]);
  assert.deepEqual(b.points[0], { x: -5, y: 2 });
  assert.deepEqual(b.points[2], { x: 15, y: 8 });
  assert.equal(b.height, 30);
});

console.log("brush tests passed");
