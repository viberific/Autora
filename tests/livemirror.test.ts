/**
 * The live copy's client store keeps the browser's page and the app window's page apart. They are two Chromiums on one
 * session and both send "mirror" messages; one shared slot would have each snapshot throw the other page's copy away
 * (a Creator window beside a live browser card showed whichever page spoke last).
 *
 *   npx tsx tests/livemirror.test.ts
 */
import assert from "node:assert/strict";
import { pushMirror, subscribeMirror } from "../src/lib/liveMirror";

console.log("live copy channels");

const snap = (gen: number, extra: Record<string, unknown> = {}) => ({ op: "snapshot", session: "s1", gen, size: 10, ...extra });
const batch = (gen: number, extra: Record<string, unknown> = {}) => ({ op: "batch", session: "s1", gen, m: [{ k: "text" }], ...extra });

pushMirror(snap(1), 10);
pushMirror(snap(7, { source: "preview" }), 10);
pushMirror(batch(1), 5);
pushMirror(batch(7, { source: "preview" }), 5);
// A batch for the other page's generation is not this page's change.
pushMirror(batch(7), 5);
pushMirror(batch(1, { source: "preview" }), 5);

const got = (channel?: "browser" | "preview") => {
  const seen: Array<{ op: string; gen: number }> = [];
  const off = subscribeMirror("s1", (m) => seen.push({ op: m.op, gen: m.gen }), channel);
  off();
  return seen;
};

assert.deepEqual(got("browser"), [{ op: "snapshot", gen: 1 }, { op: "batch", gen: 1 }]);
console.log("  ok  the browser's copy starts from its own snapshot and its own changes");
assert.deepEqual(got("preview"), [{ op: "snapshot", gen: 7 }, { op: "batch", gen: 7 }]);
console.log("  ok  the app window's copy starts from its own, whatever the browser said last");
assert.deepEqual(got(), got("browser"), "the browser is the default");
console.log("  ok  a listener with no channel is the browser's, as before");

const live: Array<[string, number]> = [];
const offB = subscribeMirror("s1", (m) => live.push(["browser", m.gen]), "browser");
const offP = subscribeMirror("s1", (m) => live.push(["preview", m.gen]), "preview");
live.length = 0; // a newcomer is first given what its channel already holds; only what comes after is counted
pushMirror(batch(7, { source: "preview" }), 5);
pushMirror(batch(1), 5);
offB(); offP();
assert.deepEqual(live, [["preview", 7], ["browser", 1]]);
console.log("  ok  what arrives afterwards goes only to the window it belongs to");

// Another session on the same channel starts clean.
pushMirror({ op: "snapshot", session: "s2", gen: 3, size: 1, source: "preview" }, 1);
assert.deepEqual(got("preview"), [], "s1's copy is gone from the channel");
console.log("  ok  a different session on a channel replaces the old one");

console.log("livemirror: all passed");
