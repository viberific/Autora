/**
 * A delegate to a vendor's CLI (claude_cli, gemini_cli) is offered to the model only when that CLI is installed here. Offered
 * without it, every call fails: in the logs they were the tools that failed 100% of the time.
 *
 *   npx tsx tests/delegates-offered.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-delegates-"));
process.env.AUTORA_STATE_DIR = dir;
process.env.AUTORA_CLAUDE_CLI = path.join(dir, "no-claude");
process.env.AUTORA_GEMINI_CLI = path.join(dir, "no-gemini");

const { availableTools } = await import("../server/tools");
const names = async () => (await availableTools()).map((t) => t.name);

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("with neither CLI installed, neither delegate is offered", async () => {
  const have = await names();
  assert.ok(!have.includes("claude_cli"), "claude_cli is not offered");
  assert.ok(!have.includes("gemini_cli"), "gemini_cli is not offered");
  assert.ok(have.includes("terminal"), "the rest of the tools are");
});

await test("each is offered once its own CLI is there, and only that one", async () => {
  const wrapper = path.join(dir, "claude-call.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.AUTORA_CLAUDE_CLI = wrapper;
  const have = await names();
  assert.ok(have.includes("claude_cli"), "claude_cli is offered");
  assert.ok(!have.includes("gemini_cli"), "gemini_cli still is not");
});

console.log(`delegates offered: ${passed} passed`);
process.exit(0);
