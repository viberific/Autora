/**
 * The check before a push, for what changed: `npm run check` (or `npm run check -- <ref>`, default origin/main;
 * `--no-tests` for the static steps only).
 *
 * The same steps as CI's static job and a test run, minus what the change cannot reach: the three root `tsc` projects,
 * ESLint and knip always (they are quick); an embedded editor's typecheck only when its files (or the root files it
 * imports) changed, so a server change does not wait minutes on GDevelop's install; the release check; then the test
 * files a change can reach (tests/affected.ts). CI still runs everything on the pull request.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { changedFiles, dependsOn } from "../tests/affected";

const root = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
const base = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "origin/main";
const changed = changedFiles(root, base);

/* What makes each embedded editor worth typechecking: its own folder, its pin, its scripts, and for OpenCut the root
   files its overlay imports (the shared tool rail). */
const EDITORS: { dir: string; touches: (f: string) => boolean }[] = [
  { dir: "spectra-editor", touches: (f) => /^(spectra-editor|spectra)\//.test(f) || /^scripts\/(prepare-spectra|spectra-)/.test(f) },
  { dir: "opencut-editor", touches: (() => {
    const shared = dependsOn(root, ["src/components/ToolRail.tsx", "src/lib/toolrail.ts"]);
    return (f: string) => /^(opencut-editor|opencut)\//.test(f) || /^scripts\/(prepare-opencut|typecheck-opencut|opencut-)/.test(f) || shared.has(f);
  })() },
  { dir: "gdevelop-editor", touches: (f) => /^(gdevelop-editor|gdevelop)\//.test(f) || /^scripts\/[^/]*gdevelop/.test(f) },
  { dir: "autora-3d", touches: (f) => /^autora-3d\//.test(f) || f === "scripts/sync-autora-3d.mjs" },
];

const failed: string[] = [];
function step(name: string, cmd: string, args: string[]) {
  const started = Date.now();
  console.log(`\n== ${name}`);
  const npm = cmd === "npm" ? process.env.npm_execpath : undefined;
  const r = spawnSync(npm ? process.execPath : cmd, npm ? [npm, ...args] : args, {
    cwd: root, stdio: "inherit", shell: !npm && cmd === "npm" && process.platform === "win32",
  });
  if (r.error) console.error(`${name} could not start: ${r.error.message}`);
  const ok = r.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  if (!ok) failed.push(name);
}

console.log(`${changed.length} files changed against ${base}.`);
const tool = (pkg: string, script: string) => path.join(root, "node_modules", pkg, "bin", script);
const tsc = tool("typescript", "tsc");
step("types: client", process.execPath, [tsc, "--noEmit"]);
step("types: server", process.execPath, [tsc, "--noEmit", "-p", "tsconfig.server.json"]);
step("types: tests", process.execPath, [tsc, "--noEmit", "-p", "tsconfig.test.json"]);
for (const e of EDITORS) {
  if (!changed.some(e.touches)) { console.log(`\n-- ${e.dir}: nothing it uses changed, skipped`); continue; }
  if (!fs.existsSync(path.join(root, e.dir, "node_modules"))) {
    console.log(`\n-- ${e.dir}: changed, but its dependencies are not installed: npm --prefix ${e.dir} ci`);
    failed.push(`${e.dir} (not installed)`);
    continue;
  }
  step(`types: ${e.dir}`, "npm", ["--prefix", e.dir, "run", "typecheck"]);
}
step("eslint", process.execPath, [tool("eslint", "eslint.js"), "."]);
step("unused code (knip)", process.execPath, [tool("knip", "knip.js"), "--no-progress"]);
step("release", "python3", [".github/scripts/check_release.py", "--base", base, "--head", "HEAD"]);
if (!process.argv.includes("--no-tests")) {
  /* The ui-* tests drive the built app: without a build they would fail on its absence, not on the change. */
  const built = fs.existsSync(path.join(root, "dist", "index.html"));
  if (!built) console.log("\n-- ui-* tests skipped: no build here (npm run build, then npm test -- ui-)");
  step("tests a change can reach", process.execPath, ["--import", "tsx", path.join(root, "tests", "run.ts"), "--changed", base, "-j", "4", ...(built ? [] : ["--no-ui"])]);
}

console.log(failed.length ? `\n${failed.length} step(s) failed: ${failed.join(", ")}` : "\nEvery step passed.");
process.exit(failed.length ? 1 : 0);
