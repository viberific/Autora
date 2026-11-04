/**
 * The parity matrix for the hosted editors: server/capabilities.ts is the one table, and every other place that names an editor
 * (the Tools page switch, the manual, the tool families, what Load opens, Visible work, the workspace modes, the desks) must
 * agree with it. A new editor, or a changed one, that is not in step fails here by name.
 *
 *   npx tsx tests/capabilities.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-caps-"));

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const { CAPABILITIES, capabilityOf } = await import("../server/capabilities");
const { findTool, toolSettings, windowOff } = await import("../server/tools");
const { FAMILIES } = await import("../server/toolload");
const { manualId, manualText } = await import("../server/handbook");
const { DESKS } = await import("../server/desks");
const { loadable, LOAD_APPS } = await import("../src/lib/loadable");
const { WORKSPACE_MODES } = await import("../src/lib/workspace");
const specs = [
  ...(await import("../server/specs/files")).filesSPECS, ...(await import("../server/specs/video")).videoSPECS, ...(await import("../server/specs/studio")).studioSPECS,
  ...(await import("../server/specs/cad")).cadSPECS, ...(await import("../server/specs/game")).gameSPECS, ...(await import("../server/specs/photo")).photoSPECS,
];
const TOOLS = specs;

const visibleWork = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "VISIBLE-WORK.md"), "utf8");
const rowOf = (label: string) => visibleWork.split("\n").find((l) => l.startsWith(`| ${label} |`));

await test("every editor has tools under its prefix, and the prefix finds it", () => {
  for (const c of CAPABILITIES) {
    const mine = TOOLS.filter((t) => t.name.startsWith(`${c.id}_`));
    assert.ok(mine.length > 0, `${c.id} has no tools`);
    assert.ok(mine.every((t) => capabilityOf(t.name)?.id === c.id));
    assert.equal(findTool(mine[0]!.name)?.name, mine[0]!.name);
  }
  assert.equal(capabilityOf("panacea_look"), undefined, "Panacea itself is not a hosted editor");
  assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, CAPABILITIES.length);
});

await test("each editor's manual exists and the tool prefix leads to it", () => {
  for (const c of CAPABILITIES) {
    assert.equal(manualId(`${c.id}_x`), c.id);
    const text = manualText(c.id);
    assert.ok(text.length > 500, `${c.id}'s manual is missing`);
    assert.ok(text.startsWith(`Panacea · ${c.workMode}.`), `${c.id}'s manual says ${text.slice(0, 40)}`);
  }
});

await test("a manual says every format the editor saves", () => {
  for (const c of CAPABILITIES) {
    const text = manualText(c.id).toLowerCase();
    for (const ext of c.saves) assert.ok(text.includes(ext.toLowerCase()), `the ${c.id} manual never mentions ${ext}`);
  }
});

await test("the tool families match each editor's tools and nothing else's", () => {
  for (const c of CAPABILITIES) {
    const family = FAMILIES.find((f) => f.id === c.id);
    assert.ok(family, `no tool family for ${c.id}`);
    assert.ok(family!.match(`${c.id}_x`));
    for (const other of CAPABILITIES.filter((o) => o.id !== c.id)) assert.ok(!family!.match(`${other.id}_x`), `${c.id}'s family claims ${other.id}'s tools`);
  }
});

await test("the Tools page switch turns an editor's tools off when all of its switches are off; one switch on is as good as all", () => {
  const all = toolSettings();
  const switches = (c: (typeof CAPABILITIES)[number], on: string[]) => Object.fromEntries(c.windows.map((w) => [w, { enabled: on.includes(w) }]));
  for (const c of CAPABILITIES) {
    assert.equal(windowOff(`${c.id}_x`, { ...all, ...switches(c, []) }), true, `${c.id} stays on with its switches off`);
    const everyOn = windowOff(`${c.id}_x`, { ...all, ...switches(c, c.windows) });
    for (const w of c.windows) {
      assert.equal(windowOff(`${c.id}_x`, { ...all, ...switches(c, [w]) }), everyOn, `${c.id}: the ${w} switch alone should be enough`);
    }
  }
  assert.equal(windowOff("panacea_look", { ...all, panacea: { enabled: false } }), true, "Panacea's own switch still works");
  assert.equal(windowOff("terminal", all), false, "and a tool of no editor is never switched off by one");
});

await test("what a window opens agrees with what Load accepts", () => {
  const apps: Record<string, string[]> = { pdf: ["pdf"], video: ["video"], studio: ["studio"], office: ["pages", "sheets", "slides"], cad: ["cad"], game: ["game"], photo: ["photo"] };
  for (const c of CAPABILITIES) {
    for (const app of apps[c.id]!) assert.ok((LOAD_APPS as string[]).includes(app), `${app} is not a Load app`);
    for (const ext of c.opens) {
      assert.ok(apps[c.id]!.some((a) => loadable(a as never, { name: `file.${ext}`, mime: "" })), `${c.id} lists ${ext} but Load refuses it`);
    }
    assert.ok(!apps[c.id]!.some((a) => loadable(a as never, { name: "file.zzz", mime: "" })), `${c.id}'s Load takes anything`);
  }
});

await test("Visible work: live editors are described as live, and a gap as not here yet", () => {
  const rows: Record<string, string> = { pdf: "PDF", video: "Video", studio: "Music", office: "Pages, Sheets, Slides", cad: "3D", game: "Games", photo: "Photo" };
  for (const c of CAPABILITIES) {
    const row = rowOf(rows[c.id]!);
    assert.ok(row, `docs/VISIBLE-WORK.md has no row for ${rows[c.id]}`);
    const cell = row!.split("|")[2]!.trim();
    assert.ok(c.hand === "live" ? /^Live/.test(cell) : /^Not here yet/.test(cell), `${c.id} says ${c.hand} but the doc says: ${cell.slice(0, 50)}`);
  }
});

await test("the workspace's modes and the desks are all accounted for", () => {
  const native = new Set(["panacea", "app", "browser", "widget"]);
  const claimed = new Set(CAPABILITIES.flatMap((c) => c.modes));
  for (const mode of claimed) assert.ok(mode in WORKSPACE_MODES, `${mode} is not a workspace mode`);
  for (const mode of Object.keys(WORKSPACE_MODES)) assert.ok(claimed.has(mode) || native.has(mode), `workspace mode ${mode} belongs to no editor`);
  for (const d of DESKS) assert.ok(CAPABILITIES.some((c) => c.id === d.id), `desk ${d.id} is not a capability`);
});

console.log("capabilities tests passed");
