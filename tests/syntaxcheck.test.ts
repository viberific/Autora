/**
 * Whether a file still parses, said with the edit that broke it (server/syntaxcheck.ts),
 * and the project check found when the person set none (server/verify.ts detectCheck).
 *
 *   npx tsx tests/syntaxcheck.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syntaxNote, syntaxProblems } from "../server/syntaxcheck";
import { editFile } from "../server/editfile";
import { detectCheck, projectCheck, failedNote, VERIFY_DEFAULTS } from "../server/verify";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autora-syntax-test-"));
const at = (rel: string) => path.join(root, rel);
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), text); };

console.log("syntax check");

test("TypeScript, JavaScript and TSX that parse have no problems", () => {
  assert.deepEqual(syntaxProblems(at("a.ts"), "const a: number = 1;\nexport enum E { A }\n"), []);
  assert.deepEqual(syntaxProblems(at("a.js"), "const a = 1;\nmodule.exports = { a };\n"), []);
  assert.deepEqual(syntaxProblems(at("a.tsx"), "export const X = () => <div>hi</div>;\n"), []);
});

test("an unclosed brace is found, with its line", () => {
  const found = syntaxProblems(at("b.ts"), "function f(a: number) {\n  return a;\n\nexport const x = 1;\n");
  assert.ok(found && found.length > 0, "a problem");
  assert.ok(found![0].line >= 1);
});

test("JSON is checked, but not the JSON files that allow comments", () => {
  assert.equal(syntaxProblems(at("data.json"), '{"a": 1,}')!.length, 1);
  assert.deepEqual(syntaxProblems(at("data.json"), '{"a": 1}'), []);
  assert.equal(syntaxProblems(at("tsconfig.json"), '{ // comment\n "a": 1 }'), null);
});

test("Python is checked when python3 is here", () => {
  const found = syntaxProblems(at("x.py"), "def f(:\n  pass\n");
  if (found === null) return; // no python3 on this machine: nothing is said
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
  assert.deepEqual(syntaxProblems(at("y.py"), "def f():\n    return 1\n"), []);
});

test("a kind of file nobody here can parse says nothing", () => {
  assert.equal(syntaxProblems(at("notes.md"), "# {{{"), null);
});

test("the note blames the edit only for a break it made", () => {
  assert.match(syntaxNote(at("c.js"), "const a = 1;\n", "const a = (1;\n"), /no longer parses/);
  assert.equal(syntaxNote(at("c.js"), "const a = (1;\n", "const a = (2;\n"), "", "it was broken before");
  assert.equal(syntaxNote(at("c.js"), "const a = 1;\n", "const a = 2;\n"), "");
  assert.match(syntaxNote(at("new.ts"), null, "export const = 1;\n"), /no longer parses/, "a new file that does not parse");
});

test("edit_file says so in the same answer when its edit broke the file", () => {
  write("d.ts", "export function f(a: number) {\n  return a + 1;\n}\n");
  const deps = { root, protect: [], base: () => null, held: () => null };
  const broke = editFile({ path: "d.ts", edits: [{ old: "return a + 1;\n}", new: "return a + 1;\n" }] }, deps);
  assert.equal(broke.ok, true, "the edit is written all the same");
  assert.match(broke.summary, /no longer parses -- line \d+/);
  const fine = editFile({ path: "d.ts", edits: [{ old: "return a + 1;\n", new: "return a + 2;\n}" }] }, deps);
  assert.doesNotMatch(fine.summary, /parses/);
});

console.log("project check, found");

test("an npm project with installed dependencies: type check and tests, in CI mode", () => {
  write("web/package.json", JSON.stringify({ scripts: { dev: "vite", typecheck: "tsc --noEmit", test: "vitest", lint: "eslint ." } }));
  fs.mkdirSync(at("web/node_modules"), { recursive: true });
  assert.equal(detectCheck(at("web")), "CI=1 npm run -s typecheck && npm run -s test");
});

test("a whole check script wins; watchers, servers and npm's placeholder test never count", () => {
  write("p1/package.json", JSON.stringify({ scripts: { check: "npm run lint && npm test", test: "jest" } }));
  fs.mkdirSync(at("p1/node_modules"), { recursive: true });
  assert.equal(detectCheck(at("p1")), "CI=1 npm run -s check");
  write("p2/package.json", JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1", typecheck: "tsc --watch" } }));
  fs.mkdirSync(at("p2/node_modules"), { recursive: true });
  assert.equal(detectCheck(at("p2")), null);
});

test("dependencies not installed: no npm check, since it could only fail", () => {
  write("p3/package.json", JSON.stringify({ scripts: { test: "jest" } }));
  assert.equal(detectCheck(at("p3")), null);
});

test("the person's own command always wins, and looking can be turned off", () => {
  const set = projectCheck({ ...VERIFY_DEFAULTS, command: "make test" }, at("web"));
  assert.deepEqual(set, { command: "make test", tries: 3, auto: false, cwd: at("web") });
  assert.equal(projectCheck({ ...VERIFY_DEFAULTS, auto: false }, at("web")), null);
});

test("a project in a subfolder is found from the file the agent changed, and runs fewer times", () => {
  write("web/src/app.ts", "export {};\n");
  const found = projectCheck(VERIFY_DEFAULTS, root, [at("web/src/app.ts")]);
  assert.equal(found?.cwd, at("web"));
  assert.equal(found?.auto, true);
  assert.equal(found?.tries, 2);
  assert.equal(projectCheck(VERIFY_DEFAULTS, root, [at("elsewhere/x.ts")]), null, "nothing above it has a check");
});

test("a detected check tells the agent that failures it did not cause are not its to fix", () => {
  const note = failedNote({ command: "npm test", auto: true, exitCode: 1, ok: false, output: "1 failing" }, 1, 2);
  assert.match(note, /found in the project, not chosen by the person/);
  assert.doesNotMatch(failedNote({ command: "npm test", exitCode: 1, ok: false, output: "1 failing" }, 1, 2), /found in the project/);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed`);
