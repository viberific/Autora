import assert from "node:assert/strict";
import {
  PANACEA_ENGINE_FORMATS, PANACEA_NATIVE_FORMATS, panaceaFileRoute,
  type PanaceaEngineName, type PanaceaFileInput,
} from "../server/panacea-formats";

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  ok  ${name}`);
}

test("every native suffix supports explicit native view, including XLSX and content-dependent text", () => {
  for (const format of PANACEA_NATIVE_FORMATS) {
    for (const ext of format.extensions) {
      const name = `a${ext}`;
      const upper = `C:\\Work\\A${ext.toUpperCase()}`;
      assert.deepEqual(panaceaFileRoute({ file: name, name, native: true }), { status: "native", kind: format.kind });
      assert.deepEqual(panaceaFileRoute({ file: upper, name: upper, native: true }), { status: "native", kind: format.kind });
      if (ext !== ".xlsx") {
        assert.deepEqual(panaceaFileRoute(name), { status: "native", kind: format.kind });
        assert.deepEqual(panaceaFileRoute(upper), { status: "native", kind: format.kind });
      }
    }
  }
});

test("every engine suffix has an exact bounded tool or validated loader", () => {
  for (const format of PANACEA_ENGINE_FORMATS) {
    for (const ext of format.extensions) {
      const input = { file: "file_0123456789abcdef", name: `A${ext.toUpperCase()}`, json: { properties: {}, layouts: [] } };
      const got = panaceaFileRoute(input);
      const native = PANACEA_NATIVE_FORMATS.find((candidate) => candidate.extensions.some((suffix) => suffix === ext));
      if (native && ext !== ".xlsx") {
        assert.deepEqual(got, { status: "native", kind: native.kind });
        continue;
      }
      assert.ok(got.status === "engine" || got.status === "loader");
      assert.equal(got.engine, format.engine);
      assert.equal(got.tool, format.tool);
      assert.equal(got.args.file, input.file);
      if (got.status === "loader") {
        assert.equal(format.tool, null);
        assert.ok("loader" in format);
        assert.equal(got.loader, format.loader);
      }
    }
  }
});

test("office opens modern documents/decks; HTML really converts rather than pretending to open", () => {
  assert.deepEqual(panaceaFileRoute("memo.docx"), { status: "engine", engine: "pages", tool: "office_open", args: { file: "memo.docx" } });
  assert.deepEqual(panaceaFileRoute("deck.pptx"), { status: "engine", engine: "slides", tool: "office_open", args: { file: "deck.pptx" } });
  for (const name of ["memo.html", "memo.htm"]) {
    assert.deepEqual(panaceaFileRoute(name), { status: "engine", engine: "pages", tool: "office_convert", args: { file: name, to: "docx" } });
  }
});

test("PDF inspection is bounded to one page, without password guesses", () => {
  assert.deepEqual(panaceaFileRoute("read.pdf"), { status: "engine", engine: "pdf", tool: "pdf_look", args: { file: "read.pdf", pages: "1" } });
});

test("media imports carry the resolved name even when the reference has no suffix", () => {
  assert.deepEqual(panaceaFileRoute({ file: "file_0123456789abcdef", name: "Interview.MOV" }), {
    status: "engine", engine: "video", tool: "video_import", args: { file: "file_0123456789abcdef", name: "Interview.MOV" },
  });
  assert.deepEqual(panaceaFileRoute("C:\\Work\\sound.flac"), {
    status: "engine", engine: "video", tool: "video_import", args: { file: "C:\\Work\\sound.flac", name: "sound.flac" },
  });
});

test("layered photos use the real photo opener, not native flattened images", () => {
  for (const name of ["layers.psd", "layers.pcraft"]) {
    assert.deepEqual(panaceaFileRoute(name), { status: "engine", engine: "photo", tool: "photo_open", args: { file: name } });
  }
});

test("compound native projects do not fall into generic JSON or fake agent open tools", () => {
  assert.deepEqual(panaceaFileRoute("Night.song.json"), {
    status: "loader", engine: "studio", tool: null, loader: "loadSong", args: { file: "Night.song.json" },
  });
  assert.deepEqual(panaceaFileRoute("Stand.model.json"), {
    status: "loader", engine: "cad", tool: null, loader: "loadModel", args: { file: "Stand.model.json" },
  });
  assert.deepEqual(panaceaFileRoute("Ideas.panacea.json"), { status: "native", kind: "canvas" });
});

test("generic JSON requires the GDevelop discriminator; arbitrary data never becomes a game resource", () => {
  const project = { file: "Game.json", name: "Game.json", json: { layouts: [{ name: "Scene" }], properties: {} } };
  assert.deepEqual(panaceaFileRoute(project), { status: "loader", engine: "game", tool: null, loader: "loadGame", args: { file: "Game.json" } });
  for (const json of [undefined, null, [], {}, { properties: {}, layouts: [null] }, { properties: [], layouts: [] }, { properties: {}, layouts: [{ name: 1 }] }]) {
    assert.deepEqual(panaceaFileRoute({ ...project, json }), { status: "unsupported", reason: "ambiguous-json" });
  }
  assert.deepEqual(panaceaFileRoute("Game.json"), { status: "unsupported", reason: "ambiguous-json" });
});

test("unsupported export-only, legacy, MIDI, raw and source formats have no guessed route", () => {
  for (const name of ["part.stl", "part.obj", "part.glb", "part.gltf", "part.step", "part.stp", "part.dxf", "part.fbx",
    "old.doc", "old.xls", "old.ppt", "draft.odt", "score.mid", "score.midi", "raw.cr2", "raw.dng",
    "draw.svg", "page.ts", "archive.zip", "movie.avi", "song.aiff", "caption.srt", "board.json.bak", "Night.song.json.exe",
    "no-extension", ".env", "file_pdf", "whatever.panacea", "thing.unknown"]) {
    assert.deepEqual(panaceaFileRoute(name), { status: "unsupported", reason: "not-supported" }, name);
  }
});

test("opaque artifacts require readFileRef resolution and supplied names override reference suffixes", () => {
  assert.deepEqual(panaceaFileRoute("file_0123456789abcdef"), { status: "unsupported", reason: "resolve-name" });
  assert.deepEqual(panaceaFileRoute({ file: "misleading.exe", name: "actual.png" }), { status: "native", kind: "image" });
  assert.deepEqual(panaceaFileRoute({ file: "misleading.pdf", name: "actual.exe" }), { status: "unsupported", reason: "not-supported" });
});

test("paths, casing and whitespace are deterministic; query strings and URLs are not filenames", () => {
  assert.deepEqual(panaceaFileRoute("  C:\\Work\\MEMO.DOCX  "), {
    status: "engine", engine: "pages", tool: "office_open", args: { file: "C:\\Work\\MEMO.DOCX" },
  });
  assert.deepEqual(panaceaFileRoute("folder.jpg\\data.csv"), { status: "native", kind: "data" });
  assert.deepEqual(panaceaFileRoute("report.pdf?download=1"), { status: "unsupported", reason: "not-supported" });
  assert.deepEqual(panaceaFileRoute("https://example.com/report.pdf"), { status: "unsupported", reason: "invalid-reference" });
});

test("invalid runtime input is rejected explicitly without exposing any data paths", () => {
  for (const input of ["", "  ", ".", "..", "C:\\Work\\", "bad\n.pdf", "a".repeat(4097), null, undefined, 42, {}, { file: "ok.pdf", name: "" }]) {
    assert.deepEqual(panaceaFileRoute(input as PanaceaFileInput), { status: "unsupported", reason: "invalid-reference" });
  }
});

test("routing is pure: inputs and parsed project content are never changed", () => {
  const json = Object.freeze({ layouts: Object.freeze([{ name: "Scene" }]), properties: Object.freeze({}) });
  const input = Object.freeze({ file: "Game.json", name: "Game.json", json });
  assert.deepEqual(panaceaFileRoute(input), panaceaFileRoute(input));
  assert.equal(input.json, json);
  const route = panaceaFileRoute("file_0123456789abcdef");
  assert.equal("args" in route, false);
});

test("XLSX defaults to full Sheets fidelity and native data requires deliberate opt-in", () => {
  const input = { file: "file_0123456789abcdef", name: "Budget.XLSX" };
  const sheets = {
    status: "engine", engine: "sheets", tool: "office_open", args: { file: input.file },
  };
  assert.deepEqual(panaceaFileRoute(input), sheets);
  assert.deepEqual(panaceaFileRoute({ ...input, engine: "sheets" }), sheets);
  assert.deepEqual(panaceaFileRoute({ ...input, engine: undefined }), sheets);
  assert.deepEqual(panaceaFileRoute({ ...input, native: false }), sheets);
  assert.deepEqual(panaceaFileRoute({ ...input, native: undefined }), sheets);
  assert.deepEqual(panaceaFileRoute({ ...input, native: true }), { status: "native", kind: "data" });
  for (const name of ["Budget.xlsx", "Budget.XLSX", "C:\\Work\\Budget.xlsx"]) {
    assert.deepEqual(panaceaFileRoute(name), {
      status: "engine", engine: "sheets", tool: "office_open", args: { file: name },
    });
  }
});

test("every explicitly requested engine accepts only its authoritative format list", () => {
  for (const format of PANACEA_ENGINE_FORMATS) {
    for (const ext of format.extensions) {
      const input = { file: "file_0123456789abcdef", name: `A${ext.toUpperCase()}`, engine: format.engine, json: { properties: {}, layouts: [] } };
      const got = panaceaFileRoute(input);
      assert.ok(got.status === "engine" || got.status === "loader");
      assert.equal(got.engine, format.engine);
      assert.equal(got.tool, format.tool);
      assert.equal(got.args.file, input.file);
      if (got.status === "engine" && got.tool === "office_convert") {
        assert.equal(got.args.to, format.engine === "sheets" ? "xlsx" : "docx");
      }
    }
  }
});

test("native images and real Office conversions can be requested without silent hijacking", () => {
  assert.deepEqual(panaceaFileRoute({ file: "sun.png", name: "sun.png", engine: "photo" }), {
    status: "engine", engine: "photo", tool: "photo_open", args: { file: "sun.png" },
  });
  assert.deepEqual(panaceaFileRoute({ file: "sun.png", name: "sun.png", engine: "video" }), {
    status: "engine", engine: "video", tool: "video_import", args: { file: "sun.png", name: "sun.png" },
  });
  assert.deepEqual(panaceaFileRoute({ file: "table.csv", name: "table.csv", engine: "sheets" }), {
    status: "engine", engine: "sheets", tool: "office_convert", args: { file: "table.csv", to: "xlsx" },
  });
  assert.deepEqual(panaceaFileRoute({ file: "memo.md", name: "memo.md", engine: "pages" }), {
    status: "engine", engine: "pages", tool: "office_convert", args: { file: "memo.md", to: "docx" },
  });
});

test("explicit engine mismatches never fall back to native, another engine, or export-only imports", () => {
  for (const [name, engine] of [
    ["Budget.xlsx", "pages"], ["memo.docx", "sheets"], ["memo.docx", "pdf"], ["sun.png", "studio"],
    ["data.csv", "video"], ["memo.txt", "pages"], ["part.stl", "cad"], ["score.mid", "studio"],
    ["Night.song.json", "game"], ["Stand.model.json", "studio"], ["Ideas.panacea.json", "cad"],
  ] as const) {
    assert.deepEqual(panaceaFileRoute({ file: name, name, engine }), { status: "unsupported", reason: "engine-mismatch" });
  }
  for (const engine of ["browser_open", "", null, 42]) {
    assert.deepEqual(panaceaFileRoute({ file: "memo.docx", name: "memo.docx", engine: engine as PanaceaEngineName }), {
      status: "unsupported", reason: "engine-mismatch",
    });
  }
  assert.deepEqual(panaceaFileRoute({
    file: "Night.song.json", name: "Night.song.json", engine: "game", json: { properties: {}, layouts: [] },
  }), { status: "unsupported", reason: "engine-mismatch" });
});

test("native and engine are exclusive, and malformed native preferences are refused", () => {
  for (const native of [true, false]) {
    assert.deepEqual(panaceaFileRoute({ file: "Budget.xlsx", name: "Budget.xlsx", engine: "sheets", native }), {
      status: "unsupported", reason: "conflicting-options",
    });
  }
  for (const native of ["true", 1, null]) {
    assert.deepEqual(panaceaFileRoute({ file: "Budget.xlsx", name: "Budget.xlsx", native } as unknown as PanaceaFileInput), {
      status: "unsupported", reason: "invalid-options",
    });
  }
  for (const name of ["memo.docx", "read.pdf", "Night.song.json", "Stand.model.json", "unknown.bin"]) {
    assert.deepEqual(panaceaFileRoute({ file: name, name, native: true }), {
      status: "unsupported", reason: "not-supported",
    });
  }
});

test("workbook formulas select the unconverted engine reference; disabled Sheets cannot cause native fallback", () => {
  const workbook = { file: "file_0123456789abcdef", name: "Formula.xlsx", json: { formula: "=SUM(A1:A2)" } };
  const expected = {
    status: "engine", engine: "sheets", tool: "office_open", args: { file: workbook.file },
  };
  // Availability is a caller policy, not a router signal or a fallback format.
  const disabled = Object.assign({}, workbook, { available: { sheets: false } });
  assert.deepEqual(panaceaFileRoute(disabled), expected);
  assert.deepEqual(panaceaFileRoute(workbook), expected);
  assert.deepEqual(workbook.json, { formula: "=SUM(A1:A2)" });
  assert.deepEqual(panaceaFileRoute({ ...workbook, engine: "pages" }), {
    status: "unsupported", reason: "engine-mismatch",
  });
});

console.log(`\n${passed} Panacea format routing tests passed.`);
