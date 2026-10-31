/** Panacea's modes share one workspace; engine names and routes stay internal. */
export type WorkspaceMode = "panacea" | "pages" | "sheets" | "slides" | "pdf" | "photo" | "video" | "studio" | "cad" | "game" | "app" | "browser" | "widget";
export type NativeWorkspaceActions = { createFlowchart: () => Promise<void> };

export const WORKSPACE_MODES: Record<WorkspaceMode, { name: string; context: string }> = {
  panacea: { name: "Canvas", context: "Drop an image or table, compose controls, or work on native documents and thinking boards. Panels adapt to the canvas selection." },
  pages: { name: "Documents", context: "Write and format a Word document. Document tools follow the text you select; Save keeps a copy in Artifacts." },
  sheets: { name: "Spreadsheets", context: "Work with cells, formulas and charts. Select a cell or range to use its spreadsheet controls." },
  slides: { name: "Presentations", context: "Design slides with text and objects. Select a slide or object to work with its presentation controls." },
  pdf: { name: "PDF", context: "Read, edit, fill, sign and organize pages. Use the floating bar or All tools for the selected page." },
  photo: { name: "Images", context: "Edit layers, masks, filters and brushes. Keep your look and mood; use the canvas for adaptive image controls." },
  video: { name: "Video", context: "Arrange footage, audio, titles and subtitles. Select a clip in the timeline to trim or adjust it." },
  studio: { name: "Music", context: "Compose with tracks, instruments, a piano roll and mixer. Your melody stays yours; the agent can handle timing and balance." },
  cad: { name: "3D", context: "Shape, group and inspect a model. Select a part, face or edge to work with its modelling controls." },
  game: { name: "Games", context: "Make scenes, objects and abilities, and play your game. The agent handles wiring; the world and story stay yours." },
  app: { name: "Apps & code", context: "Try the running app, select elements and leave review comments. The agent works on code and connections in the background." },
  browser: { name: "Web", context: "Use the live web page or let the agent drive. Take control for sign-ins and hand it back when you are done." },
  widget: { name: "Explainers", context: "Explore an interactive explanation. Its controls run inside a sandbox, separate from the app." },
};

/** Phone engine state uses file kinds; the workspace uses the work being done. */
export function workspaceMode(kind: string): WorkspaceMode | null {
  if (kind === "docx") return "pages";
  if (kind === "xlsx") return "sheets";
  if (kind === "pptx") return "slides";
  return Object.hasOwn(WORKSPACE_MODES, kind) ? kind as WorkspaceMode : null;
}

export function workspaceSurface(mode: WorkspaceMode): string {
  return mode === "pages" ? "docx" : mode === "sheets" ? "xlsx" : mode === "slides" ? "pptx" : mode;
}
