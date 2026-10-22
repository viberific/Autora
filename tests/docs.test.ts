/**
 * The docs an agent starts from name files that exist. A map that points at a file that was renamed or removed sends
 * the next agent searching, which is what the map is there to save.
 *
 *   npx tsx tests/docs.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
const DOCS = ["CLAUDE.md", "docs/MAP.md", "docs/MODULES.md", "docs/ARCHITECTURE.md", "docs/VISIBLE-WORK.md", "docs/TOOL-RAIL.md", "docs/EVAL.md", "docs/DESIGN.md"];
const PATH = /`((?:server|src|tests|scripts|evals|docs|office|spectra-editor|opencut-editor|gdevelop-editor|autora-3d|photo|\.github)\/[A-Za-z0-9_./-]+?)`/g;
/* Fetched or built, never in the repository. */
const NOT_IN_REPO = /^(spectra-editor\/src\/renderer|opencut-editor\/src\/web|gdevelop-editor\/work|dist\/)/;
/* A path written relative to a folder the line has just named ("`.github/`: `scripts/check_release.py`"). */
const BASES = ["", ".github", "spectra-editor", "opencut-editor", "gdevelop-editor", "office", "photo"];

console.log("docs name real files");
const missing: string[] = [];
for (const doc of DOCS) {
  if (!fs.existsSync(path.join(root, doc))) continue;
  fs.readFileSync(path.join(root, doc), "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(PATH)) {
      const p = m[1].replace(/[.,]+$/, "");
      if (p.includes("...") || NOT_IN_REPO.test(p)) continue;
      if (!BASES.some((b) => fs.existsSync(path.join(root, b, p)))) missing.push(`${doc}:${i + 1}: ${p}`);
    }
  });
}
assert.deepEqual(missing, [], `the docs name files that are not there:\n${missing.join("\n")}`);
console.log("  ok  every file the docs name is there\n1 passed");
