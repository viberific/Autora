/**
 * Which test files a change can break: the ones whose imports reach a changed file.
 *
 * Read off the source with plain code (static `from "./x"` and `import("./x")`), so it costs nothing and needs no
 * build. A test that starts the app (tests/e2e-harness.ts) depends on server.ts, so a server change reaches it.
 * Used by `npm test -- --changed`; the full run is still what CI does.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SOURCE_DIRS = ["server", "src", "tests", "evals"];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Every source file the graph covers, relative to the root, with forward slashes. */
function sources(root: string): string[] {
  const out: string[] = ["server.ts"].filter((f) => fs.existsSync(path.join(root, f)));
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); }
      else if (EXTENSIONS.some((x) => e.name.endsWith(x))) out.push(rel);
    }
  };
  for (const d of SOURCE_DIRS) if (fs.existsSync(path.join(root, d))) walk(d);
  return out;
}

function resolve(root: string, from: string, spec: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const tries = [base, ...EXTENSIONS.map((x) => base + x), ...EXTENSIONS.map((x) => `${base}/index${x}`), base.replace(/\.js$/, ".ts")];
  return tries.find((t) => fs.existsSync(path.join(root, t)) && fs.statSync(path.join(root, t)).isFile()) ?? null;
}

/** For each file, the files that import it. */
export function importedBy(root: string): Map<string, Set<string>> {
  const back = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    if (!back.has(to)) back.set(to, new Set());
    back.get(to)!.add(from);
  };
  for (const file of sources(root)) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const to = resolve(root, file, m[1]);
      if (to) edge(file, to);
    }
  }
  // The harness starts server.ts as a process rather than importing it.
  if (fs.existsSync(path.join(root, "tests/e2e-harness.ts"))) edge("tests/e2e-harness.ts", "server.ts");
  return back;
}

/** The files `entries` import, directly or not, themselves included: what a change to any of them can break there. */
export function dependsOn(root: string, entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f) || !fs.existsSync(path.join(root, f))) continue;
    seen.add(f);
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(IMPORT)) {
      const to = resolve(root, f, m[1]);
      if (to) queue.push(to);
    }
  }
  return seen;
}

/** The test files (names, as tests/run.ts lists them) that `changed` files can reach. */
export function affectedTests(root: string, changed: readonly string[]): string[] {
  const back = importedBy(root);
  const seen = new Set<string>();
  const queue = changed.map((f) => f.replace(/\\/g, "/"));
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const by of back.get(f) ?? []) queue.push(by);
  }
  return [...seen].filter((f) => /^tests\/[^/]+\.test\.ts$/.test(f)).map((f) => f.slice("tests/".length)).sort();
}

/** Files changed against `base` (committed on this branch, staged, unstaged and new). */
export function changedFiles(root: string, base: string): string[] {
  const git = (...args: string[]) => {
    try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); } catch { return []; }
  };
  return [...new Set([
    ...git("diff", "--name-only", `${base}...HEAD`),
    ...git("diff", "--name-only", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ])];
}
