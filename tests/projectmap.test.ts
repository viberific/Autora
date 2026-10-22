/**
 * The project map in a coding turn's note (server/projectmap.ts): where the work is, from the files, so the turn does
 * not open with rounds of listing and searching.
 *
 *   npx tsx tests/projectmap.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectMap } from "../server/projectmap";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autora-map-"));
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
put("package.json", JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
put("src/args.js", "function parseArgs(argv) {\n  return argv;\n}\nfunction flagValue(rest, i) {\n  return rest[i + 1];\n}\nmodule.exports = { parseArgs };\n");
put("src/cli.js", "const { parseArgs } = require('./args');\nconsole.log(parseArgs(process.argv));\n");
for (let i = 0; i < 12; i++) put(`src/commands/cmd${i}.js`, `module.exports = () => ${i};\n`);
put("docs/notes.md", "# Notes\n");

console.log("project map");

test("a message about the code gets the scripts, the folders and the files most about it, with their declarations", () => {
  const map = projectMap(root, "the cli parses args wrong for --name")!;
  assert.ok(map, "a map");
  assert.match(map, /package\.json scripts: test, build/);
  assert.match(map, /16 files: src\/ 14/);
  assert.match(map, /src\/args\.js \(7 lines\): parseArgs 1, flagValue 4/);
  assert.ok(map.length < 4_500);
});

test("nothing for a message about nothing in the folder", () => {
  assert.equal(projectMap(root, "what is the weather like in Paris"), null);
});

test("nothing for a folder that is not a project", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "autora-map-plain-"));
  fs.writeFileSync(path.join(plain, "args.js"), "function parseArgs() {}\n");
  assert.equal(projectMap(plain, "parse args"), null);
  fs.rmSync(plain, { recursive: true, force: true });
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed`);
