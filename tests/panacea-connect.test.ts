/**
 * Connecting pieces of work on the board, and the canvas keeping itself in order: pure rules, no browser.
 *
 *   npx tsx tests/panacea-connect.test.ts
 */
import assert from "node:assert/strict";
import { estimateHeight, newCanvas, placeFor } from "../src/lib/panacea/canvas";
import { createDoc } from "../src/lib/panacea/document";
import { whyUnsupported } from "../src/lib/panacea/file-formats";
import { engineSends, keepRoute, surfaceSends, takersOf } from "../src/lib/panacea/flows";
import { BUILTINS } from "../src/lib/panacea/library";
import { addSurfaceTo } from "../src/lib/panacea/rules";
import { looksTabular } from "../src/lib/panacea/surfaces";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const find = (id: string) => BUILTINS.find((r) => r.id === id);

test("a native surface sends the file it is kept as, and only apps that open that file can take it", () => {
  const picture = surfaceSends("image", "Sunset")!;
  assert.deepEqual(picture, { name: "Sunset.png", mime: "image/png" });
  // The person's example: a picture being edited goes to the video editor (and Images, and Games), never to Music.
  assert.deepEqual(takersOf(picture, "panacea").sort(), ["game", "photo", "video"]);
  assert.deepEqual(surfaceSends("data", "Sales"), { name: "Sales.csv", mime: "text/csv" });
  assert.deepEqual(surfaceSends("doc", ""), { name: "Untitled.md", mime: "text/markdown" });
  assert.equal(surfaceSends("nothing", "x"), null);
  // No app opens a CSV or Markdown file, so a table and a page have nowhere to be sent: they get no node.
  assert.deepEqual(takersOf(surfaceSends("data", "Sales")!, "panacea"), []);
  assert.deepEqual(takersOf(surfaceSends("doc", "Plan")!, "panacea"), []);
});

test("an app's window sends what its own Save keeps, never to itself; apps with no such file are not sent from", () => {
  assert.deepEqual(takersOf(engineSends("photo")!, "photo").sort(), ["game", "video"]);
  assert.deepEqual(takersOf(engineSends("cad")!, "cad"), ["game"]);
  assert.equal(keepRoute("photo", "s 1"), "/api/photo/s%201/keep");
  for (const mode of ["pdf", "video", "browser", "app", "pages", "sheets", "slides", "panacea"] as const) {
    assert.equal(engineSends(mode), null, mode);
    assert.equal(keepRoute(mode, "s"), null, mode);
  }
});

test("pasted rows are a table and pasted words are a page", () => {
  assert.equal(looksTabular("month,amount\nJan,10\nFeb,14"), true);
  assert.equal(looksTabular("Name\tScore\tNote\nÅsa 😀\t12\tfirst\nBjörn\t\tmissing\n\"Quoted, name\"\t7"), true, "ragged rows with tabs are still rows");
  assert.equal(looksTabular("a;b\n1;2\n3;4"), true);
  assert.equal(looksTabular("only\none\ncolumn"), false);
  assert.equal(looksTabular("Dear team,\nThanks for yesterday. It went well, I think.\nMore soon."), false, "prose with the odd comma");
  assert.equal(looksTabular("one line, with a comma"), false);
});

test("a refusal says what the canvas opens, never the route's own code", () => {
  const why = whyUnsupported("archive.zip", "not-supported");
  assert.match(why, /nothing that opens archive\.zip/);
  assert.match(why, /pictures, tables/);
  for (const reason of ["not-supported", "ambiguous-json", "engine-mismatch", "resolve-name", "invalid-options"]) {
    assert.doesNotMatch(whyUnsupported("x.bin", reason), /not-supported|ambiguous-json|engine-mismatch|resolve-name|invalid-options/);
  }
});

test("new work is not put down on an app's window, and a maximised window counts as where it goes back to", () => {
  const c = newCanvas();
  c.windows = [{ id: "engine:studio", x: 0, y: 0, w: 800, h: 600, z: 1 }];
  const at = placeFor(c, 300, 200);
  const hit = at.x < 800 && at.x + 300 > 0 && at.y < 600 && at.y + 200 > 0;
  assert.equal(hit, false, JSON.stringify(at));
  c.windows = [{ id: "engine:studio", x: -5000, y: -5000, w: 20000, h: 20000, z: 1, was: { x: 0, y: 0, w: 800, h: 600 } }];
  const again = placeFor(c, 300, 200);
  assert.ok(Math.abs(again.x) < 3000 && Math.abs(again.y) < 3000, `placed near the work, not past a maximised window (${JSON.stringify(again)})`);
});

test("several things arriving together bring one offer between them, not one each", () => {
  const c = newCanvas();
  for (let i = 0; i < 5; i += 1) {
    const made = addSurfaceTo(c, { kind: "doc", name: `Doc ${i}.md`, title: `Doc ${i}`, doc: createDoc(`# Doc ${i}`, "guide") }, find);
    assert.ok(!("error" in made), JSON.stringify(made));
  }
  assert.equal(c.surfaces.length, 5);
  assert.equal(c.panels.filter((p) => p.state === "ghost").length, 1);
});

test("a panel with controls behind More is given room for the More row", () => {
  const plain = { atom: "stack" as const, children: [{ atom: "slider" as const, bind: "a" }, { atom: "slider" as const, bind: "b" }] };
  const more = { atom: "stack" as const, children: [...plain.children, { atom: "slider" as const, bind: "c", advanced: true }] };
  assert.equal(estimateHeight(more), estimateHeight(plain) + 34);
});

console.log(`${passed} panacea-connect tests passed`);
