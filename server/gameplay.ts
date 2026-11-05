/**
 * Playing a game so the agent can see it: the preview files the editor made are served to a headless Chromium of their own
 * (no network, nothing of this app's origin), a short script of keys, clicks and waits is played into it, and what it looked like
 * comes back as pictures, with the errors the game threw and whether anything moved. The game is code from anywhere, so it
 * runs in an isolated context that can reach only its own files (server/pdfrender.ts `withBrowserContext`, the same box the
 * PDF and Office renderers use).
 *
 * The agent cannot hear, and cannot judge a feel by a still: what this gives it is whether the game starts, whether it
 * throws, whether the screen changes when keys are pressed, and what a frame looks like.
 */
import { createHash } from "node:crypto";
import type { Route } from "playwright-core";
import { PdfRenderError, withBrowserContext } from "./pdfrender";

type PreviewFile = { bytes: Buffer; type: string };

/** One thing the player does. */
type PlayStep =
  | { wait: number }
  | { press: string; ms: number }
  | { hold: string[]; ms: number }
  | { click: [number, number] }
  | { shot: string };

export const MAX_STEPS = 60;
/** All the waiting and holding of a script together: a test of a game is seconds, not a session. */
export const MAX_PLAY_MS = 30_000;
export const MAX_SHOTS = 8;
const ORIGIN = "https://game.autora.invalid";
/** The game gets this long to start before the first picture is taken. */
const BOOT_MS = 1_500;

const NAMED_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter", "Escape", "Tab", "Shift", "Control", "Alt", "Backspace",
]);
const keyOk = (k: unknown): k is string => typeof k === "string" && (/^[A-Za-z0-9]$/.test(k) || NAMED_KEYS.has(k));

/** The script as the agent gave it, checked and clamped; the reason when it cannot be played. */
export function parseSteps(raw: unknown): { steps: PlayStep[]; error?: string } {
  if (raw === undefined || raw === null) return { steps: [] };
  if (!Array.isArray(raw)) return { steps: [], error: "script is a list of steps." };
  if (raw.length > MAX_STEPS) return { steps: [], error: `At most ${MAX_STEPS} steps in a script.` };
  const steps: PlayStep[] = [];
  let spent = 0;
  let shots = 0;
  const ms = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), MAX_PLAY_MS) : fallback;
  };
  for (const [i, s] of raw.entries()) {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object") return { steps: [], error: `${at} is not a step.` };
    const o = s as Record<string, unknown>;
    if ("wait" in o) {
      const t = ms(o.wait, 0);
      steps.push({ wait: t });
      spent += t;
    } else if ("press" in o) {
      if (!keyOk(o.press)) return { steps: [], error: `${at}: ${JSON.stringify(o.press)} is not a key. Use a letter or digit, or one of ${[...NAMED_KEYS].join(", ")}.` };
      const t = ms(o.ms, 120);
      steps.push({ press: o.press, ms: t });
      spent += t;
    } else if ("hold" in o) {
      const keys = Array.isArray(o.hold) ? o.hold : [];
      if (keys.length === 0 || keys.length > 4 || !keys.every(keyOk)) return { steps: [], error: `${at}: hold is 1 to 4 keys held together (a letter or digit, or ${[...NAMED_KEYS].join(", ")}).` };
      const t = ms(o.ms, 500);
      steps.push({ hold: keys as string[], ms: t });
      spent += t;
    } else if ("click" in o) {
      const p = Array.isArray(o.click) ? o.click.map(Number) : [];
      if (p.length !== 2 || !p.every(Number.isFinite)) return { steps: [], error: `${at}: click is [x, y] in pixels on the game's screen.` };
      steps.push({ click: [Math.round(p[0]!), Math.round(p[1]!)] });
    } else if ("shot" in o) {
      if (++shots > MAX_SHOTS) return { steps: [], error: `At most ${MAX_SHOTS} pictures in a script.` };
      steps.push({ shot: String(o.shot ?? "").slice(0, 60) || `picture ${shots}` });
    } else {
      return { steps: [], error: `${at} is none of wait, press, hold, click or shot.` };
    }
    if (spent > MAX_PLAY_MS) return { steps: [], error: `The steps wait or hold for more than ${MAX_PLAY_MS / 1000} seconds together; shorten them.` };
  }
  return { steps };
}

export interface Played {
  shots: Array<{ label: string; png: Buffer }>;
  /** What the game threw or logged as an error, newest last, at most 20. */
  problems: string[];
  /** Whether the first and last pictures differ: a game that does nothing when keys are pressed is a finding. */
  changed: boolean;
  /** Frames the page drew during the run, so a frozen game is told from a still one. */
  frames: number;
  seconds: number;
}

const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Play `steps` into the game whose files are `files` (paths like "/<instance>/preview/index.html"), starting at `entry`. With
 * no shot in the script, one is taken after the game has started and one at the end.
 */
export async function playPreview(
  files: Map<string, PreviewFile>,
  entry: string,
  steps: PlayStep[],
  options: { width?: number; height?: number; cancelled?: () => boolean; onCancel?: (stop: () => void) => void } = {},
): Promise<Played> {
  const width = Math.min(Math.max(Math.round(options.width ?? 800), 160), 1920);
  const height = Math.min(Math.max(Math.round(options.height ?? 600), 120), 1080);
  const script: PlayStep[] = steps.some((s) => "shot" in s)
    ? steps
    : [{ shot: "start" }, ...steps, { shot: "end" }];
  const problems: string[] = [];
  const shots: Played["shots"] = [];
  const started = Date.now();
  return await withBrowserContext(async (context, stop) => {
    await context.route("**/*", (route: Route) => {
      const url = new URL(route.request().url());
      // The game reaches its own files and nothing else: no network, no other origin.
      if (url.origin !== ORIGIN) return void route.abort();
      const found = files.get(decodeURIComponent(url.pathname));
      if (!found) return void route.fulfill({ status: 404, body: "" });
      return void route.fulfill({ status: 200, body: found.bytes, contentType: found.type, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
    });
    const page = await context.newPage();
    const note = (text: string) => { if (problems.length < 20) problems.push(text.slice(0, 300)); };
    page.on("pageerror", (err) => note(`error: ${err.message}`));
    page.on("console", (msg) => { if (msg.type() === "error") note(`console: ${msg.text()}`); });
    page.on("requestfailed", (req) => { if (new URL(req.url()).origin === ORIGIN) note(`could not load ${new URL(req.url()).pathname}`); });
    // As source, not a function: a bundler may add helpers to a function that do not exist in the page.
    await page.addInitScript("globalThis.__frames = 0; (function tick() { globalThis.__frames++; requestAnimationFrame(tick); })();");
    await page.setViewportSize({ width, height });
    options.onCancel?.(stop);
    const keys = page.keyboard;
    // In slices, so a stop asked for is heard within a quarter of a second, not at the end of a long wait.
    const wait = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await sleep(Math.min(left, 250));
        if (options.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
      }
      if (options.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
    };
    try {
      await page.goto(`${ORIGIN}${entry}`, { waitUntil: "load", timeout: 30_000 });
    } catch (err) {
      throw new PdfRenderError(`The game page did not load: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
    }
    await wait(BOOT_MS);
    for (const s of script) {
      if ("wait" in s) await wait(s.wait);
      else if ("press" in s) { await keys.down(s.press); await wait(s.ms); await keys.up(s.press); }
      else if ("hold" in s) {
        for (const k of s.hold) await keys.down(k);
        await wait(s.ms);
        for (const k of [...s.hold].reverse()) await keys.up(k);
      } else if ("click" in s) await page.mouse.click(s.click[0], s.click[1]);
      else shots.push({ label: s.shot, png: await page.screenshot({ type: "png" }) });
    }
    const frames = Number(await page.evaluate("globalThis.__frames").catch(() => 0)) || 0;
    const changed = shots.length > 1 && sha(shots[0]!.png) !== sha(shots[shots.length - 1]!.png);
    return { shots, problems, changed, frames, seconds: Math.round((Date.now() - started) / 100) / 10 };
  }, { cancelled: options.cancelled, onCancel: options.onCancel }, { viewport: { width, height } });
}
