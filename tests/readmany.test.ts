/**
 * read_file with several places in one call (files): one round instead of one per file.
 *
 *   npx tsx tests/readmany.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../server/tools";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "autora-readmany-"));
process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-readmany-state-"));
process.env.AUTORA_WORKDIR = work;
const { findTool, runTool } = await import("../server/tools");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

fs.writeFileSync(path.join(work, "a.ts"), "export function one() {\n  return 1;\n}\n");
fs.writeFileSync(path.join(work, "b.ts"), "line 1\nline 2\nline 3\n");
const ctx = { onOutput: () => undefined, cancelled: () => false, protectedPaths: [] } as unknown as ToolContext;
const read = (args: Record<string, unknown>) => runTool(findTool("read_file")!, args, ctx);

console.log("read_file, several at once");

await test("each place is read as its own call would read it, in order", async () => {
  const out = await read({ files: [{ path: "a.ts", symbol: "one" }, { path: "b.ts", start: 2, end: 3 }] });
  assert.equal(out.ok, true);
  assert.match(out.summary, /function one, lines 1-3 of a\.ts/);
  assert.match(out.summary, /b\.ts \(3 lines\), lines 2-3:\n2 {2}line 2\n3 {2}line 3/);
  assert.ok(out.summary.indexOf("a.ts") < out.summary.indexOf("b.ts"));
});

await test("a missing file says so without failing the rest", async () => {
  const out = await read({ files: [{ path: "nope.ts" }, { path: "b.ts" }] });
  assert.equal(out.ok, true);
  assert.match(out.summary, /There is no file/);
  assert.match(out.summary, /line 1/);
});

await test("at most eight in a call, and it says what it left", async () => {
  const out = await read({ files: Array.from({ length: 10 }, () => ({ path: "b.ts", end: 1 })) });
  assert.match(out.summary, /\(2 more not read: at most 8 in one call\.\)/);
});

await test("a single path works as before", async () => {
  const out = await read({ path: "b.ts" });
  assert.match(out.summary, /^b\.ts \(3 lines\), lines 1-3/);
});

fs.rmSync(work, { recursive: true, force: true });
console.log(`${passed} passed`);
