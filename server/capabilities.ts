/**
 * The hosted editors as one table. Each used to be named by its tool prefix in four places that had to be kept in step by
 * hand (the Tools page switch in `windowOff`, the manual in handbook.ts, the tool families in toolload.ts, the files a window
 * opens in src/lib/loadable.ts); `tests/capabilities.test.ts` now checks every one of them against this.
 *
 * Data only, with no imports of the editors, so the handbook and the tool list can read it without loading them.
 * docs/ENGINE-SURVEY.md and intent/2026-11-04-one-adaptive-engine.md say why.
 */

export interface Capability {
  /** The tool family, the manual and the prefix of its tools (`pdf_*`). */
  id: "pdf" | "video" | "studio" | "office" | "cad" | "game" | "photo";
  name: string;
  /** The editor Autora carries as its own fork (docs/MODULES.md). */
  engine: string;
  /** The Panacea work modes it serves (src/lib/workspace.ts). */
  modes: string[];
  /** The Tools page switches that turn it on: it is on when any of them is. */
  windows: Array<"pdf" | "video" | "studio" | "cad" | "game" | "photo" | "pages" | "sheets" | "slides">;
  /** How the manual's header names the work mode. */
  workMode: string;
  /** File extensions it can open and save (the window's Load and Save); `tests/capabilities.test.ts` holds them to `loadable()` and the manual. */
  opens: string[];
  saves: string[];
  /**
   * Whether the agent's changes are done by hand in the window with Visible work on: `live`, or `gap` (the change is made
   * and the window shows it). docs/VISIBLE-WORK.md is the account and the test holds this to it.
   */
  hand: "live" | "gap";
}

export const CAPABILITIES: Capability[] = [
  { id: "pdf", name: "Autora PDF", engine: "Spectra", modes: ["pdf"], windows: ["pdf"], workMode: "PDF", opens: ["pdf"], saves: ["pdf"], hand: "live" },
  { id: "video", name: "Autora Video", engine: "OpenCut", modes: ["video"], windows: ["video"], workMode: "Video", opens: ["mp4", "mov", "webm", "mp3", "wav", "png", "jpg"], saves: ["mp4", "webm"], hand: "live" },
  { id: "studio", name: "Autora Music", engine: "Studio", modes: ["studio"], windows: ["studio"], workMode: "Music", opens: ["song.json"], saves: ["wav", "song.json"], hand: "live" },
  { id: "office", name: "Autora Pages, Sheets and Slides", engine: "GenOffice", modes: ["pages", "sheets", "slides"], windows: ["pages", "sheets", "slides"], workMode: "Documents, Spreadsheets or Presentations", opens: ["docx", "xlsx", "pptx"], saves: ["docx", "xlsx", "pptx"], hand: "live" },
  { id: "cad", name: "Autora 3D", engine: "Autora 3D", modes: ["cad"], windows: ["cad"], workMode: "3D", opens: ["json", "glb", "gltf", "obj", "stl"], saves: ["stl", "glb", "obj"], hand: "live" },
  { id: "game", name: "Autora Games", engine: "GDevelop", modes: ["game"], windows: ["game"], workMode: "Games", opens: ["json", "png", "mp3", "wav", "ttf"], saves: ["json"], hand: "gap" },
  { id: "photo", name: "Autora Photo", engine: "PhotoCraft", modes: ["photo"], windows: ["photo"], workMode: "Images", opens: ["png", "jpg", "webp", "psd"], saves: ["png", "psd"], hand: "live" },
];

/** The editor a tool belongs to, by its prefix (`pdf_read` -> pdf), or undefined. */
export function capabilityOf(tool: string): Capability | undefined {
  return CAPABILITIES.find((c) => tool.startsWith(`${c.id}_`));
}
