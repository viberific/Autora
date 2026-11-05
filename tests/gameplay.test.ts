/**
 * Playing a game so the agent can see it (server/gameplay.ts): the script is checked and clamped, and a game's preview files are
 * played in an isolated headless Chromium that can reach only its own files, with keys, clicks and waits, and what it looked like
 * comes back as pictures, with the errors it threw and whether the screen moved. The game here is a few lines of canvas, not
 * GDevelop's runtime: what is tested is the machinery around it, with a real browser.
 *
 *   npx tsx tests/gameplay.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-gameplay-"));
const linuxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.env.AUTORA_BROWSER_PATH && fs.existsSync(linuxChrome)) process.env.AUTORA_BROWSER_PATH = linuxChrome;

const { parseSteps, playPreview, MAX_PLAY_MS, MAX_STEPS, MAX_SHOTS } = await import("../server/gameplay");
const { probeBrowser } = await import("../server/browser");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("a script is checked: keys, waits and shots are clamped, and a bad step says which", () => {
  assert.deepEqual(parseSteps(undefined), { steps: [] });
  const ok = parseSteps([{ press: "Space" }, { hold: ["ArrowRight", "d"], ms: 400 }, { wait: 250 }, { click: [10.4, 20.6] }, { shot: "after the jump" }]);
  assert.deepEqual(ok.steps, [{ press: "Space", ms: 120 }, { hold: ["ArrowRight", "d"], ms: 400 }, { wait: 250 }, { click: [10, 21] }, { shot: "after the jump" }]);
  assert.match(parseSteps([{ press: "Hyperdrive" }]).error ?? "", /step 1: "Hyperdrive" is not a key/);
  assert.match(parseSteps([{ wait: 10 }, { dance: true }]).error ?? "", /step 2 is none of/);
  assert.match(parseSteps([{ hold: [], ms: 5 }]).error ?? "", /1 to 4 keys/);
  assert.match(parseSteps([{ click: [1] }]).error ?? "", /click is \[x, y\]/);
  assert.match(parseSteps("jump").error ?? "", /list of steps/);
  assert.match(parseSteps(new Array(MAX_STEPS + 1).fill({ wait: 1 })).error ?? "", /At most 60 steps/);
  assert.match(parseSteps(new Array(MAX_SHOTS + 1).fill({ shot: "x" })).error ?? "", /At most 8 pictures/);
  assert.match(parseSteps([{ wait: MAX_PLAY_MS }, { wait: MAX_PLAY_MS }]).error ?? "", /more than 30 seconds together/);
  assert.deepEqual(parseSteps([{ wait: 9e9 }]).steps, [{ wait: MAX_PLAY_MS }], "one wait is clamped");
});

const probe = await probeBrowser();
const missing = probe.ok ? null : (probe.detail ?? "no browser");
if (missing) {
  console.log(`  skipped the browser tests: ${missing}`);
} else {
  // A game in a few lines: a square that moves right while ArrowRight is held and jumps on Space; it reports a click to the
  // console, loads a script from its own files, and throws when asked to by a key.
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c" width="400" height="200"></canvas>
<script src="game.js"></script>`;
  const game = `
const c = document.getElementById("c"), g = c.getContext("2d");
let x = 20, y = 150, vy = 0;
const down = new Set();
addEventListener("keydown", (e) => { down.add(e.key); if (e.key === " " && y >= 150) vy = -9; if (e.key === "x") throw new Error("the player fell out of the world"); });
addEventListener("keyup", (e) => down.delete(e.key));
addEventListener("click", (e) => console.error("clicked at " + e.clientX + "," + e.clientY));
(function frame() {
  if (down.has("ArrowRight")) x += 3;
  vy += 0.5; y = Math.min(150, y + vy); if (y >= 150) vy = 0;
  g.fillStyle = "#223"; g.fillRect(0, 0, 400, 200);
  g.fillStyle = "#fc3"; g.fillRect(x, y, 30, 30);
  requestAnimationFrame(frame);
})();`;
  const still = `<!doctype html><body style="margin:0;background:#123"><div style="width:100px;height:100px;background:#fc3"></div>`;
  const files = (index: string, js?: string) => new Map<string, { bytes: Buffer; type: string }>([
    ["/abc/preview/index.html", { bytes: Buffer.from(index), type: "text/html" }],
    ...(js ? [["/abc/preview/game.js", { bytes: Buffer.from(js), type: "text/javascript" }] as const] : []),
  ]);
  // The whole of this happens in the isolated context, which the game's own address (https://game.autora.invalid) is served in.
  const play = (f: ReturnType<typeof files>, steps: ReturnType<typeof parseSteps>["steps"]) => playPreview(f, "/abc/preview/index.html", steps, { width: 400, height: 200 });
  const rootHtml = html.replace('src="game.js"', 'src="/abc/preview/game.js"');

  await test("a game is played: it starts, the keys move it, and the pictures show where it was", async () => {
    const out = await play(files(rootHtml, game), parseSteps([{ shot: "before" }, { hold: ["ArrowRight"], ms: 600 }, { shot: "after" }]).steps);
    assert.deepEqual(out.shots.map((s) => s.label), ["before", "after"]);
    assert.ok(out.shots.every((s) => s.png.subarray(0, 4).toString("hex") === "89504e47"), "pictures are PNGs");
    assert.equal(out.changed, true, "the square moved");
    assert.deepEqual(out.problems, []);
    assert.ok(out.frames > 20, `${out.frames} frames drawn`);
  });

  await test("with no shot in the script, one is taken at the start and one at the end", async () => {
    const out = await play(files(rootHtml, game), []);
    assert.deepEqual(out.shots.map((s) => s.label), ["start", "end"]);
    assert.equal(out.changed, false, "nothing was pressed, nothing moved");
  });

  await test("a game that does nothing when keys are pressed is told apart from one that moves", async () => {
    const out = await play(files(still), parseSteps([{ hold: ["ArrowRight", "Space"], ms: 400 }]).steps);
    assert.equal(out.changed, false);
    assert.ok(out.frames > 0, "it is drawing, it is just not listening");
  });

  await test("an error the game throws is reported, and so is one it logs", async () => {
    const out = await play(files(rootHtml, game), parseSteps([{ press: "x" }, { click: [50, 60] }]).steps);
    assert.ok(out.problems.some((p) => /the player fell out of the world/.test(p)), out.problems.join("|"));
    assert.ok(out.problems.some((p) => /clicked at 50,60/.test(p)), out.problems.join("|"));
  });

  await test("a missing file is a finding, not a hang", async () => {
    const out = await play(files(rootHtml), []);
    assert.ok(out.problems.some((p) => /404|Failed to load/i.test(p)), out.problems.join("|"));
    assert.equal(out.shots.length, 2, "and the run still finished");
  });

  await test("the game can reach only its own files: a request to anywhere else fails", async () => {
    const spy = `<!doctype html><body><script>
fetch("https://example.com/").then(() => console.error("REACHED example.com")).catch(() => console.error("blocked outside"));
fetch("/api/sessions").then((r) => console.error("own origin answered " + r.status));
</script>`;
    const out = await play(files(spy), []);
    assert.ok(out.problems.some((p) => /blocked outside/.test(p)), out.problems.join("|"));
    assert.ok(!out.problems.some((p) => /REACHED/.test(p)));
    assert.ok(out.problems.some((p) => /own origin answered 404/.test(p)), "not the app's routes, only the game's files");
  });

  await test("a stop asked for ends the run within a moment, not at the end of the wait", async () => {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 1_800);
    const began = Date.now();
    const out = await playPreview(files(rootHtml, game), "/abc/preview/index.html", parseSteps([{ wait: 25_000 }]).steps, {
      width: 400, height: 200, cancelled: () => cancelled,
    }).catch((e: Error) => e);
    assert.ok(out instanceof Error && /Stopped/.test(out.message), String(out));
    assert.ok(Date.now() - began < 12_000, `took ${Date.now() - began} ms`);
  });
}
console.log(`gameplay: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
