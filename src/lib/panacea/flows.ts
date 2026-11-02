/**
 * Where work went between the apps on the board: a 3D model into the game, a picture into a document, a song into the
 * video. A flow is noted when a tool of one app reads a file made by another (server.ts, after the call), or when the
 * person loads one into an app (server/loadfile.ts). The board draws each as a line between the two windows with an
 * arrow halfway along, pointing the way the work went (components/panacea/Board.tsx).
 *
 * Which app a file belongs to is read from its name (a .glb is a model, a .mp4 a video): what each app makes and opens.
 *
 * Pure: plain JSON in and out, saved with the canvas.
 */
import { WORKSPACE_MODES, type WorkspaceMode } from "../workspace";

export interface Flow {
  /** The app the work came from, and the one it went to (workspace modes). */
  from: WorkspaceMode;
  to: WorkspaceMode;
  /** What went: the file's name. */
  what: string;
  /** The artifact, when it was one: a native surface made from it is where a flow to the canvas ends. */
  artifact?: string;
  at: number;
}

const MAX_FLOWS = 40;

const BY_EXT: Array<[RegExp, WorkspaceMode]> = [
  [/\.panacea\.json$/i, "panacea"],
  [/\.model\.json$|\.(glb|gltf|obj|stl|fbx|3mf|ply)$/i, "cad"],
  [/\.song\.json$|\.(mid|midi|wav|mp3|ogg|flac|m4a|aiff?)$/i, "studio"],
  [/\.(mp4|webm|mov|mkv|m4v)$/i, "video"],
  [/\.(png|jpe?g|webp|gif|pcraft|psd|tiff?|bmp)$/i, "photo"],
  [/\.pdf$/i, "pdf"],
  [/\.(docx?|odt|rtf)$/i, "pages"],
  [/\.(xlsx?|ods|csv|tsv)$/i, "sheets"],
  [/\.(pptx?|odp)$/i, "slides"],
  [/\.gdevelop\.json$|\.game\.json$/i, "game"],
];

/** The app a file is the work of, by its name; null for a file no app on the board makes. */
export function appOfFile(name: string): WorkspaceMode | null {
  for (const [re, mode] of BY_EXT) if (re.test(name)) return mode;
  return null;
}

/**
 * The app a kept file is the work of: the one that made it, as the file records. A file the person uploaded records none
 * and is no app's work, so a picture they dropped in is not drawn as Photo's; a file made before apps were recorded falls
 * back to what its name says.
 */
export function appOfArtifact(art: { name: string; origin?: string; app?: string }): WorkspaceMode | null {
  if (art.app) return Object.hasOwn(WORKSPACE_MODES, art.app) ? art.app as WorkspaceMode : null;
  return art.origin === "user" ? null : appOfFile(art.name);
}

const BY_TOOL: Array<[string, WorkspaceMode]> = [
  ["cad_", "cad"], ["game_", "game"], ["video_", "video"], ["studio_", "studio"], ["photo_", "photo"],
  ["pdf_", "pdf"], ["panacea_", "panacea"], ["browser_", "browser"], ["app_", "app"],
];

/** The app a tool works in; an office tool by the file it writes (a document, a workbook, a deck). */
export function appOfTool(tool: string, args: Record<string, unknown>): WorkspaceMode | null {
  if (tool.startsWith("office_")) {
    const kind = String(args.kind ?? args.type ?? "");
    if (/docx|document|word/i.test(kind)) return "pages";
    if (/xlsx|sheet|workbook|excel/i.test(kind)) return "sheets";
    if (/pptx|slide|deck|powerpoint/i.test(kind)) return "slides";
    const file = [args.file, args.path, args.name, args.out].find((v) => typeof v === "string") as string | undefined;
    const mode = file ? appOfFile(file) : null;
    return mode === "pages" || mode === "sheets" || mode === "slides" ? mode : null;
  }
  for (const [prefix, mode] of BY_TOOL) if (tool.startsWith(prefix)) return mode;
  return null;
}

/** A flow noted: the newest of the same two apps and file replaces the older, and the list stays short. */
export function addFlow(list: readonly Flow[], flow: Flow): Flow[] {
  const rest = list.filter((f) => !(f.from === flow.from && f.to === flow.to && f.what === flow.what));
  return [...rest, flow].slice(-MAX_FLOWS);
}

/** Flows from anywhere (disk, the page), checked; those that are not are dropped. */
export function readFlows(raw: unknown, modes: readonly string[]): Flow[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_FLOWS).flatMap((f) => {
    const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    if (!modes.includes(String(r.from)) || !modes.includes(String(r.to)) || r.from === r.to) return [];
    const what = typeof r.what === "string" ? r.what.slice(0, 120) : "";
    if (!what) return [];
    return [{
      from: r.from as WorkspaceMode, to: r.to as WorkspaceMode, what,
      ...(typeof r.artifact === "string" && /^file_[0-9a-f]{16}$/.test(r.artifact) ? { artifact: r.artifact } : {}),
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
    }];
  });
}
