/**
 * game_play (server/gamedesk.ts): the agent plays the game it made. The window is played by the test: it hears the request to
 * press Play and sends the files of a preview to the server, as the editor does, and the tool runs them in a real headless
 * Chromium (server/gameplay.ts). What is checked is the chain between the tool and the browser: a fresh preview is asked for and
 * waited for, an old one is said to be old, the game's own errors come back, and without a window it says what is missing.
 *
 *   npx tsx tests/gameplay-tool.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-gameplay-tool-"));
const linuxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.env.AUTORA_BROWSER_PATH && fs.existsSync(linuxChrome)) process.env.AUTORA_BROWSER_PATH = linuxChrome;

// The routes answer only when the editor is built into the server; a stand-in build is enough for the preview files.
const standIn = fs.mkdtempSync(path.join(os.tmpdir(), "autora-gameplay-build-"));
fs.mkdirSync(path.join(standIn, "dist", "gdevelop-editor"), { recursive: true });
fs.writeFileSync(path.join(standIn, "dist", "gdevelop-editor", "index.html"), "<!doctype html><title>stand-in</title>");
const here = process.cwd();
process.chdir(standIn);

const express = (await import("express")).default;
const game = await import("../server/gamedesk");
const { gameSPECS } = await import("../server/specs/game");
const { looksOnly } = await import("../server/modes");
const { probeBrowser } = await import("../server/browser");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("game_play is a tool of the game family, and looking: it changes nothing in the project", () => {
  const spec = gameSPECS.find((s) => s.name === "game_play");
  assert.ok(spec && spec.description.length > 200);
  assert.equal(spec.parameters.type, "object");
  assert.equal(looksOnly("game_play", {}), true);
});

const probe = await probeBrowser();
const missing = probe.ok ? null : (probe.detail ?? "no browser");
if (missing) {
  console.log(`  skipped the browser tests: ${missing}`);
} else {
  const S = "gameplay1";
  const app = express();
  game.gameRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/game/${S}`;
  const send = async (file: string, body: string, type: string) => {
    const res = await fetch(`${base}/preview${file}`, { method: "PUT", headers: { "Content-Type": type }, body });
    assert.equal(res.status, 200, `PUT ${file}: ${await res.text()}`);
  };

  const page = (title: string) => `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c" width="400" height="200"></canvas>
<script src="game.js"></script><!-- ${title} -->`;
  const js = `
const g = document.getElementById("c").getContext("2d");
let x = 20; const down = new Set();
addEventListener("keydown", (e) => down.add(e.key)); addEventListener("keyup", (e) => down.delete(e.key));
(function f() { if (down.has("ArrowRight")) x += 3; g.fillStyle = "#223"; g.fillRect(0,0,400,200); g.fillStyle = "#fc3"; g.fillRect(x,150,30,30); requestAnimationFrame(f); })();`;
  /** What the editor does for a preview: a folder named by the instance, files one after another. */
  const makePreview = async (instance: string, title: string, script = js) => {
    await send(`/${instance}/preview/game.js`, script, "text/javascript");
    await send(`/${instance}/preview/index.html`, page(title).replace('src="game.js"', `src="/${instance}/preview/game.js"`), "text/html");
  };
  const shown: string[] = [];
  const run = (args: Record<string, unknown>) => game.runGameTool(S, "game_play", args, { showImage: (_p, alt) => shown.push(alt) });

  try {
    await test("with no game there is nothing to play, and it says so", async () => {
      assert.equal((await run({})).ok, false);
      assert.match((await run({})).summary, /no game yet/);
    });

    await game.runGameTool(S, "game_open", { name: "Test" });

    await test("without a window to make a preview, and none made, it says what is needed", async () => {
      const out = await run({ fresh: false });
      assert.equal(out.ok, false);
      assert.match(out.summary, /no preview of the game to play/);
      assert.match(out.summary, /game window open beside the chat/);
    });

    await test("a bad script is refused before anything runs", async () => {
      const out = await run({ fresh: false, script: [{ press: "Hyperdrive" }] });
      assert.equal(out.ok, false);
      assert.match(out.summary, /not a key/);
    });

    await test("the last preview is played when fresh is off, with the picture and what the keys did", async () => {
      await makePreview("old1", "old");
      await new Promise((r) => setTimeout(r, 1500));
      const out = await run({ fresh: false, script: [{ shot: "before" }, { hold: ["ArrowRight"], ms: 600 }, { shot: "after" }], width: 400, height: 200 });
      assert.ok(out.ok, out.summary);
      assert.match(out.summary, /2 pictures \(before, after\)/);
      assert.match(out.summary, /The screen was different in the last picture/);
      assert.match(out.summary, /The game reported no errors/);
      assert.match(out.summary, /You cannot hear it/);
      assert.equal(out.images?.length, 2);
      assert.deepEqual(shown.slice(-2), ["The game: before", "The game: after"]);
    });

    await test("a preview older than the last change to the game is said to be an earlier version", async () => {
      const edited = await game.runGameTool(S, "game_edit", { ops: [{ op: "set", path: "properties.name", value: "Renamed" }] });
      assert.ok(edited.ok, edited.summary);
      const out = await run({ fresh: false });
      assert.ok(out.ok, out.summary);
      assert.match(out.summary, /changed after this preview was made/);
    });

    await test("when the window makes no new preview in time, the last one is played and the tool says so", async () => {
      game.previewWait.fresh = 1_200;
      const out = await run({});
      assert.ok(out.ok, out.summary);
      assert.match(out.summary, /did not make a new preview in time/);
      assert.match(out.summary, /changed after this preview was made/, "and that it is of an earlier game");
    });

    await test("fresh asks the window to press Play and plays the preview it makes, not the old one", async () => {
      game.previewWait.fresh = 20_000;
      const asked: string[] = [];
      game.onGamePlayRequest((id) => {
        asked.push(id);
        // The window presses Play; the editor builds and sends a new preview a moment later, one file after another.
        setTimeout(() => void makePreview("new2", "fresh", js + "\nconsole.error('this is the fresh one');"), 600);
      });
      const out = await run({ script: [{ wait: 300 }] });
      assert.deepEqual(asked, [S]);
      assert.ok(out.ok, out.summary);
      assert.match(out.summary, /this is the fresh one/, "the new instance was played");
      assert.doesNotMatch(out.summary, /changed after this preview was made/, "and it is of the current game");
      assert.doesNotMatch(out.summary, /did not make a new preview/);
    });

    await test("the game's own errors come back as findings", async () => {
      await makePreview("bad3", "broken", "throw new Error('no player object');");
      const out = await run({ fresh: false });
      assert.ok(out.ok, out.summary);
      assert.match(out.summary, /The game reported 1 problem/);
      assert.match(out.summary, /no player object/);
    });
  } finally {
    server.close();
    game.dropGame(S);
    process.chdir(here);
  }
}
console.log(`gameplay-tool: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
