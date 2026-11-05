/**
 * The Music command log (server/studio.ts, server/songlog.ts): every change to the song is a command with who made it and
 * what; the person's saves while they drag are one command; going back to before a command is a new change that is itself
 * logged; and music is the person's, so the agent may take back only its own changes.
 *
 *   npx tsx tests/studiolog.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "../src/lib/studio/model";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-studiolog-"));
const express = (await import("express")).default;
const m = await import("../src/lib/studio/model");
const studio = await import("../server/studio");
const { describeSongChange } = await import("../server/songlog");
const { looksOnly } = await import("../server/modes");
const { studioSPECS } = await import("../server/specs/studio");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("a song change is said in a colleague's words: tempo, tracks, settings, clips and notes", () => {
  const a = m.newProject("Demo");
  const b = structuredClone(a);
  b.bpm = a.bpm + 10;
  const bass = m.newTrack(b, "bass");
  bass.name = "Bass";
  b.tracks.push(bass);
  const said = describeSongChange(a, b);
  assert.ok(said.includes(`changed the tempo from ${a.bpm} to ${b.bpm} bpm`), said.join("|"));
  assert.ok(said.includes("added the track Bass"));
  const c = structuredClone(b);
  c.tracks.find((t) => t.name === "Bass")!.mute = true;
  assert.deepEqual(describeSongChange(b, c), ["changed Bass: muted"]);
  const d = structuredClone(c);
  d.tracks = d.tracks.filter((t) => t.name !== "Bass");
  assert.deepEqual(describeSongChange(c, d), ["removed the track Bass"]);
  assert.deepEqual(describeSongChange(a, structuredClone(a)), []);
});

await test("the agent may take back only what it made itself", () => {
  const log = [
    { n: 1, who: "agent", name: "open", summary: "", at: 1, rev: 1, before: 1 },
    { n: 2, who: "person", name: "person_edit", summary: "", at: 2, rev: 2, before: 2 },
    { n: 3, who: "agent", name: "agent_edit", summary: "", at: 3, rev: 3, before: 3 },
  ] as const;
  assert.equal(studio.agentMayRevert([...log], 3), true);
  assert.equal(studio.agentMayRevert([...log], 2), false, "the person's own command");
  assert.equal(studio.agentMayRevert([...log], 1), false, "the person's work comes after it");
});

const S = "studiolog1";
const app = express();
studio.studioRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => false, push: () => undefined });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/studio/${S}`;
const events: Array<{ who: string; name: string; n: number }> = [];
studio.onStudioCommand((_s, c) => events.push({ who: c.who, name: c.name, n: c.n }));
const run = (name: string, args: Record<string, unknown> = {}) => studio.runStudioTool(S, name, args);
const doc = async (): Promise<{ doc: Project; rev: number }> => (await (await fetch(`${base}/doc`)).json()) as { doc: Project; rev: number };
const put = async (next: Project, rev: number) => fetch(`${base}/doc`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: next, rev }) });
const log = () => studio.studioLog(S);

try {
  await test("the agent's tools are commands by it, said by what they did", async () => {
    assert.ok((await run("studio_open", { new: "Night drive", bpm: 92 })).ok);
    assert.ok((await run("studio_track", { action: "add", instrument: "lead", name: "Tune" })).ok);
    const l = log();
    assert.deepEqual(l.map((c) => [c.name, c.who]), [["open", "agent"], ["agent_edit", "agent"]]);
    assert.match(l[0]!.summary, /started a new song, "Night drive"/);
    assert.equal(events.length, 2);
  });

  await test("the person's saves while they drag are one command by them, said from where the run began", async () => {
    const { doc: song, rev } = await doc();
    const first = structuredClone(song);
    first.tracks.find((t) => t.name === "Tune")!.volume = 0.5;
    assert.equal((await put(first, rev)).status, 200);
    const again = structuredClone(first);
    again.tracks.find((t) => t.name === "Tune")!.volume = 0.4;
    again.tracks.find((t) => t.name === "Tune")!.mute = true;
    assert.equal((await put(again, (await doc()).rev)).status, 200);
    const l = log();
    assert.equal(l.length, 3, "two saves, one command");
    assert.equal(l[2]!.who, "person");
    assert.match(l[2]!.summary, /changed Tune: volume, muted/);
  });

  await test("a save that changed nothing is not a command", async () => {
    const { doc: song, rev } = await doc();
    assert.equal((await put(song, rev)).status, 200);
    assert.equal(log().length, 3);
  });

  await test("the agent reads the log, and what the person changed since a revision", async () => {
    const out = await run("studio_history", {});
    assert.ok(out.ok);
    assert.match(out.summary, /#3 the person \(person_edit.*Tune/);
    assert.match(out.summary, /#2 you \(agent_edit/);
    assert.match(out.summary, /the song goes back to just before it/);
    const since = await run("studio_history", { since_revision: log()[1]!.rev });
    assert.ok(!since.summary.includes("#2 "), "only what came after");
    assert.ok(since.summary.includes("#3 "));
  });

  await test("the agent is refused when the command, or one after it, is the person's: music is theirs", async () => {
    const before = (await doc()).doc;
    for (const n of [2, 3]) {
      const out = await run("studio_history", { action: "revert", n });
      assert.equal(out.ok, false);
      assert.match(out.summary, /the person's own work, and music is theirs/);
    }
    assert.deepEqual((await doc()).doc, before, "the song is untouched");
  });

  await test("the agent takes back its own latest change, as a command of its own", async () => {
    assert.ok((await run("studio_track", { action: "add", instrument: "bass", name: "Low" })).ok);
    const n = log().at(-1)!.n;
    assert.equal(log().at(-1)!.who, "agent");
    assert.ok((await doc()).doc.tracks.some((t) => t.name === "Low"));
    const out = await run("studio_history", { action: "revert", n });
    assert.ok(out.ok, out.summary);
    assert.ok(!(await doc()).doc.tracks.some((t) => t.name === "Low"));
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "agent"]);
    assert.match(last.summary, new RegExp(`before command ${n}`));
    assert.equal(events.at(-1)!.name, "revert");
  });

  await test("the person goes back to before any command through the route; unknown or malformed ones are refused", async () => {
    const post = (body: unknown) => fetch(`${base}/commands/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ n: 3 })).status, 200);
    const song = (await doc()).doc;
    assert.equal(song.tracks.find((t) => t.name === "Tune")!.volume, m.newTrack(song, "lead").volume, "back to before their dragging");
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "person"]);
    assert.equal((await post({ n: 999 })).status, 404);
    assert.equal((await post({ n: "x" })).status, 400);
    const listed = (await (await fetch(`${base}/commands`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, log().length);
  });

  await test("studio_history is looking when it reads and a change when it reverts, and has a spec", () => {
    assert.equal(looksOnly("studio_history", {}), true);
    assert.equal(looksOnly("studio_history", { action: "log" }), true);
    assert.equal(looksOnly("studio_history", { action: "revert", n: 1 }), false);
    assert.ok(studioSPECS.some((s) => s.name === "studio_history"));
  });
} finally {
  server.close();
}
console.log(`studiolog: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
