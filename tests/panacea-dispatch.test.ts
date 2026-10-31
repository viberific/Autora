import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../server/tools";
import { newCanvas } from "../src/lib/panacea/canvas";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-dispatch-"));
process.env.AUTORA_STATE_DIR = path.join(dir, "state");
process.env.AUTORA_WORKDIR = dir;
const { findTool, runTool } = await import("../server/tools");
const { panaceaState } = await import("../server/panacea");
const { flushState, state } = await import("../server/state");
const spec = findTool("panacea_surface");
assert.ok(spec);
const ctx: ToolContext = {
  onOutput: () => undefined,
  putBlob: () => "blob",
  showImage: () => undefined,
  showWidget: () => undefined,
  showScreen: () => undefined,
  browser: () => { throw new Error("no browser in this import test"); },
  browserChanged: () => undefined,
  watchDesktop: () => undefined,
  cancelled: () => false,
  onCancel: () => undefined,
  memory: {
    write: () => ({ id: "memory", action: "add" }),
    search: () => [],
    update: () => false,
    confirm: () => false,
    forget: () => false,
    link: () => null,
  },
  vault: () => null,
  session: "panacea-dispatch",
  ask: async () => ({ cancelled: true, choices: [], text: "", who: "" }),
};
const file = (name: string, data: string) => {
  const full = path.join(dir, name);
  fs.writeFileSync(full, data);
  return full;
};
const csv = file("table.csv", "Item,Amount\nA,2\nB,3");
const native = await runTool(spec, { file: csv }, ctx);
assert.equal(native.ok, true, native.summary);
assert.equal(panaceaState(ctx.session).surfaces, 1, "CSV retains native canvas behavior");

state.tools.pdf.enabled = false;
const pdf = await runTool(spec, { file: file("document.pdf", "invalid PDF") }, ctx);
assert.equal(pdf.ok, false);
assert.match(pdf.summary, /pdf engine is disabled or unavailable/);
state.tools.pdf.enabled = true;
state.tools.studio.enabled = false;
const song = await runTool(spec, { file: file("example.song.json", "{}") }, ctx);
assert.equal(song.ok, false);
assert.match(song.summary, /studio engine is disabled or unavailable/);
state.tools.studio.enabled = true;
const workbookFile = file("table.xlsx", "invalid workbook");
const workbook = await runTool(spec, { file: workbookFile }, ctx);
assert.equal(workbook.ok, false);
assert.match(workbook.summary, /sheets engine is disabled or unavailable/, "a workbook must not silently flatten into a readonly data view");
const explicitWorkbook = await runTool(spec, { file: workbookFile, engine: "sheets" }, ctx);
assert.equal(explicitWorkbook.ok, false);
assert.match(explicitWorkbook.summary, /sheets engine is disabled or unavailable/);

const midi = await runTool(spec, { file: file("notes.mid", "not MIDI") }, ctx);
assert.equal(midi.ok, false);
assert.match(midi.summary, /not-supported/);
const ambiguous = await runTool(spec, { file: file("settings.json", '{"app":{}}') }, ctx);
assert.equal(ambiguous.ok, false);
assert.match(ambiguous.summary, /ambiguous-json/);
const invalid = await runTool(spec, { file: file("invalid.json", "{") }, ctx);
assert.equal(invalid.ok, false);
assert.match(invalid.summary, /not valid JSON/);
const wrongEngine = await runTool(spec, { file: csv, engine: "pdf" }, ctx);
assert.equal(wrongEngine.ok, false, "mismatched engine requests are explicit errors");
const conflicting = await runTool(spec, { file: csv, engine: "sheets", native: true }, ctx);
assert.equal(conflicting.ok, false);
assert.match(conflicting.summary, /not both/);
const conflictingFalse = await runTool(spec, { file: csv, engine: "sheets", native: false }, ctx);
assert.equal(conflictingFalse.ok, false);
assert.match(conflictingFalse.summary, /not both/);
const invalidNative = await runTool(spec, { file: csv, native: "false" }, ctx);
assert.equal(invalidNative.ok, false);
assert.match(invalidNative.summary, /must be true or false/);

const canvas = file("saved.panacea.json", JSON.stringify(newCanvas("Saved")));
const protectedCanvas = await runTool(spec, { file: canvas }, ctx);
assert.equal(protectedCanvas.ok, false);
assert.match(protectedCanvas.summary, /replace:true/);
assert.equal(panaceaState(ctx.session).surfaces, 1, "refusing replacement preserves current work");
const loaded = await runTool(spec, { file: canvas, replace: true }, ctx);
assert.equal(loaded.ok, true, loaded.summary);
assert.equal(panaceaState(ctx.session).name, "Saved");
ctx.memory.incognito = true;
const privateCall = await runTool(spec, { file: "missing.pdf" }, ctx);
assert.equal(privateCall.ok, false);
assert.match(privateCall.summary, /incognito/);
flushState();
console.log("Panacea dispatch: native formats, capability gating, explicit unsupported formats, safe replacement and incognito verified");
process.exit(0);
