/**
 * Does the file still parse? Asked the moment the agent writes it.
 *
 * An edit that leaves a brace open or a quote unclosed used to be found a round
 * later, when something ran the code -- or not at all, when nothing did. A parse
 * takes milliseconds and needs no model, so edit_file answers it with the edit:
 * the agent fixes the slip in the same breath instead of spending a round (and the
 * whole prompt again) discovering it.
 *
 * Plain code, the same for every model. Only syntax: whether the file parses, not
 * whether it type-checks or works -- that is the project check (server/verify.ts).
 * Each language uses the best parser this machine has, and says nothing when it
 * has none:
 *
 *   .ts .tsx .js .jsx .mts .cts .mjs .cjs  TypeScript's parser, Autora's own copy (never the edited project's,
 *                                          whose code would run in the server); else Node's type stripper (.ts)
 *                                          or `node --check` (.js), which only parse
 *   .json                                  JSON.parse (not tsconfig and the other files that allow comments)
 *   .py                                    python3's ast module
 *
 * A file that did not parse before the edit is not blamed on it: the note is only
 * for a break the edit made, or a new file that does not parse.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as nodeModule from "node:module";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

interface SyntaxProblem {
  line: number;
  column: number;
  message: string;
}

const JS_LIKE = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
/** JSON files that allow comments and trailing commas: JSON.parse would call them broken. */
const JSONC = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc|\.babelrc|devcontainer)\.json$|\.vscode\/|\.jsonc$/i;
const SPAWN_MS = 4_000;
/** Past this a file is not parsed on every edit: it costs more than it saves. */
const MAX_CHARS = 400_000;

type Ts = typeof import("typescript");
let ownTs: Ts | null | undefined;

/**
 * Autora's own TypeScript, found from where the server runs (the repo in development; in the container it is pruned,
 * and the fallbacks below are used). Never the edited project's copy: requiring it would run that project's code
 * inside the server, which holds every secret.
 */
function typescript(): Ts | null {
  if (ownTs !== undefined) return ownTs;
  try {
    const found = createRequire(path.join(process.cwd(), "noop.js"))("typescript") as Ts;
    ownTs = typeof found?.createSourceFile === "function" ? found : null;
  } catch {
    ownTs = null;
  }
  return ownTs;
}

function viaTypescript(ts: Ts, file: string, text: string): SyntaxProblem[] {
  const ext = path.extname(file).toLowerCase();
  const kind = ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX
    : ext === ".ts" || ext === ".mts" || ext === ".cts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found = (source as unknown as { parseDiagnostics?: import("typescript").Diagnostic[] }).parseDiagnostics ?? [];
  return found.slice(0, 3).map((d) => {
    const at = source.getLineAndCharacterOfPosition(d.start ?? 0);
    return { line: at.line + 1, column: at.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, " ") };
  });
}

/** Node's own TypeScript stripper (Node 22.13+): it parses the file to strip it, so a syntax error throws. */
function viaStripper(text: string): SyntaxProblem[] | null {
  const strip = (nodeModule as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;
  if (typeof strip !== "function") return null;
  try {
    strip(text);
    return [];
  } catch (err: any) {
    // Valid TypeScript that strip-only mode does not take (an enum, a namespace) is not a syntax error.
    if (err?.code !== "ERR_INVALID_TYPESCRIPT_SYNTAX") return [];
    const message = String(err.message ?? "").split("\n").find((l: string) => l.trim()) ?? "syntax error";
    const where = /\[(?:[^\]:]*:)?(\d+):(\d+)\]/.exec(String(err.message ?? ""));
    return [{ line: where ? Number(where[1]) : 0, column: where ? Number(where[2]) : 0, message: message.replace(/^\s*x\s*/, "") }];
  }
}

/** A file's text checked by a child process that reads it from a path: the file itself, or a copy of the old text. */
function onDisk<T>(file: string, text: string, fn: (at: string) => T): T {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return fn(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-syntax-"));
  const copy = path.join(dir, path.basename(file));
  try {
    fs.writeFileSync(copy, text);
    return fn(copy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function viaNodeCheck(file: string, text: string): SyntaxProblem[] {
  return onDisk(file, text, (at) => {
    const r = spawnSync(process.execPath, ["--check", at], { encoding: "utf8", timeout: SPAWN_MS });
    if (r.status === 0 || r.error || r.status === null) return [];
    const err = r.stderr ?? "";
    const line = Number(new RegExp(`${at.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(err)?.[1] ?? 0);
    const message = err.split("\n").find((l) => /Error:/.test(l))?.trim() ?? "syntax error";
    return [{ line, column: 0, message }];
  });
}

const PY_CHECK =
  "import ast,sys\n" +
  "try:\n ast.parse(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1])\n" +
  "except SyntaxError as e:\n print(f'{e.lineno or 0}:{e.offset or 0}:{e.msg}');sys.exit(1)\n";

let python: string | null | undefined;
function pythonPath(): string | null {
  if (python !== undefined) return python;
  for (const name of ["python3", "python"]) {
    const r = spawnSync(name, ["-c", "import sys;print(sys.version_info[0])"], { encoding: "utf8", timeout: SPAWN_MS });
    if (r.status === 0 && r.stdout.trim() === "3") return (python = name);
  }
  return (python = null);
}

function viaPython(file: string, text: string): SyntaxProblem[] | null {
  const py = pythonPath();
  if (!py) return null;
  return onDisk(file, text, (at) => {
    const r = spawnSync(py, ["-c", PY_CHECK, at], { encoding: "utf8", timeout: SPAWN_MS });
    if (r.status !== 1) return [];
    const [line, column, ...rest] = (r.stdout ?? "").trim().split(":");
    return [{ line: Number(line) || 0, column: Number(column) || 0, message: rest.join(":") || "syntax error" }];
  });
}

/**
 * What stops this text parsing as the kind of file its name says, or null when no
 * parser for it is here (nothing is known, so nothing is said). An empty list: it parses.
 */
export function syntaxProblems(file: string, text: string): SyntaxProblem[] | null {
  if (text.length > MAX_CHARS) return null;
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".json") {
      if (JSONC.test(file.replace(/\\/g, "/")) || !text.trim()) return null;
      try {
        JSON.parse(text);
        return [];
      } catch (err: any) {
        const pos = Number(/position (\d+)/.exec(String(err?.message))?.[1] ?? -1);
        const line = pos >= 0 ? text.slice(0, pos).split("\n").length : 0;
        return [{ line, column: 0, message: String(err?.message ?? "not valid JSON").split("\n")[0] }];
      }
    }
    if (JS_LIKE.has(ext)) {
      const ts = typescript();
      if (ts) return viaTypescript(ts, file, text);
      if (ext === ".ts" || ext === ".mts" || ext === ".cts") return viaStripper(text);
      if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return viaNodeCheck(file, text);
      return null;
    }
    if (ext === ".py") return viaPython(file, text);
  } catch {
    /* A parser that itself failed says nothing about the file. */
  }
  return null;
}

/**
 * The line edit_file adds when its edit broke the file's syntax, or "" when it did
 * not (or nobody here can tell). `before` is the text the edit started from: null
 * for a new file.
 */
export function syntaxNote(file: string, before: string | null, after: string): string {
  const now = syntaxProblems(file, after);
  if (!now || now.length === 0) return "";
  if (before !== null) {
    const was = syntaxProblems(file, before);
    // It did not parse before either: the edit is not what broke it.
    if (was && was.length > 0) return "";
  }
  const where = now.map((p) => `line ${p.line || "?"}${p.column ? `:${p.column}` : ""}: ${p.message}`).join("; ");
  return ` It no longer parses -- ${where}. Fix that before anything else; nothing has run it yet.`;
}
