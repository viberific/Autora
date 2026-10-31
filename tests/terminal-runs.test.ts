import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../server/tools";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-terminal-runs-"));
process.env.AUTORA_STATE_DIR = path.join(dir, "state");
process.env.AUTORA_WORKDIR = dir;

const { findTool, runTool, terminalDir, updateToolSettings } = await import("../server/tools");
const { flushState, state } = await import("../server/state");
const root = path.join(import.meta.dirname, "..");
const spec = findTool("terminal");
assert.ok(spec, "shell execution remains available without a terminal window");
assert.match(spec.description, /collapsible chat entry/);
for (const name of ["panacea_open", "office_open", "pdf_read", "video_open", "studio_open", "cad_scene_get", "game_open", "photo_open", "app_preview", "browser_open"]) {
  assert.ok(findTool(name), `${name}: preserve the engine's ability`);
}

const output: string[] = [];
const ctx: ToolContext = {
  onOutput: (chunk) => { output.push(chunk); },
  putBlob: () => "blob",
  showImage: () => undefined,
  showWidget: () => undefined,
  showScreen: () => undefined,
  browser: () => { throw new Error("no browser in this shell test"); },
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
  session: "terminal-runs",
  ask: async () => ({ cancelled: true, choices: [], text: "", who: "" }),
};

assert.equal(terminalDir(), dir);
const configured = path.join(dir, "configured");
fs.mkdirSync(configured);
updateToolSettings({ terminal: { cwd: configured } });
assert.equal(terminalDir(), configured);
for (const visible of [false, true]) {
  state.agentCursor = visible;
  const outcome = await runTool(spec, { command: "echo output", cwd: "missing" }, ctx);
  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /does not exist on this machine/);
  assert.ok(outcome.summary.includes(path.join(configured, "missing")), "relative cwd starts from configured shell directory");
  assert.doesNotMatch(outcome.summary, /Terminal window|typed into the shell/);
}
assert.deepEqual(output, []);
if (process.platform !== "win32" || process.env.AUTORA_SHELL) {
  output.length = 0;
  const outcome = await runTool(spec, { command: 'node -e "console.log(process.cwd())"' }, ctx);
  assert.equal(outcome.ok, true, outcome.summary);
  assert.equal(fs.realpathSync(output.join("").trim()), fs.realpathSync(configured), "a login shell must not change the requested cwd");
} else {
  console.log("working-shell check skipped: set AUTORA_SHELL to an installed shell on Windows");
}
const server = fs.readFileSync(path.join(root, "server.ts"), "utf8");
assert.doesNotMatch(server, /termRoutes|termUpgrade|termdesk/);
assert.equal(fs.existsSync(path.join(root, "server", "termdesk.ts")), false);
flushState();
console.log("terminal runs: shell capability preserved; no standalone PTY routes; configured cwd and Visible behavior verified");
process.exit(0);
