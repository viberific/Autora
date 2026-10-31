/** Person-only workspace imports: real raw HTTP, saved Artifacts, loaders and refusal/replacement gates. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startApp } from "./e2e-harness";
import { pngFixture } from "./png-fixture";

const dir = path.resolve(".cache", `workspace-files-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
process.env.AUTORA_STATE_DIR = dir;
const express = (await import("express")).default;
const { saveArtifact, readArtifact, listArtifacts } = await import("../server/artifacts");
const { flushStore } = await import("../server/store");
const { loadPanaceaFile, loadFileRoutes } = await import("../server/loadfile");
const { panaceaRoutes, panaceaState } = await import("../server/panacea");
const { loadable } = await import("../src/lib/loadable");
const { refuseRequest } = await import("../server/crosssite");
const { PDFDocument } = await import("@cantoo/pdf-lib");
const { zipSync, strToU8 } = await import("fflate");
const workbook = Buffer.from(zipSync(Object.fromEntries(Object.entries({
  "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Calculations" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Input</t></is></c><c r="B1" t="inlineStr"><is><t>Calculated</t></is></c></row><row r="2"><c r="A2"><v>3</v></c><c r="B2"><f>A2*2</f><v>6</v></c></row></sheetData></worksheet>',
}).map(([name, text]) => [name, strToU8(text)]))));

const S = "workspacefiles";
let disabled = new Set<string>();
const guards = { exists: (s: string) => s === S || s === "incognito", incognito: (s: string) => s === "incognito", off: (s: string) => disabled.has(s) };
const app = express();
app.use((req, res, next) => {
  const error = refuseRequest(req.method, req.headers);
  if (error) { res.status(403).json({ error }); return; }
  next();
});
// As in the real server, JSON parsing must leave raw binary uploads alone.
app.use(express.json());
panaceaRoutes(app, { ...guards, off: () => guards.off("panacea"), push: () => undefined,
  loadFile: (s, art, opts) => loadPanaceaFile(s, art, opts, guards) });
loadFileRoutes(app, guards);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const request = async (url: string, body: string | Buffer, json = false, extra: Record<string, string> = {}) => {
  const res = await fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": json ? "application/json" : "application/octet-stream", ...extra }, body: typeof body === "string" ? body : new Uint8Array(body) });
  return { status: res.status, body: await res.json() as Record<string, any> };
};
const drop = (name: string, data: string | Buffer, query = "", session = S) => request(`/api/panacea/${session}/import?name=${encodeURIComponent(name)}${query}`, data);
const kept = (name: string, data: string | Buffer) => saveArtifact({ origin: "user", name, data: Buffer.isBuffer(data) ? data : Buffer.from(data), session: S });
const saved = (artifact: string, extra = {}) => request(`/api/sessions/${S}/load`, JSON.stringify({ app: "panacea", artifact, ...extra }), true);
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn(); console.log(`  ok  ${name}`); passed++;
}
try {
  await test("the picker shares authoritative routes, including JSON candidates but no export-only CAD/MIDI", () => {
    for (const name of ["a.docx", "a.pptx", "a.xlsx", "a.pdf", "a.html", "a.psd", "a.pcraft", "a.flac", "a.song.json", "a.model.json", "Game.json", "a.md", "a.txt"]) {
      assert.ok(loadable("panacea", { name, mime: "application/octet-stream" }), name);
    }
    for (const name of ["a.stl", "a.obj", "a.step", "a.mid", "a.zip"]) assert.ok(!loadable("panacea", { name, mime: "application/octet-stream" }));
    assert.ok(!loadable("pages", { name: "a.txt", mime: "text/plain" }));
  });
  await test("native raw document/table/image replies stay unchanged and reopen the canvas", async () => {
    const md = await drop("note.md", "# Note\n\nWords.");
    assert.equal(md.status, 200); assert.equal(md.body.kind, "doc"); assert.ok(md.body.doc);
    assert.equal(panaceaState(S).open, true);
    const table = await drop("data.tsv", "a\tb\n1\t2\n");
    assert.equal(table.status, 200); assert.equal(table.body.kind, "data"); assert.equal(table.body.table.rows.length, 1);
    const csv = await request(`/api/panacea/${S}/import?name=more.csv`, "a,b\n1,2\n3,4\n", false, { "Content-Type": "text/csv" });
    assert.equal(csv.status, 200, JSON.stringify(csv.body)); assert.equal(csv.body.kind, "data");
    assert.ok(csv.body.artifact); assert.equal(csv.body.name, "more.csv"); assert.deepEqual(csv.body.table.rows, [[1, 2], [3, 4]]);
    const png = pngFixture(2, 2);
    const image = await drop("image.png", png);
    assert.equal(image.status, 200); assert.equal(image.body.kind, "image"); assert.ok(image.body.artifact);
    assert.equal(image.body.name, "image.png"); assert.deepEqual(image.body.px, { w: 2, h: 2 });
    const complete = pngFixture(640, 480);
    const sized = await request(`/api/panacea/${S}/import?name=sized.png`, complete, false, { "Content-Type": "image/png" });
    assert.equal(sized.status, 200, JSON.stringify(sized)); assert.equal(sized.body.kind, "image");
    assert.ok(sized.body.artifact); assert.equal(sized.body.name, "sized.png"); assert.deepEqual(sized.body.px, { w: 640, h: 480 });
    assert.equal((await drop("header-only.png", complete.subarray(0, 33))).status, 400);
    assert.equal((await saved(kept("truncated.png", complete.subarray(0, complete.length - 12)).id)).status, 400);
    assert.equal((await drop("truncated.png", complete.subarray(0, complete.length - 1))).status, 400);
    const malformed = Buffer.from(complete); malformed.writeUInt32BE(0, 16);
    assert.equal((await drop("zero-width.png", malformed)).status, 400);
    assert.equal((await saved(md.body.artifact)).status, 200);
  });
  await test("song raw upload and saved Artifact use the real fixed loader without a native surface", async () => {
    const before = panaceaState(S).surfaces;
    const song = JSON.stringify({ name: "Loaded song", bpm: 120, tracks: [] });
    const out = await drop("kept.song.json", song);
    assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.body.kind, "engine"); assert.equal(out.body.engine, "studio");
    assert.equal(panaceaState(S).surfaces, before);
    const next = kept("again.song.json", song);
    const refused = await saved(next.id);
    assert.equal(refused.status, 409); assert.equal(refused.body.replaceRequired, true);
    const restored = await saved(next.id, { replace: true });
    assert.equal(restored.status, 200); assert.equal(restored.body.engine, "studio");
    assert.equal(readArtifact(out.body.artifact)?.toString(), song);
  });
  await test("XLSX defaults to full Sheets; flattening is explicit, and an unavailable engine never falls back", async () => {
    const art = kept("formulas.xlsx", workbook);
    const before = panaceaState(S).surfaces;
    disabled.add("sheets");
    const refused = await drop("formulas.xlsx", workbook);
    assert.equal(refused.status, 403); assert.match(refused.body.error, /Sheets.*unavailable|Sheets.*off/i);
    assert.equal((await saved(art.id)).status, 403);
    assert.equal((await drop("broken.xlsx", "not a workbook")).status, 403, "default routing happens before native parsing");
    assert.equal(panaceaState(S).surfaces, before);
    const flat = await drop("formulas.xlsx", workbook, "&native=true");
    assert.equal(flat.status, 200, JSON.stringify(flat)); assert.equal(flat.body.kind, "data");
    assert.deepEqual(flat.body.table.rows, [[3, 6]], "flattening uses cached values only by explicit choice");
    assert.equal((await saved(art.id, { native: true })).status, 200);
    assert.equal(readArtifact(art.id)?.equals(workbook), true, "the original formula-bearing workbook stays intact");
    assert.equal((await drop("broken.xlsx", "not a workbook", "&native=true")).status, 400);
    assert.equal((await drop("formulas.xlsx", workbook, "&native=true&engine=sheets")).status, 415);
    assert.equal((await saved(art.id, { native: false, engine: "sheets" })).status, 415);
    assert.equal((await saved(art.id, { native: "true" })).status, 400);
    assert.equal((await drop("formulas.xlsx", workbook, "&native=yes")).status, 400);
    disabled.delete("sheets");
    const out = await loadPanaceaFile(S, art, {}, guards, async (_session, target, source, route) => {
      assert.equal(target, "sheets"); assert.equal(route?.status, "engine");
      assert.equal(readArtifact(source.id)?.equals(workbook), true);
      return { ok: true };
    });
    assert.equal(out.kind, "engine"); assert.equal(out.engine, "sheets");
  });
  await test("PDF opens validated real bytes; corrupt PDFs and JSON never produce success", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const out = await drop("test.pdf", Buffer.from(await pdf.save()));
    assert.equal(out.status, 200); assert.equal(out.body.engine, "pdf");
    assert.equal((await drop("broken.pdf", "not a PDF", "&replace=true")).status, 400);
    for (const name of ["x.song.json", "x.model.json", "Game.json", "x.panacea.json"]) assert.equal((await drop(name, "{bad")).status, 400);
    assert.equal((await drop("other.json", '{"anything":1}')).status, 415);
    assert.equal((await drop("bad.panacea.json", "{}")).status, 400);
    assert.equal((await drop("wrong.png", "not a picture")).status, 400);
    assert.equal((await drop("broken.xlsx", "not a workbook")).status, 400);
    assert.equal((await drop("empty.csv", "")).status, 400);
    assert.equal((await drop("unknown.mid", "midi")).status, 415);
  });
  await test("canvas replacement requires confirmation and preserves the current canvas on refusal", async () => {
    const before = panaceaState(S).surfaces;
    const raw = JSON.stringify({ name: "Restored", panels: [], surfaces: [], values: {}, gone: [], focus: null });
    const out = await drop("saved.panacea.json", raw);
    assert.equal(out.status, 409); assert.equal(out.body.replaceRequired, true); assert.equal(panaceaState(S).surfaces, before);
    const done = await saved(out.body.artifact, { replace: true });
    assert.equal(done.status, 200); assert.equal(done.body.kind, "canvas"); assert.equal(panaceaState(S).name, "Restored");
    assert.ok(listArtifacts().some((art) => art.note === "Preserved before loading another canvas"));
  });
  await test("missing chat, incognito, off engines, explicit engine mismatch and cross-site requests are refused", async () => {
    assert.equal((await drop("x.md", "words", "", "missing")).status, 404);
    assert.equal((await drop("x.md", "words", "", "incognito")).status, 403);
    disabled = new Set(["panacea"]);
    assert.equal((await drop("x.md", "words")).status, 403);
    disabled = new Set(["video", "photo", "cad", "pages"]);
    for (const name of ["x.mp4", "x.psd", "x.model.json", "x.docx"]) {
      const data = name.endsWith(".json") ? "{}" : "bytes";
      assert.equal((await drop(name, data)).status, 403, name);
    }
    disabled.clear();
    assert.equal((await drop("x.pdf", "bytes", "&engine=studio")).status, 415);
    const cross = await request(`/api/panacea/${S}/import?name=x.md`, "words", false, { "Sec-Fetch-Site": "cross-site", "X-Forwarded-Authorization": "ignored" });
    assert.equal(cross.status, 403);
  });
  await test("injected execution verifies media/layered/Office/GDevelop routing without pretending native engines are installed", async () => {
    for (const [name, data, engine, options] of [
      ["x.mp4", "media", "video", {}], ["x.pcraft", "layers", "photo", {}],
      ["x.xlsx", "workbook", "sheets", {}], ["explicit.xlsx", "workbook", "sheets", { engine: "sheets" }],
      ["x.html", "<p>x</p>", "pages", {}],
      ["Game.json", '{"properties":{},"layouts":[]}', "game", {}],
    ] as const) {
      const art = kept(name, data);
      let called = 0;
      const out = await loadPanaceaFile(S, art, options, guards, async (_session, target, source, route) => {
        called++; assert.equal(target, engine); assert.equal(source.id, art.id);
        assert.ok(route && route.status !== "unsupported" && route.status !== "native");
        return { ok: true };
      });
      assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.engine, engine); assert.equal(called, 1);
    }
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  flushStore();
  fs.rmSync(dir, { recursive: true, force: true });
}

await test("the actual server wires raw and saved workspace loading without a model turn", async () => {
  const real = await startApp();
  try {
    const session = await real.newSession("Workspace files", "build");
    const send = async (name: string, body: string | Buffer, query = "") => {
      const res = await fetch(`${real.base}/api/panacea/${session}/import?name=${encodeURIComponent(name)}${query}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: typeof body === "string" ? body : new Uint8Array(body),
      });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    const md = await send("real.md", "# Loaded by the person\n\nNot a turn.");
    assert.equal(md.status, 200, JSON.stringify(md)); assert.equal(md.body.kind, "doc");
    assert.equal((await real.api("POST", `/api/sessions/${session}/load`, { app: "panacea", artifact: md.body.artifact })).status, 200);
    const song = await send("real.song.json", JSON.stringify({ name: "Person's song", bpm: 100, tracks: [] }));
    assert.equal(song.status, 200, JSON.stringify(song)); assert.equal(song.body.kind, "engine"); assert.equal(song.body.engine, "studio");
    const state = await real.api("GET", `/api/studio/${session}/doc`);
    assert.equal(state.body.doc.name, "Person's song");
    assert.equal((await send("unknown.json", "{}")).status, 415);
    const sheet = await send("real.xlsx", workbook);
    if (sheet.status === 403) assert.match(sheet.body.error, /Sheets.*unavailable|Sheets.*off/i);
    else { assert.equal(sheet.status, 200, JSON.stringify(sheet)); assert.equal(sheet.body.kind, "engine"); assert.equal(sheet.body.engine, "sheets"); }
    const flat = await send("flat.xlsx", workbook, "&native=true");
    assert.equal(flat.status, 200, JSON.stringify(flat)); assert.equal(flat.body.kind, "data");
    const fullSaved = await real.api("POST", `/api/sessions/${session}/load`, { app: "panacea", artifact: flat.body.artifact });
    assert.equal(fullSaved.status, sheet.status === 403 ? 403 : 409, "saved XLSX shares engine availability/replacement guards");
    const flatSaved = await real.api("POST", `/api/sessions/${session}/load`, { app: "panacea", artifact: flat.body.artifact, native: true });
    assert.equal(flatSaved.status, 200, JSON.stringify(flatSaved));
    assert.equal(real.seen.length, 0, "person file loads must not ask a model");
  } finally { await real.stop(); }
});
console.log(`${passed} passed`);
process.exit(0);
