/**
 * File routing only: no filesystem access, imports of engines, or tool execution.
 * Resolve artifact ids/names on the server first and pass its name plus a usable
 * file reference. A route describes capability, not permission or valid file bytes.
 */

export const PANACEA_NATIVE_FORMATS = [
  { kind: "image", extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp"] },
  // XLSX's native data view is opt-in; its default is the full Sheets engine.
  { kind: "data", extensions: [".csv", ".tsv", ".xlsx"] },
  { kind: "doc", extensions: [".md", ".markdown"] },
  // Panacea itself decides whether a .txt contains a table or a document.
  { kind: "doc-or-data", extensions: [".txt"] },
  // Includes documents and boards; restore with loadIntoPanacea, not a surface import.
  { kind: "canvas", extensions: [".panacea.json"] },
] as const;

/**
 * Bounded allowlists from office.ts, opencut.ts's MIME table, photodesk.ts and
 * the existing saved-project loaders. Export-only CAD formats are not imports.
 * XLSX defaults to Sheets for workbook fidelity. Markdown and CSV remain native
 * unless an engine is requested; native:true explicitly requests a native view.
 */
export const PANACEA_ENGINE_FORMATS = [
  { engine: "pages", tool: "office_open", extensions: [".docx"], operation: "open" },
  { engine: "sheets", tool: "office_open", extensions: [".xlsx"], operation: "open" },
  { engine: "slides", tool: "office_open", extensions: [".pptx"], operation: "open" },
  { engine: "pages", tool: "office_convert", extensions: [".html", ".htm", ".md", ".markdown"], operation: "convert" },
  { engine: "sheets", tool: "office_convert", extensions: [".csv"], operation: "convert" },
  { engine: "pdf", tool: "pdf_look", extensions: [".pdf"], operation: "look" },
  { engine: "video", tool: "video_import", extensions: [".mp4", ".m4v", ".mov", ".webm", ".mkv"], operation: "import" },
  { engine: "video", tool: "video_import", extensions: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"], operation: "import" },
  { engine: "video", tool: "video_import", extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp"], operation: "import" },
  { engine: "photo", tool: "photo_open", extensions: [".psd", ".pcraft", ".bmp", ".tif", ".tiff", ".png", ".jpg", ".jpeg", ".gif", ".webp"], operation: "open" },
  { engine: "studio", tool: null, loader: "loadSong", extensions: [".song.json"], operation: "load" },
  { engine: "cad", tool: null, loader: "loadModel", extensions: [".model.json"], operation: "load" },
  // Generic JSON is ambiguous: only a supplied, parsed GDevelop project matches.
  { engine: "game", tool: null, loader: "loadGame", extensions: [".json"], operation: "load", requires: "gdevelop-project" },
] as const;

export type PanaceaEngineName = typeof PANACEA_ENGINE_FORMATS[number]["engine"];

type FileArgs = { file: string };
type EngineRoute =
  | { status: "engine"; engine: "pages" | "sheets" | "slides"; tool: "office_open"; args: FileArgs }
  | { status: "engine"; engine: "pages"; tool: "office_convert"; args: FileArgs & { to: "docx" } }
  | { status: "engine"; engine: "sheets"; tool: "office_convert"; args: FileArgs & { to: "xlsx" } }
  | { status: "engine"; engine: "pdf"; tool: "pdf_look"; args: FileArgs & { pages: "1" } }
  | { status: "engine"; engine: "video"; tool: "video_import"; args: FileArgs & { name: string } }
  | { status: "engine"; engine: "photo"; tool: "photo_open"; args: FileArgs };
type LoaderRoute =
  | { status: "loader"; engine: "studio"; tool: null; loader: "loadSong"; args: FileArgs }
  | { status: "loader"; engine: "cad"; tool: null; loader: "loadModel"; args: FileArgs }
  | { status: "loader"; engine: "game"; tool: null; loader: "loadGame"; args: FileArgs };
export type PanaceaFileRoute =
  | EngineRoute
  | LoaderRoute
  | { status: "native"; kind: typeof PANACEA_NATIVE_FORMATS[number]["kind"] }
  | { status: "unsupported"; reason: "invalid-reference" | "invalid-options" | "conflicting-options" | "resolve-name" | "ambiguous-json" | "engine-mismatch" | "not-supported" };

export type PanaceaFileInput = string | {
  /** A reference the target tool can read: artifact id or host path. */
  file: string;
  /** readFileRef.name, not an artifact id or an untrusted MIME hint. */
  name: string;
  /** An explicit fidelity/workflow choice; never fall back to another engine. */
  engine?: PanaceaEngineName;
  /** Request only a native view (including XLSX as data), mutually exclusive with engine. */
  native?: boolean;
  /** Optional parsed JSON from the resolved bytes, needed for generic Game.json. */
  json?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Same discriminator as gamedesk.ts's looksLikeGame; loadGame validates again.
function isGame(value: unknown): boolean {
  return isObject(value) && isObject(value.properties) && Array.isArray(value.layouts)
    && value.layouts.every((layout: unknown) => isObject(layout) && typeof layout.name === "string");
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * Compound suffixes precede generic .json. XLSX defaults to the full Sheets
 * engine; native:true requests its data view. Other native defaults are unchanged.
 * Known project loaders are separate from agent tools (which cannot load them).
 * The caller must enforce engine settings/incognito/held rules before either.
 * Unavailable engines must be reported by the caller, never retried as native.
 */
export function panaceaFileRoute(input: PanaceaFileInput): PanaceaFileRoute {
  const file = typeof input === "string" ? input : input?.file;
  const givenName = typeof input === "string" ? input : input?.name;
  if (!usable(file) || !usable(givenName)) return { status: "unsupported", reason: "invalid-reference" };
  const engine = typeof input === "string" ? undefined : input.engine;
  const native = typeof input === "string" ? undefined : input.native;
  if (native !== undefined && typeof native !== "boolean") return { status: "unsupported", reason: "invalid-options" };
  if (native !== undefined && engine !== undefined) return { status: "unsupported", reason: "conflicting-options" };
  if (engine !== undefined && !PANACEA_ENGINE_FORMATS.some((format) => format.engine === engine)) {
    return { status: "unsupported", reason: "engine-mismatch" };
  }
  const ref = file.trim();
  const name = givenName.trim().split(/[\\/]/).pop() ?? "";
  if (!name || name === "." || name === "..") return { status: "unsupported", reason: "invalid-reference" };
  if (/^file_[0-9a-f]{16}$/i.test(name)) return { status: "unsupported", reason: "resolve-name" };
  const lower = name.toLowerCase();
  let suffix = "";
  for (const format of [...PANACEA_NATIVE_FORMATS, ...PANACEA_ENGINE_FORMATS]) {
    for (const ext of format.extensions) {
      if (ext.length > suffix.length && lower.endsWith(ext)) suffix = ext;
    }
  }
  if (engine === undefined) {
    for (const format of PANACEA_NATIVE_FORMATS) {
      if (suffix === ".xlsx" && native !== true) continue;
      if (format.extensions.some((ext) => ext === suffix)) return { status: "native", kind: format.kind };
    }
  }
  if (native === true) return { status: "unsupported", reason: "not-supported" };
  for (const format of PANACEA_ENGINE_FORMATS) {
    if (engine !== undefined && format.engine !== engine) continue;
    if (!format.extensions.some((ext) => ext === suffix)) continue;
    switch (format.tool) {
      case "office_open": return { status: "engine", engine: format.engine, tool: format.tool, args: { file: ref } };
      case "office_convert":
        return format.engine === "sheets"
          ? { status: "engine", engine: format.engine, tool: format.tool, args: { file: ref, to: "xlsx" } }
          : { status: "engine", engine: format.engine, tool: format.tool, args: { file: ref, to: "docx" } };
      case "pdf_look": return { status: "engine", engine: format.engine, tool: format.tool, args: { file: ref, pages: "1" } };
      case "video_import": return { status: "engine", engine: format.engine, tool: format.tool, args: { file: ref, name } };
      case "photo_open": return { status: "engine", engine: format.engine, tool: format.tool, args: { file: ref } };
      case null:
        switch (format.loader) {
          case "loadSong": return { status: "loader", engine: format.engine, tool: null, loader: format.loader, args: { file: ref } };
          case "loadModel": return { status: "loader", engine: format.engine, tool: null, loader: format.loader, args: { file: ref } };
          case "loadGame":
            return typeof input !== "string" && isGame(input.json)
              ? { status: "loader", engine: format.engine, tool: null, loader: format.loader, args: { file: ref } }
              : { status: "unsupported", reason: "ambiguous-json" };
        }
    }
  }
  return { status: "unsupported", reason: engine === undefined ? "not-supported" : "engine-mismatch" };
}
