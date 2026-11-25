/**
 * The host clipboard is a file under /data/settings. Point it at a scratch
 * folder rather than the real one, so a test run cannot overwrite what the
 * person has copied.
 *
 *   npx tsx tests/clipboard.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "clip-"));
const file = join(dir, "clipboard.txt");
// The path is read when the module loads, so it is set before the import.
process.env.AUTORA_CLIPBOARD_FILE = file;

const { copyText, describeClip, hostClipboard } = await import("../server/clipboard");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

await test("copies to the host and reads it back", () => {
  const done = copyText("hello there", "host");
  assert.equal(done.place, "host");
  assert.equal(done.chars, 11);
  assert.equal(hostClipboard().text, "hello there");
});

await test("says how much was copied without repeating a long text", () => {
  const said = describeClip(copyText("x".repeat(900), "host"), "copied");
  assert.match(said, /900 characters/);
  assert.ok(said.length < 200, said);
});

await test("says plainly when a clipboard is empty", () => {
  rmSync(file, { force: true });
  assert.match(describeClip(hostClipboard(), "pasted"), /Nothing on the host clipboard/);
});

await test("shows the start of what was pasted, and says where from", () => {
  copyText("a token for GitHub", "host");
  const said = describeClip(hostClipboard(), "pasted");
  assert.match(said, /a token for GitHub/);
  assert.match(said, /host clipboard/);
});

await test("cuts text longer than the limit and says so", () => {
  const done = copyText("y".repeat(250_000), "host");
  assert.equal(done.text.length, 200_000);
  assert.equal(done.truncated, true);
  assert.match(describeClip(done, "copied"), /cut/);
});

await test("keeps the file on disk, so it survives a restart", () => {
  copyText("durable", "host");
  assert.equal(readFileSync(file, "utf8"), "durable");
});

rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed`);
process.exit(0);
