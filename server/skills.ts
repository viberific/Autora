/**
 * Skills: ways of doing a kind of work, kept as real skills in the open Agent
 * Skills format rather than as notes in the Mind.
 *
 * A skill is a folder, `skills/<name>/`, holding a `SKILL.md`: YAML front matter
 * with a `name` (the folder's name: lowercase letters, digits and hyphens) and a
 * `description` (what it does and when to use it), then the instructions. Scripts,
 * templates and reference files sit beside it and are read or run when the
 * instructions say so. A folder made anywhere that follows the format imports as
 * it is, and one exported from here works anywhere that reads the format.
 *
 * The agent sees every skill's name and description on every turn (`catalogue`)
 * and loads a skill's instructions only when it picks one (the `skill` tool), so a
 * long library costs a line a skill, not its text, and a skill is found by what it
 * is for rather than by whether the person's words happened to match it.
 *
 * One library is shared by Autora and every agent of the Organization: any of them
 * can use a skill, and any of them can write or improve one. What an agent writes
 * is a draft until the person approves it or it has worked a few times; an edit to
 * a skill keeps the text it replaced, so a bad edit is one step back. Autora's own
 * bookkeeping (status, author, how often it worked, earlier versions) lives in
 * `.autora.json` beside `SKILL.md`, so the skill itself stays plain.
 */

import fs from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, zipSync } from "fflate";
import { unzipCapped } from "./unzip";
import { stateDir } from "./state";

type SkillStatus = "live" | "draft";
export type SkillAuthor = { kind: "person" } | { kind: "agent"; id: string; name: string };

interface Sidecar {
  status: SkillStatus;
  author: SkillAuthor;
  created: number;
  updated: number;
  uses: number;
  worked: number;
  failed: number;
  /** Rounds of tool calls the turns that used it and went well took, newest last: what "usually" means for it. */
  steps: number[];
  /**
   * Earlier SKILL.md texts, newest first, with who replaced them. `files` is the
   * files beside it that version changed, as they held before it (null: the file
   * was not there), so going back puts the scripts back too.
   */
  versions: { at: number; by: string; text: string; files?: Record<string, string | null> }[];
}

interface SkillInfo {
  name: string;
  description: string;
  status: SkillStatus;
  author: SkillAuthor;
  created: number;
  updated: number;
  uses: number;
  worked: number;
  failed: number;
  /** Files beside SKILL.md, relative to the skill's folder. */
  files: string[];
  versions: number;
}

interface Skill extends SkillInfo {
  /** The whole SKILL.md, front matter and all. */
  text: string;
  /** The instructions under the front matter. */
  body: string;
  /** Every field of the front matter, as read. */
  meta: Record<string, unknown>;
  /** Where the folder is on disk, for running its scripts. */
  dir: string;
}

/** The format's own limits (agentskills.io), and Autora's for what it will hold. */
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
/** A SKILL.md is read whole into a turn: past this it should be split into reference files. */
const SKILL_MD_MAX = 30_000;
const FILE_MAX = 1_000_000;
const TOTAL_MAX = 5_000_000;
const FILES_MAX = 100;
const VERSIONS_KEPT = 5;
/** A file bigger than this, or not text, is not kept in a version: a rollback leaves it as it is. */
const VERSION_FILE_MAX = 200_000;
const STEPS_KEPT = 9;
/** A draft an agent wrote goes live after this many turns that used it went well. */
export const LIVE_AFTER = 3;
/** The catalogue in every turn stays about this long; past it, the least used are named only. */
const CATALOGUE_MAX = 8000;

const SIDECAR = ".autora.json";
const root = () => path.join(stateDir(), "skills");
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A key, password or token written into a skill, as opposed to the name of where one is kept ($TOKEN, process.env...). */
const SECRET = /(password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*["']?(?![$<{]|process\.env|os\.environ|env\b)[^\s"']{6,}/i;

export class SkillError extends Error {}

// ------------------------------------------------------------ the format --

/** What a name must be, or null when it is one. */
function nameProblem(name: string): string | null {
  if (!name) return "A skill needs a name.";
  if (name.length > NAME_MAX) return `A skill's name is at most ${NAME_MAX} characters.`;
  if (!NAME_RE.test(name)) {
    return `"${name}" is not a skill name: lowercase letters, digits and single hyphens only, not starting or ending with a hyphen (for example "invoice-from-timesheet").`;
  }
  return null;
}

/** A name made from a title: "Docker: restart a stuck container" is "docker-restart-a-stuck-container". */
export function slugOf(title: string): string {
  const s = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX).replace(/-+$/g, "");
  return s || "skill";
}

const unquote = (v: string) => {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.startsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n") : t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
};

/**
 * The YAML a SKILL.md's front matter uses: `key: value`, quoted values, `|` and
 * `>` blocks, and one level of nested mapping (`metadata:`). Anything richer is
 * refused with what to write instead, rather than read wrong.
 */
function readYaml(src: string): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) return `Line ${i + 2} of the front matter is indented where a new field was expected.`;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return `Line ${i + 2} of the front matter is not "key: value".`;
    const [, key, rest] = m;
    const block = /^([|>])[+-]?\s*$/.exec(rest);
    if (block || rest === "") {
      const body: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) body.push(lines[++i]);
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (block) {
        const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
        const text = body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
        out[key] = block[1] === "|" ? text.join("\n") : text.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
      } else if (body.length) {
        const map: Record<string, string> = {};
        const list: string[] = [];
        for (const b of body) {
          if (!b.trim()) continue;
          const item = /^\s+-\s+(.*)$/.exec(b);
          if (item) { list.push(unquote(item[1])); continue; }
          const kv = /^\s+([^:#]+?)\s*:\s*(.*)$/.exec(b);
          if (kv) { map[kv[1].trim()] = unquote(kv[2]); continue; }
          return `The "${key}" field has a line that is neither "key: value" nor "- item".`;
        }
        if (list.length && Object.keys(map).length) return `The "${key}" field mixes "key: value" lines and "- item" lines.`;
        out[key] = list.length ? list : map;
      } else {
        out[key] = "";
      }
      continue;
    }
    out[key] = unquote(rest);
  }
  return out;
}

const yamlValue = (v: string) =>
  /^[^\s"'#&*!|>%@`{}[\],?:-][^#]*$/.test(v) && !/:\s/.test(v) && v === v.trim() ? v : JSON.stringify(v);

/** A SKILL.md from its parts, front matter written the plain way the format shows it. */
export function composeSkillMd(name: string, description: string, body: string, extra: Record<string, unknown> = {}): string {
  const lines = ["---", `name: ${name}`, `description: ${yamlValue(description.replace(/\s+/g, " ").trim())}`];
  for (const [k, v] of Object.entries(extra)) {
    if (k === "name" || k === "description" || v === undefined || v === "") continue;
    if (typeof v === "string") lines.push(`${k}: ${yamlValue(v)}`);
    else if (Array.isArray(v)) { lines.push(`${k}:`); for (const x of v) lines.push(`  - ${yamlValue(String(x))}`); }
    else if (v && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) lines.push(`  ${mk}: ${yamlValue(String(mv))}`);
    }
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

type Parsed = { ok: true; meta: Record<string, unknown>; name: string; description: string; body: string } | { ok: false; error: string };

/**
 * A SKILL.md read and held to the format: front matter between `---` lines,
 * a valid `name`, a `description` that says what it is for, instructions under
 * it, nothing secret. The error is written to whoever fixes it -- the agent or
 * the person -- and says what to change.
 */
export function parseSkillMd(text: string): Parsed {
  const src = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (src.length > SKILL_MD_MAX) {
    return { ok: false, error: `SKILL.md is ${src.length} characters; keep it under ${SKILL_MD_MAX}. Move long material into reference files beside it (references/*.md) and say in the instructions when to read each.` };
  }
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!fm) return { ok: false, error: "SKILL.md must start with front matter: a line \"---\", then name: and description:, then \"---\"." };
  const meta = readYaml(fm[1]);
  if (typeof meta === "string") return { ok: false, error: meta };
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const wrongName = nameProblem(name);
  if (wrongName) return { ok: false, error: wrongName };
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!description) return { ok: false, error: "A skill needs a description: what it does and when to use it, in the words someone would use asking for that work." };
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `The description is ${description.length} characters; the format allows ${DESCRIPTION_MAX}. Say what it does and when to use it; the detail belongs in the instructions.` };
  if (description.length < 20) return { ok: false, error: "The description is too short to choose by. Say what the skill does and when to use it (\"Turns a timesheet CSV into an invoice PDF. Use when the person asks to bill a client for logged hours.\")." };
  if (meta.compatibility !== undefined && (typeof meta.compatibility !== "string" || meta.compatibility.length > COMPATIBILITY_MAX)) {
    return { ok: false, error: `compatibility is a line of text of at most ${COMPATIBILITY_MAX} characters.` };
  }
  if (meta.metadata !== undefined && (typeof meta.metadata !== "object" || Array.isArray(meta.metadata))) {
    return { ok: false, error: "metadata is a mapping of keys to text (metadata:, then indented \"key: value\" lines)." };
  }
  const body = src.slice(fm[0].length).trim();
  if (body.length < 40) return { ok: false, error: "A skill needs instructions under its front matter: when to use it, the steps, how to check the result, and the gotchas." };
  if (SECRET.test(src)) return { ok: false, error: "That holds what looks like a password, key or token. A skill never holds one: name the environment variable or saved credential it is read from instead." };
  return { ok: true, meta, name, description, body };
}

// ---------------------------------------------------------------- the disk --

const dirOf = (name: string) => {
  if (nameProblem(name)) throw new SkillError(nameProblem(name)!);
  return path.join(root(), name);
};

/** A path inside a skill's folder, or null when it would leave it or touch Autora's own file. */
function inside(dir: string, rel: string): string | null {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!clean || clean === "SKILL.md" || clean.split("/").some((p) => p === ".." || p === SIDECAR || p.startsWith("."))) return null;
  const target = path.resolve(dir, clean);
  return target.startsWith(dir + path.sep) ? target : null;
}

/** A script that will be run keeps its executable bit; anything else is private. */
const modeFor = (target: string) => (/\.(sh|py|js|mjs|ts|rb|pl)$/.test(target) ? 0o700 : 0o600);

/** What these files hold now (null: not there), kept as the other side of a rollback. */
function filesNow(dir: string, paths: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of paths) {
    const target = inside(dir, rel);
    if (!target) continue;
    try {
      const bytes = fs.readFileSync(target);
      if (bytes.includes(0) || bytes.byteLength > VERSION_FILE_MAX) continue;
      out[rel] = bytes.toString("utf8");
    } catch { out[rel] = null; }
  }
  return out;
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(base, e.name);
    if (e.isDirectory()) out.push(...listFiles(dir, full));
    else if (e.isFile()) {
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (rel !== "SKILL.md") out.push(rel);
    }
  }
  return out.sort();
}

function readSidecar(dir: string): Sidecar {
  let raw: Partial<Sidecar> = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR), "utf8")) as Partial<Sidecar>; } catch { /* a folder brought in by hand has none */ }
  let born = Date.now();
  try { born = fs.statSync(path.join(dir, "SKILL.md")).mtimeMs; } catch { /* no SKILL.md: it is not listed */ }
  return {
    status: raw.status === "draft" ? "draft" : "live",
    author: raw.author && (raw.author.kind === "person" || raw.author.kind === "agent") ? raw.author : { kind: "person" },
    created: Number(raw.created) || born,
    updated: Number(raw.updated) || born,
    uses: Number(raw.uses) || 0,
    worked: Number(raw.worked) || 0,
    failed: Number(raw.failed) || 0,
    steps: Array.isArray(raw.steps) ? raw.steps.filter((n) => Number.isFinite(n) && n > 0).slice(-STEPS_KEPT) : [],
    versions: Array.isArray(raw.versions) ? raw.versions.slice(0, VERSIONS_KEPT) : [],
  };
}

function writeSidecar(dir: string, s: Sidecar) {
  const file = path.join(dir, SIDECAR);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load(name: string): Skill | null {
  if (nameProblem(name)) return null;
  const dir = path.join(root(), name);
  let text: string;
  try { text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"); } catch { return null; }
  const parsed = parseSkillMd(text);
  const side = readSidecar(dir);
  /* One edited by hand into something the format does not allow is still shown, so it can be fixed; its description says why it is not offered. */
  const meta = parsed.ok ? parsed.meta : {};
  return {
    name,
    description: parsed.ok ? parsed.description : `(not usable: ${parsed.error})`,
    status: side.status, author: side.author, created: side.created, updated: side.updated,
    uses: side.uses, worked: side.worked, failed: side.failed, versions: side.versions.length,
    files: listFiles(dir),
    text, body: parsed.ok ? parsed.body : text, meta, dir,
  };
}

const usable = (s: Skill) => !s.description.startsWith("(not usable:");

const infoOf = (s: Skill): SkillInfo => ({
  name: s.name, description: s.description, status: s.status, author: s.author, created: s.created, updated: s.updated,
  uses: s.uses, worked: s.worked, failed: s.failed, files: s.files, versions: s.versions,
});

/** Every skill, most recently changed first. */
export function listSkills(): SkillInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root()).filter((n) => !nameProblem(n)); } catch { return []; }
  return names.map(load).filter((s): s is Skill => s !== null).map(infoOf).sort((a, b) => b.updated - a.updated);
}

export function getSkill(name: string): Skill | null {
  return load(String(name ?? "").trim());
}

const byLabel = (by: SkillAuthor) => (by.kind === "person" ? "you" : by.name);

/**
 * Write a skill, new or changed: its whole SKILL.md, and any files beside it
 * (`null` removes one). The name in the front matter is the folder's. A new
 * skill an agent writes is a draft; one the person writes is live. Changing one
 * keeps the text it replaced.
 */
export function writeSkill(
  text: string,
  by: SkillAuthor,
  files: Record<string, string | Uint8Array | null> = {},
  opts: { rename?: string } = {},
): { info: SkillInfo; created: boolean } {
  const parsed = parseSkillMd(text);
  if (!parsed.ok) throw new SkillError(parsed.error);
  const dir = dirOf(parsed.name);
  const from = opts.rename && opts.rename !== parsed.name ? getSkill(opts.rename) : null;
  if (opts.rename && opts.rename !== parsed.name && !from) throw new SkillError(`There is no skill "${opts.rename}" to rename.`);
  const existing = fs.existsSync(path.join(dir, "SKILL.md"));
  if (from && existing) throw new SkillError(`There is already a skill called "${parsed.name}".`);
  if (from) fs.renameSync(from.dir, dir);
  const before = from ?? (existing ? load(parsed.name) : null);

  /* The files are checked before anything is written, so a refused write leaves the skill as it was. */
  const planned = new Map<string, Uint8Array | null>();
  for (const [rel, data] of Object.entries(files)) {
    const target = inside(dir, rel);
    if (!target) throw new SkillError(`"${rel}" is not a path inside the skill's folder (SKILL.md itself is the text; hidden files are not kept).`);
    const bytes = data === null ? null : typeof data === "string" ? strToU8(data) : data;
    if (bytes && bytes.byteLength > FILE_MAX) throw new SkillError(`"${rel}" is over ${FILE_MAX / 1_000_000} MB.`);
    if (bytes && typeof data === "string" && SECRET.test(data)) throw new SkillError(`"${rel}" holds what looks like a password, key or token. Read it from an environment variable or a saved credential instead.`);
    planned.set(target, bytes);
  }
  /* What each file this write changes held before it (null: it was not there), so an edit keeps the old script too. */
  const beforeFiles: Record<string, string | null> = {};
  for (const [rel, data] of Object.entries(files)) {
    if (data !== null && typeof data !== "string") continue;
    const target = inside(dir, rel);
    if (!target) continue;
    let old: string | null;
    try {
      const had = fs.readFileSync(target);
      if (had.includes(0) || had.byteLength > VERSION_FILE_MAX) continue;
      old = had.toString("utf8");
    } catch { old = null; }
    const next = data === null ? null : data.replace(/\r\n?/g, "\n");
    if (old !== next) beforeFiles[rel.replace(/^\.?\//, "")] = old;
  }
  const kept = before ? before.files.filter((f) => !planned.has(path.join(dir, f))) : [];
  const total = kept.reduce((n, f) => n + (fs.statSync(path.join(dir, f)).size), 0) +
    [...planned.values()].reduce((n, b) => n + (b?.byteLength ?? 0), 0);
  if (total > TOTAL_MAX) throw new SkillError(`A skill's files come to at most ${TOTAL_MAX / 1_000_000} MB.`);
  if (kept.length + [...planned.values()].filter(Boolean).length > FILES_MAX) throw new SkillError(`A skill holds at most ${FILES_MAX} files.`);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [target, bytes] of planned) {
    if (bytes === null) { fs.rmSync(target, { force: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode: modeFor(target) });
  }
  const side = readSidecar(dir);
  const now = Date.now();
  if (before) {
    if (before.text !== text || Object.keys(beforeFiles).length > 0) {
      side.versions = [
        { at: now, by: byLabel(by), text: before.text, ...(Object.keys(beforeFiles).length ? { files: beforeFiles } : {}) },
        ...side.versions,
      ].slice(0, VERSIONS_KEPT);
    }
  } else {
    side.status = by.kind === "agent" ? "draft" : "live";
    side.author = by;
    side.created = now;
  }
  side.updated = now;
  fs.writeFileSync(path.join(dir, "SKILL.md"), text.replace(/\r\n?/g, "\n"), { mode: 0o600 });
  writeSidecar(dir, side);
  return { info: infoOf(load(parsed.name)!), created: !before };
}

/** Write a skill from its parts rather than a whole SKILL.md: what the agent's tool and the page's form send. */
export function writeSkillParts(
  input: { name: string; description: string; body: string; meta?: Record<string, unknown> },
  by: SkillAuthor,
  files?: Record<string, string | Uint8Array | null>,
  opts?: { rename?: string },
) {
  return writeSkill(composeSkillMd(String(input.name ?? "").trim(), String(input.description ?? ""), String(input.body ?? ""), input.meta), by, files, opts);
}

function update(name: string, change: (s: Sidecar) => void): SkillInfo {
  const s = getSkill(name);
  if (!s) throw new SkillError(`There is no skill "${name}".`);
  const side = readSidecar(s.dir);
  change(side);
  writeSidecar(s.dir, side);
  return infoOf(load(name)!);
}

/** The person says a draft is good: it is offered as a skill like any other. */
export const approveSkill = (name: string) => update(name, (s) => { s.status = "live"; });

/** Put back the text an edit replaced (`index` 0 is the latest), keeping the current one as a version in its turn. */
export function revertSkill(name: string, index = 0): SkillInfo {
  const s = getSkill(name);
  if (!s) throw new SkillError(`There is no skill "${name}".`);
  const side = readSidecar(s.dir);
  const v = side.versions[index];
  if (!v) throw new SkillError("There is no earlier version to go back to.");
  const parsed = parseSkillMd(v.text);
  if (!parsed.ok || parsed.name !== name) throw new SkillError("That earlier version is not a valid skill of this name.");
  /* The files that version changed go back as they were then; what they hold now is kept, so this too can be undone. */
  const back = v.files ? filesNow(s.dir, Object.keys(v.files)) : null;
  if (v.files) {
    for (const [rel, held] of Object.entries(v.files)) {
      const target = inside(s.dir, rel);
      if (!target) continue;
      if (held === null) { fs.rmSync(target, { force: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, held, { mode: modeFor(target) });
    }
  }
  side.versions = [
    { at: Date.now(), by: "you", text: s.text, ...(back && Object.keys(back).length ? { files: back } : {}) },
    ...side.versions.filter((_, i) => i !== index),
  ].slice(0, VERSIONS_KEPT);
  side.updated = Date.now();
  fs.writeFileSync(path.join(s.dir, "SKILL.md"), v.text, { mode: 0o600 });
  writeSidecar(s.dir, side);
  return infoOf(load(name)!);
}

export function deleteSkill(name: string): boolean {
  const s = getSkill(name);
  if (!s) return false;
  fs.rmSync(s.dir, { recursive: true, force: true });
  return true;
}

/** The earlier versions of a skill's text, newest first. */
export function skillVersions(name: string): Sidecar["versions"] {
  const s = getSkill(name);
  return s ? readSidecar(s.dir).versions : [];
}

/** One file of a skill, as text, or why not. */
export function readSkillFile(name: string, rel: string, max = 40_000): { ok: true; text: string } | { ok: false; error: string } {
  const s = getSkill(name);
  if (!s) return { ok: false, error: `There is no skill "${name}".` };
  if (String(rel).replace(/^\.?\//, "") === "SKILL.md") return { ok: true, text: s.text };
  const target = inside(s.dir, rel);
  if (!target || !fs.existsSync(target)) return { ok: false, error: `"${rel}" is not one of ${name}'s files: ${s.files.join(", ") || "it has none"}.` };
  const bytes = fs.readFileSync(target);
  if (bytes.includes(0)) return { ok: false, error: `"${rel}" is not text. Use it from ${s.dir} directly.` };
  const text = bytes.toString("utf8");
  return { ok: true, text: text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters; read the file at ${target} for the rest)` : text };
}

// -------------------------------------------------------------- use, trust --

/** The skill was loaded into a turn. */
export function noteSkillUsed(name: string): void {
  try { update(name, (s) => { s.uses += 1; }); } catch { /* gone meanwhile */ }
}

/**
 * A turn that used these skills ended, well or not. A draft an agent wrote goes
 * live once it has worked `LIVE_AFTER` times; a failure is counted, not punished,
 * since a turn fails for many reasons.
 */
export function noteSkillOutcome(names: string[], ok: boolean, rounds = 0): { name: string; live: boolean }[] {
  const out: { name: string; live: boolean }[] = [];
  for (const name of new Set(names)) {
    try {
      let live = false;
      update(name, (s) => {
        if (ok) s.worked += 1; else s.failed += 1;
        if (ok && rounds > 0) s.steps = [...s.steps, rounds].slice(-STEPS_KEPT);
        if (ok && s.status === "draft" && s.worked >= LIVE_AFTER) { s.status = "live"; live = true; }
      });
      out.push({ name, live });
    } catch { /* gone meanwhile */ }
  }
  return out;
}

/**
 * How many rounds of tool calls a turn using this skill usually takes: the median
 * of the ones that went well, once there are two. What a turn running far past it
 * is told (see `overBudget`).
 */
export function typicalSteps(name: string): number | null {
  const s = getSkill(name);
  if (!s) return null;
  const steps = [...readSidecar(s.dir).steps].sort((a, b) => a - b);
  if (steps.length < 2) return null;
  const mid = Math.floor(steps.length / 2);
  return steps.length % 2 ? steps[mid] : Math.round((steps[mid - 1] + steps[mid]) / 2);
}

/**
 * A soft budget for a turn that follows skills: past twice what they usually take
 * (and never under a floor, since a short skill can meet a slow site), the note
 * the agent reads once, to re-plan or say what is in the way. Null within budget.
 */
export function overBudget(names: Iterable<string>, rounds: number, floor = 8): string | null {
  let budget = 0;
  const usual: string[] = [];
  for (const name of new Set(names)) {
    const typical = typicalSteps(name);
    if (typical === null) continue;
    budget = Math.max(budget, typical * 2);
    usual.push(`${name} about ${typical}`);
  }
  if (!usual.length || rounds <= Math.max(floor, budget)) return null;
  return (
    `[Step budget] This turn has taken ${rounds} rounds; the skill${usual.length === 1 ? "" : "s"} it follows usually take${usual.length === 1 ? "s" : ""} ` +
    `${usual.join(", ")}. Something is different this time. Before the next call, say what is in the way and whether the ` +
    "skill's steps still fit; change course, or stop and tell the person. If the skill was wrong, fix it afterwards with skill action=write."
  );
}

/**
 * What the agent is shown every turn: each usable skill's name and description,
 * best used first. Past `CATALOGUE_MAX` the rest are named without their
 * descriptions; `skill action=list` searches them all.
 */
export function catalogue(): string {
  const all = listSkills().filter((s) => !s.description.startsWith("(not usable:"));
  if (!all.length) return "";
  all.sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || b.worked - a.worked || b.uses - a.uses || b.updated - a.updated);
  const lines: string[] = [];
  let size = 0;
  const rest: string[] = [];
  for (const s of all) {
    const line = `  - ${s.name}${s.status === "draft" ? " (draft, not yet approved)" : ""}: ${s.description}`;
    if (size + line.length > CATALOGUE_MAX) { rest.push(s.name); continue; }
    lines.push(line);
    size += line.length;
  }
  if (rest.length) lines.push(`  - and ${rest.length} more, by name only: ${rest.join(", ")}`);
  return lines.join("\n");
}

/** Skills whose name or description match a few words, best first: for a library too long to show whole. */
export function findSkills(query: string, limit = 12): SkillInfo[] {
  const words = String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const all = listSkills();
  if (!words.length) return all.slice(0, limit);
  return all
    .map((s) => {
      const hay = `${s.name.replace(/-/g, " ")} ${s.description}`.toLowerCase();
      return { s, score: words.reduce((n, w) => n + (hay.includes(w) ? (s.name.includes(w) ? 2 : 1) : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.worked - a.s.worked)
    .slice(0, limit)
    .map((x) => x.s);
}

/** A skill as the agent receives it when it picks one: the instructions, and where its files are. */
export function skillForUse(name: string): { ok: true; text: string; skill: Skill } | { ok: false; error: string } {
  const s = getSkill(name);
  if (!s) {
    const near = findSkills(name, 3).map((x) => x.name);
    return { ok: false, error: `There is no skill "${name}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""}` };
  }
  if (!usable(s)) return { ok: false, error: `${name} is not usable as written: ${s.description.slice(14, -1)}. Fix it with skill action=write.` };
  const files = s.files.length
    ? `\n\nFiles in this skill (folder ${s.dir}): ${s.files.join(", ")}. Read one with skill action=read; run a script from that folder with the terminal.`
    : "";
  const typical = typicalSteps(s.name);
  const pace = typical !== null ? `\n\n(Turns that used this skill and went well took about ${typical} rounds of tool calls.)` : "";
  const draft = s.status === "draft" ? "\n\n(This is a draft another agent wrote and the person has not approved yet: follow it, and fix it with skill action=write if it proves wrong.)" : "";
  return { ok: true, skill: s, text: `Skill ${s.name}: ${s.description}\n\n${s.body}${files}${pace}${draft}` };
}

// ------------------------------------------------------- import and export --

/**
 * Skills from a zip: every folder in it that holds a SKILL.md (or the zip's
 * root, when SKILL.md is at the top). Each is held to the format; one that is
 * not is reported and skipped, the others still come in. An imported skill is
 * the person's, and live, unless it replaces one -- then the old text is kept as
 * a version.
 */
export function importSkills(bytes: Uint8Array, by: SkillAuthor = { kind: "person" }): { imported: SkillInfo[]; skipped: { where: string; error: string }[] } {
  if (bytes.byteLength > TOTAL_MAX * 4) throw new SkillError("That file is too large to be a skill.");
  let entries: Record<string, Uint8Array>;
  try { entries = unzipCapped(bytes, { max: TOTAL_MAX * 8 }); } catch { throw new SkillError("That is not a zip file. Export a skill folder as a .zip, or paste its SKILL.md."); }
  const roots = Object.keys(entries)
    .filter((p) => !p.startsWith("__MACOSX/") && (p === "SKILL.md" || p.endsWith("/SKILL.md")))
    .map((p) => p.slice(0, -"SKILL.md".length));
  if (!roots.length) throw new SkillError("No SKILL.md in that zip. A skill is a folder with SKILL.md at its top.");
  const imported: SkillInfo[] = [];
  const skipped: { where: string; error: string }[] = [];
  for (const prefix of roots) {
    try {
      const text = strFromU8(entries[`${prefix}SKILL.md`]);
      const files: Record<string, Uint8Array> = {};
      for (const [p, data] of Object.entries(entries)) {
        if (!p.startsWith(prefix) || p.endsWith("/") || p === `${prefix}SKILL.md`) continue;
        const rel = p.slice(prefix.length);
        if (roots.some((r) => r !== prefix && r.startsWith(prefix) && p.startsWith(r))) continue;
        if (rel.split("/").some((x) => x.startsWith("."))) continue;
        files[rel] = data;
      }
      imported.push(writeSkill(text, by, files).info);
    } catch (err) {
      skipped.push({ where: prefix || "SKILL.md", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { imported, skipped };
}

/** A skill as a zip of its folder, ready to use anywhere that reads the format. */
export function exportSkill(name: string): Uint8Array {
  const s = getSkill(name);
  if (!s) throw new SkillError(`There is no skill "${name}".`);
  const files: Record<string, Uint8Array> = { [`${name}/SKILL.md`]: strToU8(s.text) };
  for (const f of s.files) files[`${name}/${f}`] = new Uint8Array(fs.readFileSync(path.join(s.dir, f)));
  return zipSync(files);
}

/** Every skill as one zip, each in its own folder: the whole library in a file. */
export function exportSkills(): { zip: Uint8Array; count: number } {
  const skills = listSkills();
  if (!skills.length) throw new SkillError("There are no skills to export yet.");
  const files: Record<string, Uint8Array> = {};
  for (const info of skills) {
    const s = getSkill(info.name);
    if (!s) continue;
    files[`${s.name}/SKILL.md`] = strToU8(s.text);
    for (const f of s.files) files[`${s.name}/${f}`] = new Uint8Array(fs.readFileSync(path.join(s.dir, f)));
  }
  return { zip: zipSync(files), count: skills.length };
}

/**
 * Write one file beside a skill's SKILL.md (null removes it), leaving SKILL.md as
 * it is. What it replaces is kept as a version, so a bad script is one step back.
 */
export function writeSkillFile(name: string, rel: string, text: string | null, by: SkillAuthor): SkillInfo {
  const s = getSkill(name);
  if (!s) throw new SkillError(`There is no skill "${name}".`);
  /* Checked before the leading ./ is stripped, or "/etc/passwd" would read as a file inside the folder. */
  const raw = String(rel ?? "").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new SkillError(`"${raw}" is an absolute path: name the file from the skill's folder, like scripts/run.sh.`);
  }
  const clean = raw.replace(/^\.?\//, "");
  if (!inside(s.dir, clean)) {
    throw new SkillError(`"${clean}" is not a path inside the skill's folder (SKILL.md itself is the text; hidden files are not kept).`);
  }
  return writeSkill(s.text, by, { [clean]: text }).info;
}

// -------------------------------------------------------------- migration --

/**
 * Turn the Mind's old "skill" memories into skills. Each becomes a SKILL.md:
 * its title the name and the start of the description, its text the
 * instructions. What was confirmed comes in live; what was still a guess comes
 * in as a draft. The memory is then let go by the caller, so a way of working
 * lives in one place.
 */
function skillFromMemory(
  record: { title: string; body: string; tags: string[]; status?: string },
  by: SkillAuthor,
): SkillInfo | null {
  const title = record.title.trim();
  const body = record.body.trim();
  if (!title || !body) return null;
  let name = slugOf(title);
  for (let n = 2; getSkill(name); n++) name = `${slugOf(title).slice(0, NAME_MAX - 3)}-${n}`;
  const topics = record.tags.filter((t) => !["skill", "learned", "agent-authored", "unconfirmed", "proven", "automation"].includes(t));
  const description = `${title.replace(/\.$/, "")}.${topics.length ? ` Use for work about ${topics.slice(0, 4).join(", ")}.` : " Use when the work matches this."}`
    .slice(0, DESCRIPTION_MAX);
  const instructions = body.length >= 40 ? body : `${body}\n\n(Brought over from a short note in the Mind: expand it the next time it is used.)`;
  const text = composeSkillMd(name, description.length >= 20 ? description : `${description} Use when this kind of work comes up.`, `# ${title}\n\n${instructions}`);
  try {
    const { info } = writeSkill(text, by);
    if (record.status === "provisional" || by.kind === "agent") return update(info.name, (s) => { s.status = record.status === "provisional" ? "draft" : "live"; });
    return info;
  } catch {
    return null;
  }
}

/** Every "skill" memory in a mind made into a skill and let go from the mind; how many moved. Safe to run on every start. */
export function moveSkillsOutOf(
  mind: { active(): { id: string; kind: string; title: string; body: string; tags: string[]; status?: string }[]; forget(id: string): boolean },
  by: SkillAuthor,
): number {
  let moved = 0;
  for (const r of mind.active().filter((x) => x.kind === "skill")) {
    if (skillFromMemory(r, by)) moved += 1;
    /* One that could not become a skill (no text) is dropped all the same: the Mind keeps no skills. */
    mind.forget(r.id);
  }
  return moved;
}
