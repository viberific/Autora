/**
 * Autora's bubble over a tool that has a phone's whole screen (src/lib/bubble.ts, components/ChatBubble.tsx): where it
 * sits, where it settles when let go, and when a drop is on the close target that ends full screen.
 *
 *   npx tsx tests/bubble.test.ts
 */
import assert from "node:assert/strict";
import { BUBBLE_GAP, BUBBLE_SIZE, DEFAULT_SPOT, closeTarget, overClose, placeBubble, settleBubble } from "../src/lib/bubble";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const phone = { w: 390, h: 844, top: 47, bottom: 34 };

test("it starts on the right side, inside the screen", () => {
  const at = placeBubble(DEFAULT_SPOT, phone);
  assert.equal(at.x, phone.w - BUBBLE_SIZE - BUBBLE_GAP);
  assert.ok(at.y >= BUBBLE_GAP + phone.top && at.y + BUBBLE_SIZE <= phone.h - BUBBLE_GAP - phone.bottom);
});

test("let go, it settles on the nearer side at the height it was dropped", () => {
  const left = settleBubble(40, 300, phone);
  assert.equal(left.side, "left");
  const right = settleBubble(300, 300, phone);
  assert.equal(right.side, "right");
  assert.equal(placeBubble(left, phone).x, BUBBLE_GAP);
  assert.ok(Math.abs(placeBubble(left, phone).y - 300) <= 1, "the same height");
});

test("dropped past the notch or the home bar, it stays clear of them", () => {
  assert.equal(placeBubble(settleBubble(10, -200, phone), phone).y, BUBBLE_GAP + phone.top);
  assert.equal(placeBubble(settleBubble(10, 5000, phone), phone).y, phone.h - BUBBLE_SIZE - BUBBLE_GAP - phone.bottom);
});

test("its place is a share of the height, so it survives the phone turning", () => {
  const spot = settleBubble(300, 400, phone);
  const turned = { w: 844, h: 390 };
  const at = placeBubble(spot, turned);
  assert.equal(at.x, turned.w - BUBBLE_SIZE - BUBBLE_GAP);
  assert.ok(at.y >= BUBBLE_GAP && at.y + BUBBLE_SIZE <= turned.h - BUBBLE_GAP);
});

test("only a drop on the close target at the foot ends full screen", () => {
  const t = closeTarget(phone);
  assert.ok(overClose(t.x - BUBBLE_SIZE / 2, t.y - BUBBLE_SIZE / 2, phone));
  assert.ok(!overClose(BUBBLE_GAP, 300, phone));
  assert.ok(!overClose(t.x - BUBBLE_SIZE / 2, t.y - 300, phone));
});

console.log(`\n${passed} passed`);
