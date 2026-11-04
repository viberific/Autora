/**
 * What the PDF bar shows: nothing with no document open; with one, the tools a document is for, and Erase, Fill fields and Organize
 * only when there are marks, fields or several pages; a tool in use or reached for stays; everything stays in the grid.
 *
 *   npx tsx tests/pdf-rail.test.ts
 */
import assert from "node:assert/strict";
import { DESKTOP_DEFAULT, GRID, PHONE_DEFAULT, TOOLS } from "../spectra-editor/src/autora/rail-tools";
import { HOLD_MS, NO_WORK, holdWork, needed, type Open, type Work } from "../spectra-editor/src/autora/rail-need";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const open = (over: Partial<Open> = {}, work: Partial<Work> = {}): Open => ({ mode: "select", tool: null, ...over, work: { doc: true, pages: 1, marks: false, fields: false, ...work } });
const bar = (o: Open, used: string[] = [], ids = DESKTOP_DEFAULT) => ids.filter((id) => needed(TOOLS[id]!, o, new Set(used)));

test("with no document open the bar has no tools, only All tools", () => {
  assert.deepEqual(bar({ mode: "select", tool: null, work: NO_WORK }), []);
  assert.deepEqual(bar({ mode: "freetext", tool: null, work: NO_WORK }), [], "not even an armed tool");
});

test("a one-page document with no marks or fields has the tools a document is for, and nothing specialist", () => {
  assert.deepEqual(bar(open()), ["select", "text", "highlight", "draw", "shape", "note", "redact", "sign", "edit"]);
  for (const id of ["erase", "forms", "organize", "stamp", "callout", "measure", "link", "addimage", "inkhighlight"]) assert.ok(!bar(open()).includes(id), `${id} is not needed yet`);
});

test("Erase comes with marks, Fill fields with fields on the page, Organize with more than one page", () => {
  assert.ok(bar(open({}, { marks: true })).includes("erase"));
  assert.ok(bar(open({}, { fields: true })).includes("forms"));
  assert.ok(bar(open({}, { pages: 3 })).includes("organize"));
  assert.ok(!bar(open({}, { pages: 1 })).includes("organize"));
});

test("a tool in use stays whatever the document has, and one the person has reached for stays after", () => {
  assert.ok(bar(open({ mode: "stamp" })).includes("stamp"), "armed");
  assert.ok(bar(open({ mode: "select", tool: "measure" })).includes("measure"), "its pane is open");
  assert.ok(!bar(open()).includes("callout"));
  assert.ok(bar(open(), ["callout", "measure"]).includes("callout") && bar(open(), ["callout", "measure"]).includes("measure"), "used earlier");
  assert.ok(bar(open({ mode: "inkerase" })).includes("erase"), "Erase armed with no marks left is not pulled from under the pointer");
});

test("a phone's default tools are all there for a document", () => {
  assert.deepEqual(bar(open(), [], PHONE_DEFAULT), PHONE_DEFAULT);
});

test("every tool is in exactly one grid section, so nothing the bar leaves out is lost", () => {
  const inGrid = GRID.flatMap((g) => g.ids);
  assert.equal(new Set(inGrid).size, inGrid.length);
  assert.deepEqual([...inGrid].sort(), Object.keys(TOOLS).sort());
});

test("a document that seems to have gone for a beat is held, so the bar does not fade out and back after a save", () => {
  const had: Work = { doc: true, pages: 3, marks: true, fields: true };
  const first = holdWork(had, null, 1000);
  assert.deepEqual(first.work, had);
  const blink = holdWork(NO_WORK, first.seen, 1500);
  assert.deepEqual(blink.work, had, "a blink of no document, no marks, no fields");
  assert.equal(blink.seen, first.seen, "the held reading is not renewed by the blink");
  const gone = holdWork(NO_WORK, blink.seen, 1000 + HOLD_MS);
  assert.deepEqual(gone.work, NO_WORK, "a document that is still gone after the hold is really gone");
  const fewer = holdWork({ ...had, marks: false }, first.seen, 1200);
  assert.equal(fewer.work.marks, true, "marks that vanish for a beat are held too");
  const more = holdWork({ ...had, pages: 5 }, first.seen, 1200);
  assert.equal(more.work.pages, 5, "a gain is taken at once");
});

console.log("pdf rail tests passed");
