/**
 * A map of the project the turn is about, in the turn's note, so the agent starts where the work is.
 *
 * A coding turn used to open with rounds of looking -- list the folder, find the files, search for the name -- each
 * one the whole prompt again. The machine already knows the answers: which folders there are, what the project runs,
 * and which files are most about the words of the message (the same ranking code_search uses). Plain code, no model,
 * the same for every vendor, and about a thousand tokens.
 *
 * Only for a folder that is a project (it has a manifest), only when the message is about something in it (a file
 * ranks for its words), and never for a folder too big to walk.
 */

import fs from "node:fs";
import path from "node:path";
import { projectFiles, rankFiles } from "./codesearch";

const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "Makefile", "tsconfig.json"];
/** A file must score at least this for its words to count as what the message is about. */
const MIN_SCORE = 2;
const FILES_SHOWN = 5;
const DECLS_PER_FILE = 12;
const FOLDERS_SHOWN = 14;
const MAX_CHARS = 4_500;

/** The map for this folder and message, or null when there is nothing worth saying. */
export function projectMap(root: string, said: string): string | null {
  if (!said.trim() || !fs.existsSync(root)) return null;
  const manifest = MANIFESTS.find((m) => fs.existsSync(path.join(root, m)));
  if (!manifest) return null;
  const ranked = rankFiles(root, said, FILES_SHOWN).filter((f) => f.score >= MIN_SCORE);
  if (ranked.length === 0) return null;
  const all = projectFiles(root);
  if (!all) return null;

  const out: string[] = [`Project map of ${root} (worked out by Autora from the files, not by a model; code_search and read_file for more):`];
  if (manifest === "package.json") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const scripts = Object.keys(pkg.scripts ?? {});
      if (scripts.length) out.push(`- package.json scripts: ${scripts.slice(0, 16).join(", ")}`);
    } catch { /* not readable: no scripts line */ }
  } else {
    out.push(`- ${manifest}`);
  }
  const folders = new Map<string, number>();
  for (const rel of all) {
    const top = rel.includes("/") ? `${rel.split("/")[0]}/` : ".";
    folders.set(top, (folders.get(top) ?? 0) + 1);
  }
  const listed = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, FOLDERS_SHOWN);
  out.push(`- ${all.length} files: ${listed.map(([f, n]) => `${f === "." ? "top level" : f} ${n}`).join(", ")}`);
  out.push("- Files most about this message, with what is in them (line numbers):");
  for (const f of ranked) {
    const decls = f.decls.filter((d) => !/^h\d$/.test(d.kind)).slice(0, DECLS_PER_FILE);
    out.push(`  ${f.rel} (${f.lines} lines)${decls.length ? `: ${decls.map((d) => `${d.name} ${d.line}`).join(", ")}` : ""}`);
  }
  const text = out.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 3)}...` : text;
}
