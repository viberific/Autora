#!/usr/bin/env node
// PreToolUse hook for Edit/Write. Deterministic guardrail for paths CLAUDE.md says never to hand-edit.
//  - fetched upstream checkouts (gitignored, rebuilt by scripts/prepare-*.mjs): blocked, exit 2
//  - */PIN.json (each is one exact upstream commit that never follows upstream): the person is asked
//  - .env files (secrets): blocked
// Exit 2 blocks and the stderr message goes back to the agent, so it says where the change belongs.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
const file = String(input.tool_input?.file_path ?? "");
if (!file) process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");

const fetched = [
  ["spectra-editor/src/renderer/", "spectra-editor/overlay/"],
  ["opencut-editor/src/web/", "opencut-editor/overlay/"],
  ["opencut-editor/src/web-public/", "opencut-editor/overlay/"],
  ["gdevelop-editor/work/", "gdevelop-editor/overlay/"],
];
for (const [dir, home] of fetched) {
  if (rel.startsWith(dir)) {
    process.stderr.write(`Blocked: ${rel} is a fetched, gitignored upstream checkout that is rebuilt from its pin. Make the change in ${home} (an overlay or patch) instead.` + "\n");
    process.exit(2);
  }
}
if (/(^|\/)\.env(\.(?!example$)[^/]+)?$/.test(rel)) {
  process.stderr.write(`Blocked: ${rel} holds secrets. Edit .env.example for documentation; never write real values.` + "\n");
  process.exit(2);
}
if (/(^|\/)PIN\.json$/.test(rel)) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
    permissionDecisionReason: `${rel} pins one exact upstream commit and never moves to follow upstream (CLAUDE.md). Confirm this edit is Autora's own change.` } }));
}
