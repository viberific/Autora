/**
 * A chat on a subscription CLI, through the whole server: a stand-in Claude Code streams a sentence, writes a file with its own
 * Write tool, and finishes. What the person should see: the sentence whole, then the step, then the file it made as a code
 * card (the same one the agent's own edits get), then the rest -- and the file in the chat's own folder, where the windows and
 * Artifacts look, not in a scratch folder nobody sees.
 *
 *   npm test -- e2e-subscription
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derive } from "../src/lib/derive";
import type { AutoraEvent } from "../src/lib/types";
import { startApp } from "./e2e-harness";

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "autora-e2e-sub-"));
const argvLog = path.join(bin, "argv.json");
fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const say = (o) => console.log(JSON.stringify(o));
const piece = (text) => say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
process.stdin.resume();
process.stdin.on("end", () => {
  say({ type: "stream_event", event: { type: "message_start" } });
  piece("I am making the page");
  piece(" for you right now.");
  const file = path.join(process.cwd(), "index.html");
  say({ type: "assistant", message: { content: [{ type: "text", text: "I am making the page for you right now." }, { type: "tool_use", name: "Write", input: { file_path: file } }] } });
  fs.writeFileSync(file, "<h1>Hi</h1>\\n");
  setTimeout(() => {
    say({ type: "stream_event", event: { type: "message_start" } });
    piece("Done.");
    say({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    say({ type: "result", result: "Done.", usage: { input_tokens: 5, output_tokens: 6 } });
  }, 300);
});
`, { mode: 0o755 });

const app = await startApp({ env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
let passed = 0;
try {
  await app.api("PATCH", "/api/settings", { provider: "claude-cli" });
  const session = await app.newSession("Subscription", "build");
  const events = await app.turn(session, "Make me a page.", 60_000);

  const failed = events.find((e) => e.kind === "system.error");
  assert.equal(failed, undefined, JSON.stringify(failed?.payload));

  const seen = JSON.parse(fs.readFileSync(argvLog, "utf8")) as { argv: string[]; cwd: string };
  assert.equal(path.resolve(seen.cwd), path.resolve(app.home), "it works in the chat's own folder");
  assert.ok(fs.existsSync(path.join(app.home, "index.html")));
  assert.ok(seen.argv.includes("--append-system-prompt-file"), "Autora's instructions go as the system prompt");
  assert.ok(seen.argv.includes("--include-partial-messages"), "and it streams");
  console.log("  ok  it runs in the chat's folder, streaming, with the instructions as a system prompt");
  passed += 1;

  const cells = derive(events as unknown as AutoraEvent[]).buckets.flatMap((b) => b.cells)
    .filter((c: any) => ["reply", "tool", "file"].includes(c.kind))
    .map((c: any) => (c.kind === "reply" ? `reply:${c.turn.text.trim()}` : c.kind === "tool" ? `tool:${c.span.name}` : `file:${c.file.path}`));
  assert.deepEqual(cells, ["reply:I am making the page for you right now.", "tool:Write", "file:index.html", "reply:Done."]);
  console.log("  ok  the sentence stays whole, the step and the file it made follow it, then the rest");
  passed += 1;
} finally {
  await app.stop();
  fs.rmSync(bin, { recursive: true, force: true });
}
console.log(`e2e-subscription: ${passed} passed`);
process.exit(0);
