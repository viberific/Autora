/**
 * The Sheets command log (server/commandlog.ts, officedesk.ts): every change to the workbook is a command with who made it
 * and what, a run of the person's typing is one command, going back to before a command is a restore that is itself logged,
 * and the agent reads and reverts it through office_history.
 *
 *   npx tsx tests/sheetlog.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-sheetlog-test-"));
const express = (await import("express")).default;
const office = await import("../server/officedesk");
const { addCommand, logText, openPersonRun, MAX_COMMANDS } = await import("../server/commandlog");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** A zip of several deflated entries. */
function zipMany(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const raw = Buffer.from(body), data = zlib.deflateRawSync(raw), n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(local, n, data); central.push(c, n);
    offset += local.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}


const book = (b2: string) => zipMany([
  ["xl/workbook.xml", `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
  ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1"><v>${b2}</v></c></row></sheetData></worksheet>`],
]);

await test("the log keeps the newest commands, numbered, and reads since a revision", () => {
  const log: ReturnType<typeof addCommand>[] = [];
  for (let i = 1; i <= MAX_COMMANDS + 5; i++) addCommand(log, i, { who: i % 2 ? "agent" : "person", name: "agent_edit", summary: `step ${i}`, at: i, rev: i, before: i - 1 || null });
  assert.equal(log.length, MAX_COMMANDS);
  assert.equal(log[0]!.n, 6);
  assert.match(logText(log, MAX_COMMANDS + 4), /#\d+ .*step 205/);
  assert.match(logText(log, 9999), /Nothing has changed in the workbook since revision 9999/);
  assert.match(logText([], 0), /no changes logged yet/);
});

await test("a run of the person's typing is open only while the document is still dirty from them", () => {
  const log: ReturnType<typeof addCommand>[] = [];
  addCommand(log, 1, { who: "person", name: "person_edit", summary: "a", at: 1, rev: 2, before: 1 });
  assert.equal(openPersonRun(log, true)?.n, 1);
  assert.equal(openPersonRun(log, false), null);
  addCommand(log, 2, { who: "agent", name: "agent_edit", summary: "b", at: 2, rev: 3, before: 2 });
  assert.equal(openPersonRun(log, true), null);
});

const SESSION = "sheet-chat";
const app = express();
office.officeRoutes(app, { exists: (id) => id === SESSION });
const server = await new Promise<import("node:http").Server>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/officedesk/${SESSION}`;
const events: Array<{ who: string; name: string; n: number; summary: string }> = [];
office.onOfficeCommand((_s, c) => events.push({ who: c.who, name: c.name, n: c.n, summary: c.summary }));
const hooks = office.officeHooks(SESSION);
const save = (data: Buffer) => fetch(`${base}/save?kind=xlsx`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(data) });
const open = (data: Buffer, label?: string) => hooks.open({ name: "Plan.xlsx", data, working: null, source: null, outName: "Plan.xlsx", label });

try {
  await test("a workbook the agent makes begins the log", () => {
    open(book("1"), "Made the plan");
    const log = office.officeCommands(SESSION);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.name, "open");
    assert.equal(log[0]!.before, null);
    assert.equal(events.length, 1);
  });

  await test("the agent's change is a command, said as cells, with the version before it", () => {
    open(book("2"), "Changed B1");
    const log = office.officeCommands(SESSION);
    assert.equal(log.length, 2);
    assert.equal(log[1]!.who, "agent");
    assert.equal(log[1]!.name, "agent_edit");
    assert.match(log[1]!.summary, /Data!B1.*"1".*"2"/);
    assert.ok(log[1]!.before !== null);
  });

  await test("the person's typing is a command by them, and a run of it stays one command", async () => {
    assert.equal((await save(book("3"))).status, 200);
    assert.equal((await save(book("4"))).status, 200);
    const log = office.officeCommands(SESSION);
    assert.equal(log.length, 3, "two saves, one command");
    assert.equal(log[2]!.who, "person");
    assert.match(log[2]!.summary, /Data!B1.*"2".*"4"/, "said from where the run began");
  });

  await test("the agent's log shows the person's change since a revision", () => {
    const text = hooks.commandLog(0);
    assert.match(text, /#3 the person \(person_edit.*Data!B1/);
    assert.match(text, /#2 you \(agent_edit/);
    assert.ok(!hooks.commandLog(office.officeCommands(SESSION)[2]!.rev).includes("#3"));
  });

  await test("reverting goes back to just before a command, and is itself a command", () => {
    assert.equal(hooks.revert(3), null);
    assert.equal(office.xlsxCells(office.officeData(SESSION, "xlsx")!)!.get("Data!B1"), "2");
    const log = office.officeCommands(SESSION);
    assert.equal(log.at(-1)!.name, "revert");
    assert.equal(log.at(-1)!.who, "agent");
    assert.match(log.at(-1)!.summary, /before command 3/);
    assert.equal(events.at(-1)!.name, "revert");
  });

  await test("the person reverts through the route, a command the agent can read; unknown commands are refused", async () => {
    const res = await fetch(`${base}/commands/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 2 }) });
    assert.equal(res.status, 200);
    assert.equal(office.xlsxCells(office.officeData(SESSION, "xlsx")!)!.get("Data!B1"), "1");
    assert.equal(office.officeCommands(SESSION).at(-1)!.who, "person");
    assert.equal((await fetch(`${base}/commands/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 999 }) })).status, 404);
    assert.equal((await fetch(`${base}/commands/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: "x" }) })).status, 400);
    assert.match(hooks.revert(1) ?? "", /made the workbook/);
    const listed = (await (await fetch(`${base}/commands`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, office.officeCommands(SESSION).length);
  });

  const deck = (...words: string[]) => zipMany([
    ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
    ["ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree>${words.map((w) => `<p:sp><p:txBody><a:p><a:r><a:t>${w}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`],
  ]);
  const openDeck = (data: Buffer, label?: string) => hooks.open({ name: "Pitch.pptx", data, working: null, source: null, outName: "Pitch.pptx", label });
  const saveDeck = (data: Buffer) => fetch(`${base}/save?kind=pptx`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(data) });

  await test("a deck has its own log, apart from the workbook's, said in words on the slides", async () => {
    const sheetLog = office.officeCommands(SESSION).length;
    openDeck(deck("Quarterly review"), "Made the deck");
    openDeck(deck("Annual review"), "Changed the title");
    assert.equal((await saveDeck(deck("Annual review", "Thanks"))).status, 200);
    assert.equal(office.officeCommands(SESSION).length, sheetLog, "the workbook's log is untouched");
    const log = office.officeCommands(SESSION, "pptx");
    assert.deepEqual(log.map((c) => [c.name, c.who]), [["open", "agent"], ["agent_edit", "agent"], ["person_edit", "person"]]);
    assert.match(log[1]!.summary, /Annual|Quarterly/);
    const text = hooks.commandLog(0, "pptx");
    assert.match(text, /#3 the person \(person_edit/);
    assert.match(text, /#1 you \(open/);
    assert.match(text, /the deck goes back to just before it/);
  });

  await test("a deck reverts to before a command by the agent or through the route; the right window is chosen", async () => {
    assert.equal(hooks.revert(3, "pptx"), null);
    assert.equal(office.officeCommands(SESSION, "pptx").at(-1)!.name, "revert");
    const res = await fetch(`${base}/commands/revert?kind=pptx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 2 }) });
    assert.equal(res.status, 200);
    assert.match(hooks.revert(1, "pptx") ?? "", /made the deck/);
    const listed = (await (await fetch(`${base}/commands?kind=pptx`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, office.officeCommands(SESSION, "pptx").length);
    assert.match(hooks.commandLog(0), /workbook/, "with a workbook open, no kind means the workbook");
  });

  const page = (...paras: string[]) => zipMany([["word/document.xml", `<w:document><w:body>${paras.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`]]);
  const openDoc = (data: Buffer, label?: string) => hooks.open({ name: "Memo.docx", data, working: null, source: null, outName: "Memo.docx", label });
  const saveDoc = (data: Buffer) => fetch(`${base}/save?kind=docx`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(data) });

  await test("a document has its own log, said in words, and reverts like the others", async () => {
    const others = [office.officeCommands(SESSION).length, office.officeCommands(SESSION, "pptx").length];
    openDoc(page("Meet on Friday."), "Wrote the memo");
    openDoc(page("Meet on Monday."), "Changed the day");
    assert.equal((await saveDoc(page("Meet on Monday at noon."))).status, 200);
    assert.deepEqual([office.officeCommands(SESSION).length, office.officeCommands(SESSION, "pptx").length], others, "the other logs are untouched");
    const log = office.officeCommands(SESSION, "docx");
    assert.deepEqual(log.map((c) => [c.name, c.who]), [["open", "agent"], ["agent_edit", "agent"], ["person_edit", "person"]]);
    assert.match(log[1]!.summary, /Friday.*Monday/);
    assert.match(hooks.commandLog(0, "docx"), /the document goes back to just before it/);
    assert.equal(hooks.revert(3, "docx"), null);
    assert.equal(office.officeCommands(SESSION, "docx").at(-1)!.name, "revert");
    assert.equal(office.docxParagraphs(office.officeData(SESSION, "docx")!)!.join(" "), "Meet on Monday.", "back to just before the person typed");
    const res = await fetch(`${base}/commands/revert?kind=docx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 2 }) });
    assert.equal(res.status, 200);
    assert.match(hooks.revert(1, "docx") ?? "", /made the document/);
    const listed = (await (await fetch(`${base}/commands?kind=docx`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, office.officeCommands(SESSION, "docx").length);
  });

  await test("the log is kept on disk with the desk", async () => {
    const before = office.officeCommands(SESSION).length;
    assert.ok(before >= 5);
    await new Promise((r) => setTimeout(r, 1500));
    const file = path.join(process.env.AUTORA_STATE_DIR!, "worddesks", `${SESSION}-xlsx.json`);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).log.length, before);
  });
} finally {
  server.close();
}
console.log(`sheetlog: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
