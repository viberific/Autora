/**
 * The cursor's motion and typing in the PDF and Office windows: the same kind
 * of path the browser's pointer takes, and an uneven rhythm of keys.
 *
 *   npx tsx tests/humanpath.test.ts
 */
import assert from "node:assert/strict";
import { clearCursor, recentCursor, reportCursor } from "../src/lib/cursorPos";
import { glance } from "../src/components/ImmersiveChat";
import { along, ease, FOLLOW_MAX_SPEED, followStep, humanRoute, routeMs, typingDelays } from "../src/lib/humanPath";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

console.log("cursor motion");

test("a route ends exactly on the target and is not a straight line", () => {
  const from = { x: 0, y: 0 }, to = { x: 400, y: 300 };
  for (let n = 0; n < 20; n++) {
    const route = humanRoute(from, to);
    assert.deepEqual(route.at(-1), to);
    assert.ok(route.length >= 12);
    const off = Math.max(...route.map((p) => Math.abs(300 * p.x - 400 * p.y) / 500));
    assert.ok(off > 1, "it bends off the chord");
  }
});

test("two routes between the same points are not alike", () => {
  const a = humanRoute({ x: 0, y: 0 }, { x: 300, y: 100 }), b = humanRoute({ x: 0, y: 0 }, { x: 300, y: 100 });
  assert.notDeepEqual(a, b);
});

test("it eases: slow at the ends, quick in the middle", () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.1) < 0.05 && ease(0.9) > 0.95 && ease(0.5) === 0.5);
});

test("a longer reach takes longer, but not in proportion", () => {
  const avg = (d: number) => Array.from({ length: 50 }, () => routeMs(d)).reduce((x, y) => x + y, 0) / 50;
  assert.ok(avg(800) > avg(50));
  assert.ok(avg(800) < avg(50) * 16);
  assert.ok(routeMs(5000) <= 1100 * 1.15 + 1);
});

test("along() reads a route by progress and never runs off either end", () => {
  const route = humanRoute({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(along(route, 1), { x: 100, y: 0 });
  assert.deepEqual(along(route, 2), { x: 100, y: 0 });
  assert.ok(Math.abs(along(route, 0).x) < 30);
});

console.log("the board's cursor following an editor's hand");

/** A frame's hand gliding from `from` to `to` (office/shim/hand.js), reporting where it is every 30 ms, as frames do. */
function frameReports(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const ms = 260 + 115 * Math.log2(1 + dist / 24);
  const out: Array<{ t: number; p: { x: number; y: number } }> = [];
  for (let t = 0; t <= ms + 30; t += 30) {
    const e = ease(Math.min(1, t / ms));
    out.push({ t, p: { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e } });
  }
  return { reports: out, ms };
}

/** The board's pointer, ticking at 60 frames a second, given each report as it comes. */
function follow(start: { x: number; y: number }, reports: Array<{ t: number; p: { x: number; y: number } }>, until: number) {
  let at = start;
  let target: { x: number; y: number } | null = null;
  const ticks: Array<{ t: number; at: { x: number; y: number }; target: { x: number; y: number } | null }> = [];
  let i = 0;
  for (let t = 0; t <= until; t += 16) {
    while (i < reports.length && reports[i].t <= t) target = reports[i++].p;
    if (target) at = followStep(at, target, 16);
    ticks.push({ t, at, target });
  }
  return ticks;
}

test("it always heads for the hand's newest place, never an old one, and never jumps", () => {
  const to = { x: 900, y: 520 };
  const { reports, ms } = frameReports({ x: 200, y: 200 }, to);
  const ticks = follow({ x: 1300, y: 80 }, reports, ms + 400);
  for (let n = 1; n < ticks.length; n++) {
    const a = ticks[n - 1].at, b = ticks[n].at, goal = ticks[n].target!;
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) <= FOLLOW_MAX_SPEED * 16 + 1e-6, `a jump at ${ticks[n].t} ms`);
    // Each step brings it closer to where the hand is now, not to where it was.
    assert.ok(Math.hypot(goal.x - b.x, goal.y - b.y) <= Math.hypot(goal.x - a.x, goal.y - a.y) + 1e-6, `away from the hand at ${ticks[n].t} ms`);
  }
});

test("it is on the thing being clicked by the time the hand presses it", () => {
  const to = { x: 640, y: 410 };
  for (const start of [{ x: 20, y: 880 }, { x: 1400, y: 40 }, { x: 600, y: 400 }]) {
    const { reports, ms } = frameReports({ x: 720, y: 360 }, to);
    // The hand rests at least 60 ms on its target before pressing (hand.js click()).
    const at = follow(start, reports, ms + 60).at(-1)!.at;
    assert.ok(Math.hypot(at.x - to.x, at.y - to.y) < 3, `${JSON.stringify(start)} -> ${JSON.stringify(at)}`);
  }
});

test("a step never passes the target", () => {
  assert.deepEqual(followStep({ x: 0, y: 0 }, { x: 0.4, y: 0 }, 16), { x: 0.4, y: 0 });
  const p = followStep({ x: 0, y: 0 }, { x: 100, y: 0 }, 500);
  assert.ok(p.x <= 100 && p.x > 0);
});

console.log("typing");

test("keys come at uneven gaps, and all of it fits the budget", () => {
  const gaps = typingDelays("The quick brown fox jumps over the lazy dog. ".repeat(3), 2600);
  assert.equal(gaps.length, 135);
  assert.ok(gaps.reduce((a, b) => a + b, 0) <= 2600 + gaps.length, "within the budget, give or take rounding");
  assert.ok(new Set(gaps).size > 3, "not metronomic");
});

test("short words are typed at a person's pace, not squeezed", () => {
  const total = typingDelays("Hello", 2600).reduce((a, b) => a + b, 0);
  assert.ok(total > 150 && total < 1400, String(total));
});

console.log("the agent's line over a full-screen tool");

test("the cursor's place is known while it moves, and forgotten once it has gone", () => {
  assert.equal(recentCursor(), null);
  reportCursor(120, 340);
  assert.deepEqual(recentCursor(), { x: 120, y: 340 });
  assert.equal(recentCursor(-1), null, "an old position is no position");
  clearCursor();
  assert.equal(recentCursor(), null);
});

test("a reply is cut to a glance: its first sentence, plain, short", () => {
  assert.equal(glance("I'll **redraw** the chart. Then check it."), "I'll redraw the chart.");
  assert.equal(glance("```js\nlet x\n```\nDone with the [report](http://a.b)."), "Done with the report.");
  const long = glance("word ".repeat(80));
  assert.ok(long.length <= 110 && long.endsWith("…"));
  assert.equal(glance(""), "");
});

console.log(`${passed} passed`);
