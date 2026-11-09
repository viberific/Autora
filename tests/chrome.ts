/**
 * The Chrome the browser tests drive.
 *
 * Each test used to name its own copy of one Playwright build's path (chromium-1194), so on a machine with any other
 * build every browser test quietly skipped, and a run that "passed" had not opened a page. One place now: the
 * binary AUTORA_BROWSER_PATH names, else the generic link Playwright's images keep, else a system package, else
 * the newest of Playwright's own downloads whatever its number. Empty when there is none, which a test reads as
 * "skip".
 */
import fs from "node:fs";
import path from "node:path";

const PW = "/opt/pw-browsers";

function downloaded(): string[] {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)); } catch { return []; }
  dirs.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  return dirs.flatMap((d) => [path.join(PW, d, "chrome-linux64/chrome"), path.join(PW, d, "chrome-linux/chrome")]);
}

function findChrome(): string {
  const named = (process.env.AUTORA_BROWSER_PATH || "").trim();
  if (named) return named;
  const candidates = [
    path.join(PW, "chromium"),
    ...downloaded(),
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? "";
}

export const CHROME = findChrome();
