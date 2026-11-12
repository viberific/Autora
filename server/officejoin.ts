/**
 * Joined windows, kept live (src/lib/panacea/joins.ts). The person dragged the Sheets window onto the Pages window and
 * let go: the document shows the sheet's table, and every change to the sheet (the person's, the agent's, a version
 * gone back to) is in the document's table a moment later, in the open Pages window, without reopening anything.
 *
 * How: the table in the document is an ordinary Word table that carries a mark in its alt text (`w:tblDescription`,
 * which GenOffice's editor keeps when it saves). When the sheet changes, its first sheet's used cells are read, and the
 * marked table is written again from them (or added at the end of the document the first time). It is rewritten only
 * when its words differ from the sheet's, so the editor's own way of saving a table never starts a loop, and an edit
 * the person makes elsewhere in the document is never touched.
 *
 * What it is not (phase 1): a change made to the table in the document does not go back to the sheet (the next change
 * to the sheet writes over it); only the first sheet is shown, as plain values (a number format such as a date or a
 * currency is not applied); and an exported .docx holds the table as a copy, not a link.
 */
import crypto from "node:crypto";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { joinMark, type Join } from "../src/lib/panacea/joins";
import { officeData, joinedChange, sincePersonSave, watchOfficeChange, xlsxCells, type OfficeKind } from "./officedesk";

/** The most of a sheet a document's table shows; the rest is said to be there. */
const MAX_ROWS = 60;
const MAX_COLS = 16;
/** How long a change waits for more (typing in the sheet saves several times), and for the person's typing in the document to settle. */
const SETTLE_MS = 700;
const TYPING_MS = 1500;
/** The width of a page's text on Letter with 1" margins, in twentieths of a point. */
const TEXT_WIDTH = 9360;

const KIND_OF: Record<string, OfficeKind> = { "engine:sheets": "xlsx", "engine:pages": "docx", "engine:slides": "pptx" };

interface SheetTable { sheet: string; rows: string[][]; clipped: boolean }

const colNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** A value as the sheet shows it: a float's binary noise rounded off ("0.30000000000000004" is 0.3). */
function shown(value: string): string {
  if (/^-?\d+\.\d{9,}$/.test(value)) return String(Number(Number(value).toPrecision(12)));
  return value;
}

/** The first sheet's filled cells as rows, from its top-left filled cell to its bottom-right; null when it has none. */
function sheetTable(xlsx: Buffer): SheetTable | null {
  const cells = xlsxCells(xlsx, { values: true });
  if (!cells || cells.size === 0) return null;
  const first = cells.keys().next().value?.split("!")[0];
  if (first === undefined) return null;
  const at = new Map<string, string>();
  let top = Infinity, left = Infinity, bottom = 0, right = 0;
  for (const [ref, value] of cells) {
    const bang = ref.lastIndexOf("!");
    if (ref.slice(0, bang) !== first) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(ref.slice(bang + 1));
    if (!m || value.trim() === "") continue;
    const c = colNumber(m[1]!), r = Number(m[2]);
    at.set(`${r}:${c}`, value);
    top = Math.min(top, r); left = Math.min(left, c); bottom = Math.max(bottom, r); right = Math.max(right, c);
  }
  if (!at.size) return null;
  const lastRow = Math.min(bottom, top + MAX_ROWS - 1), lastCol = Math.min(right, left + MAX_COLS - 1);
  const rows: string[][] = [];
  for (let r = top; r <= lastRow; r += 1) {
    const row: string[] = [];
    for (let c = left; c <= lastCol; c += 1) row.push(shown(at.get(`${r}:${c}`) ?? ""));
    rows.push(row);
  }
  return { sheet: first, rows, clipped: lastRow < bottom || lastCol < right };
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The table, as Word writes one: bordered, the first row bold, the page's width shared between the columns. */
function tableXml(table: SheetTable, mark: string, caption: string): string {
  const cols = Math.max(1, ...table.rows.map((r) => r.length));
  const w = Math.floor(TEXT_WIDTH / cols);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const rows = [...table.rows, ...(table.clipped ? [[`… more in ${table.sheet}`, ...Array<string>(cols - 1).fill("")]] : [])];
  const tr = rows.map((row, i) => {
    const bold = i === 0 ? "<w:rPr><w:b/></w:rPr>" : "";
    const tcs = Array.from({ length: cols }, (_, c) => {
      const text = row[c] ?? "";
      const p = text ? `<w:p><w:r>${bold}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>` : "<w:p/>";
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${p}</w:tc>`;
    }).join("");
    return `<w:tr>${tcs}</w:tr>`;
  }).join("");
  return "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>" +
    `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
    "<w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/>" +
    `<w:tblCaption w:val="${esc(caption)}"/><w:tblDescription w:val="${esc(mark)}"/></w:tblPr>` +
    `<w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(cols)}</w:tblGrid>${tr}</w:tbl>`;
}

/** Where the marked table is in a document's body: [start, end) of its `<w:tbl>`, nested tables and all. */
function markedTable(xml: string, mark: string): [number, number] | null {
  const re = new RegExp(`<w:tblDescription\\b[^>]*\\bw:val="${esc(mark).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const hit = re.exec(xml);
  if (!hit) return null;
  // The table that holds the mark: the nearest opening before it whose own end is after it.
  const opening = /<w:tbl>/g;
  let start = -1;
  for (let m = opening.exec(xml); m && m.index < hit.index; m = opening.exec(xml)) start = m.index;
  if (start < 0) return null;
  const tag = /<w:tbl>|<\/w:tbl>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    depth += m[0] === "<w:tbl>" ? 1 : -1;
    if (depth === 0) return [start, m.index + m[0].length];
  }
  return null;
}

/** The words of a table's cells, row by row, the way they compare with a sheet's. */
function tableWords(tbl: string): string[][] {
  return [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) =>
    [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) =>
      [...tc[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((t) => unesc(t[1] ?? "")).join("")));
}

/**
 * The document with the joined table in it, as the sheet has it now: the marked table rewritten in place, or added at
 * the end the first time. Null when the document already shows exactly this, or cannot be read.
 */
function withJoinedTable(docx: Buffer, table: SheetTable, mark: string, caption: string): Buffer | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(docx));
  } catch {
    return null;
  }
  const part = files["word/document.xml"];
  if (!part) return null;
  const xml = strFromU8(part);
  const fresh = tableXml(table, mark, caption);
  const had = markedTable(xml, mark);
  let next: string;
  if (had) {
    const now = xml.slice(had[0], had[1]);
    if (JSON.stringify(tableWords(now)) === JSON.stringify(tableWords(fresh))) return null;
    next = xml.slice(0, had[0]) + fresh + xml.slice(had[1]);
  } else {
    // Before the body's own section properties (its last child), with the empty paragraph Word wants after a table.
    const end = xml.lastIndexOf("</w:body>");
    if (end < 0) return null;
    const sect = xml.lastIndexOf("<w:sectPr", end);
    const at = sect >= 0 && !xml.slice(sect, end).includes("</w:p>") ? sect : end;
    next = `${xml.slice(0, at)}${fresh}<w:p/>${xml.slice(at)}`;
  }
  files["word/document.xml"] = strToU8(next);
  return Buffer.from(zipSync(files));
}

// --------------------------------------------------------- keeping it live --

interface JoinHooks {
  /** The joins on a chat's canvas (server/panacea.ts). */
  joinsOf(session: string): readonly Join[];
  /** What a document's table is called, from the file in the joined window. */
  nameOf(session: string, kind: OfficeKind): string;
}

/** Per chat: what was last seen of each joined window's work and of its joins, and the change waiting to go in. */
const seen = new Map<string, { sheets: Map<string, string>; joins: string; timer?: NodeJS.Timeout }>();

const hashOf = (data: Buffer | null) => (data ? crypto.createHash("sha1").update(data).digest("hex") : "");

let hooks: JoinHooks | null = null;

/** Bring every join of the chat up to date, now. What it changed, in words, one line per document. */
function syncJoins(session: string): string[] {
  if (!hooks) return [];
  const said: string[] = [];
  for (const join of hooks.joinsOf(session)) {
    const fromKind = KIND_OF[join.from], toKind = KIND_OF[join.to];
    if (fromKind !== "xlsx" || toKind !== "docx") continue;
    const sheet = officeData(session, fromKind), doc = officeData(session, toKind);
    if (!sheet || !doc) continue;
    const table = sheetTable(sheet);
    if (!table) continue;
    const name = hooks.nameOf(session, fromKind);
    const next = withJoinedTable(doc, table, joinMark(join.from), `Linked from Autora Sheets: ${name}`);
    if (!next) continue;
    const label = `the table from ${name} (joined from Autora Sheets) was brought up to date`;
    if (joinedChange(session, toKind, next, label)) said.push(label);
  }
  return said;
}

function schedule(session: string) {
  const s = seen.get(session);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(function run() {
    // The person is typing in a joined document: their next save is not overtaken by a document without it.
    const busy = hooks?.joinsOf(session).some((j) => KIND_OF[j.to] && sincePersonSave(session, KIND_OF[j.to]!) < TYPING_MS);
    if (busy) { s.timer = setTimeout(run, TYPING_MS); return; }
    s.timer = undefined;
    syncJoins(session);
  }, SETTLE_MS);
  s.timer.unref?.();
}

/**
 * Something changed in a chat: its canvas (a join made or taken away) or one of its windows. A join is brought up to
 * date when it is new, or when the work it shows changed; a change to the document it shows in is that document's own.
 */
export function joinsTouched(session: string) {
  if (!hooks) return;
  const joins = hooks.joinsOf(session);
  if (!joins.length && !seen.has(session)) return;
  const s = seen.get(session) ?? { sheets: new Map<string, string>(), joins: "" };
  seen.set(session, s);
  const key = joins.map((j) => `${j.from}>${j.to}`).sort().join("|");
  let due = key !== s.joins && joins.length > 0;
  s.joins = key;
  for (const j of joins) {
    const kind = KIND_OF[j.from];
    if (!kind) continue;
    const h = hashOf(officeData(session, kind));
    if (s.sheets.get(j.from) !== h) { s.sheets.set(j.from, h); due = true; }
  }
  if (!joins.length) { forgetJoins(session); return; }
  if (due) schedule(session);
}

/** The chat is gone. */
export function forgetJoins(session: string) {
  const s = seen.get(session);
  if (s?.timer) clearTimeout(s.timer);
  seen.delete(session);
}

/** Wired once by server.ts: told of every window's change, and of every canvas's (it calls `joinsTouched`). */
export function startOfficeJoins(h: JoinHooks) {
  hooks = h;
  watchOfficeChange((session, kind) => { if (kind !== "docx") joinsTouched(session); });
}
