/**
 * The Video command log (server/opencut.ts, server/videolog.ts): the editor owns the project, so the log is built from the
 * timelines it reports. An agent step that changed the timeline is a command by the agent; a timeline that differs from the
 * last one seen, with no agent step between, is the person's; going back to before a command is the editor's own undo until the
 * timeline matches the one kept from before it; and the cut is the person's, so the agent takes back only its own. No browser:
 * the editor is played by the test, with an undo stack.
 *
 *   npx tsx tests/videolog.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-videolog-"));
const { default: express } = await import("express");
const oc = await import("../server/opencut");
const { describeVideoChange, fingerprint } = await import("../server/videolog");
type Snap = Parameters<typeof fingerprint>[0];

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const clip = (id: string, start: number, duration = 2, extra: Record<string, unknown> = {}) => ({ id, type: "video", name: `Clip ${id}`, start, duration, trimStart: 0, trimEnd: 0, ...extra });
// What the editor reports besides the timeline (duration, playhead, media) is not the project's to log, but the tools read it.
const timeline = (clips: ReturnType<typeof clip>[], name = "Holiday"): Snap => ({
  project: { id: "p1", name }, canvas: { width: 1920, height: 1080 }, fps: 30, tracks: [{ id: "t1", type: "video", name: "Main", clips }],
  duration: Math.max(0, ...clips.map((c) => c.start + c.duration)), playhead: 0, playing: false, media: [],
} as Snap);

await test("a timeline change is said in a colleague's words: clips, trims, moves, tracks, the canvas", () => {
  const a = timeline([clip("a", 0), clip("b", 2)]);
  assert.deepEqual(describeVideoChange(a, structuredClone(a)), []);
  const added = timeline([clip("a", 0), clip("b", 2), clip("c", 4)]);
  assert.deepEqual(describeVideoChange(a, added), ['added video clip "Clip c" at 4.00s']);
  assert.deepEqual(describeVideoChange(added, a), ['removed video clip "Clip c"']);
  const edited = timeline([clip("a", 1), clip("b", 2, 1.5)]);
  assert.deepEqual(describeVideoChange(a, edited), ['video clip "Clip a": moved from 0.00s to 1.00s', 'video clip "Clip b": trimmed (now 1.50s long)']);
  const muted = timeline([clip("a", 0, 2, { muted: true }), clip("b", 2)]);
  assert.deepEqual(describeVideoChange(a, muted), ['video clip "Clip a": muted it']);
  const bigger = { ...a, canvas: { width: 3840, height: 2160 } };
  assert.deepEqual(describeVideoChange(a, bigger), ["changed the canvas to 3840x2160"]);
  assert.notEqual(fingerprint(a), fingerprint(added));
  assert.equal(fingerprint(a), fingerprint({ ...a, playhead: 9, playing: true } as Snap), "the playhead is not the project");
});

// ---- the editor, played by the test: a timeline with an undo and a redo stack ----
let now: Snap = timeline([clip("a", 0)]);
const undo: Snap[] = [];
let redo: Snap[] = [];
const edit = (next: Snap) => { undo.push(now); redo = []; now = next; };
const answer = (name: string, args: Record<string, unknown>): unknown => {
  switch (name) {
    case "state": return structuredClone(now);
    case "undo": { const prev = undo.pop(); if (prev) { redo.push(now); now = prev; } return structuredClone(now); }
    case "redo": { const next = redo.pop(); if (next) { undo.push(now); now = next; } return structuredClone(now); }
    case "add_clip": edit(timeline([...now.tracks[0]!.clips, clip(String(args.id), Number(args.start))] as ReturnType<typeof clip>[])); return structuredClone(now);
    case "trim": edit(timeline(now.tracks[0]!.clips.map((c) => (c.id === args.id ? { ...c, duration: Number(args.duration) } : c)) as ReturnType<typeof clip>[])); return structuredClone(now);
    default: throw new Error(`Unknown video command: ${name}`);
  }
};

const app = express();
app.use(express.json());
let base = "";
const post = (url: string, body?: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
oc.opencutRoutes(app, {
  exists: (id) => id === "v1",
  // The window: claims what it is sent and answers as the editor would.
  push: (_id, m) => {
    if (m.type !== "opencut.command") return;
    void (async () => {
      const id = String(m.id);
      const claimed = (await (await post(`/api/opencut/claim?session=v1&id=${id}`)).json()) as { won?: boolean };
      if (!claimed.won) return;
      try { await post("/api/opencut/reply?session=v1", { id, ok: true, value: answer(String(m.name), (m.args ?? {}) as Record<string, unknown>) }); }
      catch (e) { await post("/api/opencut/reply?session=v1", { id, ok: false, value: { message: String(e) } }); }
    })();
  },
});
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
await post("/api/opencut/open?session=v1");
await post("/api/opencut/ready?session=v1", { ready: true });

const events: Array<{ who: string; name: string }> = [];
oc.onVideoCommand((_s, c) => events.push({ who: c.who, name: c.name }));
const ctx = { session: "v1", cwd: process.env.AUTORA_STATE_DIR!, cancelled: () => false } as Parameters<typeof oc.runVideoTool>[2];
const tool = (name: string, args: Record<string, unknown>) => oc.runVideoTool(name, args, ctx);
const log = () => oc.videoLogOf("v1");

try {
  await test("the first look sets the baseline; it is not a command", async () => {
    const look = await tool("video_look", {});
    assert.ok(look.ok, look.summary);
    assert.equal(log().length, 0);
  });

  await test("an agent step that changed the timeline is a command by the agent, said as what it did", async () => {
    const out = await tool("video_edit", { action: "add_clip", id: "b", start: 2 });
    assert.ok(out.ok, out.summary);
    assert.deepEqual(log().map((c) => [c.name, c.who]), [["agent_edit", "agent"]]);
    assert.match(log()[0]!.summary, /added video clip "Clip b" at 2.00s/);
    assert.deepEqual(events.map((e) => e.who), ["agent"]);
  });

  await test("a change the person made in the editor is found the next time the agent looks, and is theirs", async () => {
    edit(timeline(now.tracks[0]!.clips.map((c) => (c.id === "a" ? { ...c, duration: 1 } : c)) as ReturnType<typeof clip>[]));
    const out = await tool("video_history", {});
    assert.ok(out.ok);
    assert.match(out.summary, /#2 the person \(person_edit.*Clip a.*trimmed \(now 1.00s long\)/);
    assert.match(out.summary, /#1 you \(agent_edit/);
    assert.deepEqual(log().map((c) => c.who), ["agent", "person"]);
  });

  await test("the person's changes seen close together are one command, said from where they began", async () => {
    edit(timeline(now.tracks[0]!.clips.map((c) => (c.id === "a" ? { ...c, duration: 0.5 } : c)) as ReturnType<typeof clip>[]));
    await tool("video_history", {});
    assert.equal(log().length, 2, "still one command by the person");
    assert.match(log()[1]!.summary, /trimmed \(now 0.50s long\)/);
  });

  await test("the cut is the person's: the agent cannot take back a command with theirs after it, and nothing changes", async () => {
    const before = fingerprint(now);
    for (const n of [1, 2]) {
      const out = await tool("video_history", { action: "revert", n });
      assert.equal(out.ok, false);
      assert.match(out.summary, /the person's own cutting/);
    }
    assert.equal(fingerprint(now), before);
  });

  await test("the agent takes back its own latest step by the editor's undo, as a command of its own", async () => {
    assert.ok((await tool("video_edit", { action: "add_clip", id: "c", start: 5 })).ok);
    const n = log().at(-1)!.n;
    assert.ok(now.tracks[0]!.clips.some((c) => c.id === "c"));
    const out = await tool("video_history", { action: "revert", n });
    assert.ok(out.ok, out.summary);
    assert.ok(!now.tracks[0]!.clips.some((c) => c.id === "c"));
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "agent"]);
    assert.match(last.summary, new RegExp(`before command ${n}`));
  });

  await test("taking back a revert goes the other way, by redo", async () => {
    const n = log().at(-1)!.n;
    assert.ok((await tool("video_history", { action: "revert", n })).ok);
    assert.ok(now.tracks[0]!.clips.some((c) => c.id === "c"), "the clip is back");
  });

  await test("when the editor's history does not reach that timeline, nothing is changed and it says so", async () => {
    assert.ok((await tool("video_edit", { action: "add_clip", id: "d", start: 7 })).ok);
    const n = log().at(-1)!.n;
    undo.length = 0; // the editor was reloaded: its undo history is gone
    const before = fingerprint(now);
    const out = await tool("video_history", { action: "revert", n });
    assert.equal(out.ok, false);
    assert.match(out.summary, /does not reach the timeline/);
    assert.equal(fingerprint(now), before);
  });

  await test("the person goes back to before any command through the route, their own cutting after it included", async () => {
    assert.ok((await tool("video_edit", { action: "add_clip", id: "e", start: 9 })).ok);
    const n = log().at(-1)!.n;
    const goal = fingerprint(undo.at(-1)!);
    edit(timeline(now.tracks[0]!.clips.map((c) => (c.id === "a" ? { ...c, duration: 0.25 } : c)) as ReturnType<typeof clip>[]));
    const res = await post("/api/opencut/commands/revert?session=v1", { n });
    assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => null)));
    assert.equal(fingerprint(now), goal, "back to before the agent's clip, and before their trim that followed it");
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "person"]);
  });

  await test("unknown or malformed commands are refused, and the log is listed", async () => {
    assert.equal((await post("/api/opencut/commands/revert?session=v1", { n: 999 })).status, 404);
    assert.equal((await post("/api/opencut/commands/revert?session=v1", { n: "x" })).status, 400);
    const listed = (await (await fetch(`${base}/api/opencut/commands?session=v1`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, log().length);
  });

  await test("another project is its own log", async () => {
    now = { ...timeline([clip("z", 0)]), project: { id: "p2", name: "Other" } };
    await tool("video_look", {});
    assert.equal(log().length, 0);
  });

  await test("video_history is looking when it reads and a change when it reverts", async () => {
    const { looksOnly } = await import("../server/modes");
    assert.equal(looksOnly("video_history", {}), true);
    assert.equal(looksOnly("video_history", { action: "revert", n: 1 }), false);
  });
} finally {
  server.close();
  oc.dropOpencut("v1");
}
console.log(`videolog: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
