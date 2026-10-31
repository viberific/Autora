import assert from "node:assert/strict";
import { fitAll, jumpTo, unionBounds, zoomAt } from "../src/lib/panacea/workspace-camera";
import type { Camera, Viewport, WorldRect } from "../src/lib/panacea/workspace-camera";

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed++;
  console.log(`  ok  ${name}`);
}

function close(actual: number, expected: number, tolerance = 1e-7): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function fits(rects: readonly WorldRect[], viewport: Viewport, padding = 32, maxZoom = 1): Camera {
  const camera = fitAll(rects, viewport, padding, maxZoom);
  assert.ok(Number.isFinite(camera.zoom) && camera.zoom > 0 && camera.zoom <= maxZoom);
  const tolerance = 1e-7;
  for (const rect of rects) {
    const left = rect.x * camera.zoom + camera.x;
    const top = rect.y * camera.zoom + camera.y;
    const right = (rect.x + rect.width) * camera.zoom + camera.x;
    const bottom = (rect.y + rect.height) * camera.zoom + camera.y;
    assert.ok(left >= padding - tolerance, `left ${left}`);
    assert.ok(top >= padding - tolerance, `top ${top}`);
    assert.ok(right <= viewport.width - padding + tolerance, `right ${right}`);
    assert.ok(bottom <= viewport.height - padding + tolerance, `bottom ${bottom}`);
  }
  return camera;
}

test("union includes negative coordinates, disparate sizes, and degenerate bounds", () => {
  assert.deepEqual(unionBounds([
    { x: -2700, y: -400, width: 280, height: 160 },
    { x: 100, y: 50, width: 4200, height: 3000 },
    { x: -2800, y: 4000, width: 0, height: 0 },
  ]), { x: -2800, y: -400, width: 7100, height: 4400 });
  assert.deepEqual(unionBounds([{ x: -5, y: 7, width: 0, height: 0 }]),
    { x: -5, y: 7, width: 0, height: 0 });
});

test("empty state is deterministic, centered, and respects maximum zoom", () => {
  assert.equal(unionBounds([]), null);
  assert.deepEqual(fitAll([], { width: 1009, height: 700 }), { x: 504.5, y: 350, zoom: 1 });
  assert.deepEqual(fitAll([], { width: 320, height: 640 }, 16, 0.5), { x: 160, y: 320, zoom: 0.5 });
});

test("phone-to-desktop resize fits every native card, including x=-2700", () => {
  const rects = [
    { x: -2700, y: -600, width: 280, height: 180 },
    { x: 30, y: 400, width: 1600, height: 900 },
    { x: -80, y: -1200, width: 30, height: 2200 },
  ];
  for (const viewport of [
    { width: 320, height: 568 }, { width: 390, height: 844 },
    { width: 1009, height: 700 }, { width: 1920, height: 1080 },
  ]) fits(rects, viewport);
  // Workspace starts at page x=430; cameras and anchors remain viewport-local.
  const desktop = fits(rects, { width: 1009, height: 700 });
  assert.ok(430 + rects[0]!.x * desktop.zoom + desktop.x >= 430 + 32);
});

test("huge scenes fit without a clipping minimum zoom", () => {
  const rects = [
    { x: -1e15, y: -1e14, width: 1, height: 1 },
    { x: 1e15, y: 1e14, width: 1e12, height: 1e13 },
  ];
  const camera = fits(rects, { width: 320, height: 568 });
  assert.ok(camera.zoom < 1e-12);
});

test("fit is centered, capped, and handles points, lines, and small viewports", () => {
  assert.deepEqual(fitAll([{ x: -100, y: -50, width: 200, height: 100 }],
    { width: 400, height: 300 }, 50, 4), { x: 200, y: 150, zoom: 1.5 });
  assert.deepEqual(fitAll([{ x: 0, y: 0, width: 10, height: 10 }],
    { width: 400, height: 300 }, 32, 2), { x: 190, y: 140, zoom: 2 });
  fits([{ x: -100, y: -300, width: 0, height: 0 }], { width: 320, height: 568 });
  fits([{ x: -100, y: -300, width: 0, height: 2000 }], { width: 320, height: 568 });
  fits([{ x: -100, y: -300, width: 2000, height: 0 }], { width: 20, height: 10 }, 2);
  fits([{ x: -100, y: -300, width: 2000, height: 1000 }], { width: 320, height: 568 }, 0);
});

test("jump centers existing work and preserves zoom without mutating inputs", () => {
  const rect = Object.freeze({ x: -2700, y: -400, width: 280, height: 160 });
  const viewport = Object.freeze({ width: 1009, height: 700 });
  const camera = Object.freeze({ x: 80, y: -20, zoom: 0.65 });
  const result = jumpTo(rect, viewport, camera);
  close((rect.x + rect.width / 2) * result.zoom + result.x, viewport.width / 2);
  close((rect.y + rect.height / 2) * result.zoom + result.y, viewport.height / 2);
  assert.equal(result.zoom, camera.zoom);
  assert.deepEqual(camera, { x: 80, y: -20, zoom: 0.65 });
  fits(Object.freeze([rect]), viewport);
});

test("anchored zoom preserves world points and round-trips at arbitrary anchors", () => {
  for (const camera of [
    { x: 123, y: -87, zoom: 0.5 }, { x: -2000, y: 1800, zoom: 3 },
    { x: 504.5, y: 350, zoom: 1e-9 },
  ]) {
    for (const anchor of [{ x: 0, y: 0 }, { x: 153.25, y: 287.75 }, { x: -30, y: 1200 }]) {
      const world = { x: (anchor.x - camera.x) / camera.zoom, y: (anchor.y - camera.y) / camera.zoom };
      const next = zoomAt(Object.freeze(camera), Object.freeze(anchor), camera.zoom * 2.7);
      close(world.x * next.zoom + next.x, anchor.x);
      close(world.y * next.zoom + next.y, anchor.y);
      const back = zoomAt(next, anchor, camera.zoom);
      close(back.x, camera.x);
      close(back.y, camera.y);
      assert.deepEqual(zoomAt(camera, anchor, camera.zoom), camera);
      assert.notEqual(zoomAt(camera, anchor, camera.zoom), camera);
    }
  }
});

test("measurable fit invariant holds across 400 deterministic scenes", () => {
  for (let i = 1; i <= 400; i++) {
    const scale = 10 ** (i % 12);
    const rects = [
      { x: -17 * scale, y: -3 * scale, width: (i % 17) * scale, height: (i % 11) * scale },
      { x: 13 * scale, y: 9 * scale, width: scale / 100, height: 19 * scale },
    ];
    fits(rects, { width: 80 + i * 3, height: 90 + i * 2 }, i % 32, (i % 8 + 1) / 4);
  }
});

test("malformed values and unrepresentable results throw explicitly", () => {
  const rect: WorldRect = { x: 0, y: 0, width: 100, height: 100 };
  const viewport = { width: 320, height: 568 };
  const camera = { x: 0, y: 0, zoom: 1 };
  for (const field of ["x", "y", "width", "height"] as const) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const bad = { ...rect, [field]: value };
      assert.throws(() => unionBounds([rect, bad]), RangeError);
      assert.throws(() => fitAll([bad], viewport), RangeError);
      assert.throws(() => jumpTo(bad, viewport, camera), RangeError);
    }
  }
  for (const field of ["width", "height"] as const) {
    assert.throws(() => unionBounds([{ ...rect, [field]: -1 }]), RangeError);
    for (const value of [0, -1, NaN, Infinity]) {
      assert.throws(() => fitAll([], { ...viewport, [field]: value }), RangeError);
      assert.throws(() => jumpTo(rect, { ...viewport, [field]: value }, camera), RangeError);
    }
  }
  for (const value of [-1, NaN, Infinity, 160, 300]) {
    assert.throws(() => fitAll([rect], viewport, value), RangeError);
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => fitAll([], viewport, 32, value), RangeError);
    assert.throws(() => zoomAt(camera, { x: 10, y: 10 }, value), RangeError);
    assert.throws(() => jumpTo(rect, viewport, { ...camera, zoom: value }), RangeError);
    assert.throws(() => zoomAt({ ...camera, zoom: value }, { x: 10, y: 10 }, 1), RangeError);
  }
  for (const field of ["x", "y"] as const) {
    assert.throws(() => zoomAt(camera, { x: 0, y: 0, [field]: NaN }, 2), RangeError);
    assert.throws(() => jumpTo(rect, viewport, { ...camera, [field]: Infinity }), RangeError);
    assert.throws(() => zoomAt({ ...camera, [field]: Infinity }, { x: 0, y: 0 }, 2), RangeError);
  }
  assert.throws(() => unionBounds([{ ...rect, x: Number.MAX_VALUE, width: Number.MAX_VALUE }]), RangeError);
  assert.throws(() => unionBounds([
    { ...rect, x: -Number.MAX_VALUE }, { ...rect, x: Number.MAX_VALUE },
  ]), RangeError);
  assert.throws(() => jumpTo({ ...rect, x: 1e308 }, viewport, { ...camera, zoom: 100 }), RangeError);
  assert.throws(() => zoomAt(camera, { x: 1e308, y: 0 }, 100), RangeError);
});

console.log(`workspace camera: ${passed} tests passed`);
