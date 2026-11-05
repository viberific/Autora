/**
 * The PDF command log (server/commandlog.ts, pdfdesk.ts): every change to the PDF in the window is a command with who made it
 * and what; a run of the person's marking is one command; declining the agent's change is a command; going back to before a
 * command is a restore that is itself logged; the agent reads and reverts it through pdf_history.
 *
 *   npx tsx tests/pdflog.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-pdflog-"));
process.env.AUTORA_STATE_DIR = dir;
const { PDFDocument, StandardFonts } = await import("@cantoo/pdf-lib");
const express = (await import("express")).default;
const desk = await import("../server/pdfdesk");
const { extendRun, addCommand } = await import("../server/commandlog");
const { runPdfTool } = await import("../server/pdf");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("more of a run of marking adds lines to the one command, a repeat of the last line once", () => {
  const log: ReturnType<typeof addCommand>[] = [];
  const run = addCommand(log, 1, { who: "person", name: "person_edit", summary: "added note on page 1", at: 1, rev: 2, before: 1 });
  extendRun(run, ["added note on page 1", "moved note on page 1"], 5, 3);
  extendRun(run, ["moved note on page 1", "removed text on page 2"], 6, 4);
  assert.equal(run.summary, "added note on page 1; moved note on page 1; removed text on page 2");
  assert.deepEqual([run.at, run.rev], [6, 4]);
});

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([612, 792]).drawText("Lease", { x: 50, y: 740, size: 20, font });
const pdf = Buffer.from(await doc.save());

const SESSION = "s-pdflog";
const app = express();
desk.deskRoutes(app, { exists: (id) => id === SESSION, cwd: () => dir });
const server = await new Promise<import("node:http").Server>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/pdfdesk/${SESSION}`;
const events: Array<{ who: string; name: string; n: number }> = [];
desk.onDeskCommand((_s, c) => events.push({ who: c.who, name: c.name, n: c.n }));
const hooks = desk.deskHooks(SESSION);
const note = (id: string, comment: string, x = 10) => ({ id, type: "note", pageNumber: 1, x, y: 10, width: 20, height: 20, noteComment: comment });
const agent = (items: unknown[], label: string) => hooks.open({ name: "lease.pdf", base: pdf, items, working: null, source: null, outName: "lease.pdf", review: { label, diff: true } } as any);

try {
  await test("a PDF the agent makes begins the log", () => {
    agent([], "Opened the lease");
    const log = desk.deskCommands(SESSION);
    assert.deepEqual(log.map((c) => [c.name, c.who, c.before]), [["open", "agent", null]]);
  });

  await test("the agent's change is a command with the version before it", () => {
    agent([{ ...note("agent_1", "Check the date"), autora: "note" }], "Added a note");
    const log = desk.deskCommands(SESSION);
    assert.equal(log.length, 2);
    assert.deepEqual([log[1]!.name, log[1]!.who, log[1]!.summary], ["agent_edit", "agent", "Added a note"]);
    assert.ok(log[1]!.before !== null);
  });

  await test("the person's marking is one command by them, however many saves it took", () => {
    desk.personChanges(SESSION, [note("p1", "Is this right?")], [], dir);
    desk.personChanges(SESSION, [note("p1", "Is this right?", 40)], [], dir);
    const log = desk.deskCommands(SESSION);
    assert.equal(log.length, 3, "two saves, one command");
    assert.equal(log[2]!.who, "person");
    assert.match(log[2]!.summary, /added note "Is this right\?" on page 1; moved note "Is this right\?" on page 1/);
  });

  await test("the agent reads what the person did since a revision", () => {
    const text = hooks.commandLog(0);
    assert.match(text, /#3 the person \(person_edit/);
    assert.match(text, /#2 you \(agent_edit.*Added a note/);
    assert.match(text, /the PDF goes back to just before it/);
    assert.ok(!hooks.commandLog(desk.deskCommands(SESSION)[2]!.rev).includes("#3"));
  });

  await test("declining the agent's change is a command by the person", () => {
    const mark = (desk.deskState(SESSION) as any).marks[0];
    assert.ok(mark, "the agent's change is up for review");
    assert.equal(desk.denyMarks(SESSION, mark.id, dir), true);
    const last = desk.deskCommands(SESSION).at(-1)!;
    assert.deepEqual([last.name, last.who], ["decline", "person"]);
    assert.match(last.summary, /declined: /);
    assert.equal((desk.deskState(SESSION) as any).items.some((i: any) => i.id === "agent_1"), false);
  });

  await test("reverting goes back to just before a command and is itself a command", () => {
    const before = (desk.deskState(SESSION) as any).items.length;
    assert.equal(hooks.revert(3, dir), null);
    const state = desk.deskState(SESSION) as any;
    assert.deepEqual(state.items.map((i: any) => i.id).sort(), ["agent_1"], "back to the agent's note, before the person's marking");
    assert.ok(before >= 1);
    const last = desk.deskCommands(SESSION).at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "agent"]);
    assert.match(last.summary, /before command 3/);
    assert.equal(events.at(-1)!.name, "revert");
  });

  await test("the person reverts through the route; unknown or malformed commands are refused", async () => {
    const post = (body: unknown) => fetch(`${base}/commands/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ n: 3 })).status, 200);
    assert.equal(desk.deskCommands(SESSION).at(-1)!.who, "person");
    assert.equal((await post({ n: 999 })).status, 404);
    assert.equal((await post({ n: "x" })).status, 400);
    assert.match(hooks.revert(1, dir) ?? "", /made the PDF/);
    const listed = (await (await fetch(`${base}/commands`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, desk.deskCommands(SESSION).length);
  });

  await test("pdf_history works through the tool: log, revert, and refuses without a window", async () => {
    const ctx = {
      session: SESSION, cwd: dir, room: 20_000, putBlob: () => "b", showImage: () => undefined, showFile: () => undefined,
      cancelled: () => false, onCancel: () => undefined, desk: hooks,
    };
    const log = await runPdfTool("pdf_history", {}, ctx);
    assert.equal(log.ok, true);
    assert.match(log.summary, /#1 you \(open/);
    const bad = await runPdfTool("pdf_history", { action: "revert" }, ctx);
    assert.equal(bad.ok, false);
    const none = await runPdfTool("pdf_history", {}, { ...ctx, desk: undefined });
    assert.equal(none.ok, false);
    assert.match(none.summary, /no PDF window/);
  });
} finally {
  server.close();
}
console.log(`pdflog: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
