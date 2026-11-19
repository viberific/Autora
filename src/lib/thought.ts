/**
 * The few words a tool card shows for a call: what it is doing.
 *
 * Never a guess and never invented. Every phrase here is made from the tool call itself (`thoughtForTool`), so the card can
 * only say what the call really does. Short enough to read at a glance: a gerund and the name of the thing, under `MAX`
 * characters. Pure, so it can be tested.
 */
export const MAX = 34;

const clip = (t: string, n = MAX): string => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const quote = (t: string, room: number): string => `“${clip(t, room)}”`;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const host = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return clip(url, 24); } };

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const noun = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an in-flight tool call is, as a thought; null for the ones that move nothing the person could point at. */
export function thoughtForTool(name: string, args: Record<string, any> = {}): string | null {
  switch (name) {
    case "browser_open": return str(args.url) ? `Opening ${clip(host(str(args.url)), 24)}` : "Opening a page";
    case "browser_click": return "Clicking";
    case "browser_fill": return count(args.values) > 1 ? `Filling in ${noun(count(args.values), "field")}` : "Filling in a field";
    case "browser_scroll": return "Scrolling";
    case "browser_press": return "Pressing a key";
    case "browser_back": return "Going back";
    case "browser_read": case "browser_screenshot": return "Looking at the page";
    case "web_search": return str(args.query) ? `Searching ${quote(args.query, 22)}` : "Searching";
    case "computer_click": return "Clicking on the desktop";
    case "computer_type": return "Typing on the desktop";
    case "computer_move": return "Moving over";
    case "terminal": case "run_background": return str(args.command) ? `Running ${quote(str(args.command).split("\n")[0], 22)}` : "Running a command";
    case "pdf_read": return "Reading the PDF";
    case "pdf_look": return Number.isInteger(args.pages) ? `Looking at page ${args.pages}` : "Looking at the page";
    case "pdf_edit": case "pdf_replace_text": return "Editing the PDF";
    case "pdf_redact": return "Redacting";
    case "pdf_pages": return "Rearranging pages";
    case "pdf_compose": return "Building the PDF";
    case "pdf_compress": return "Shrinking the PDF";
    case "office_read": return "Reading the document";
    case "office_look": return "Looking it over";
    case "office_edit": return count(args.ops) > 1 ? `Making ${noun(count(args.ops), "change")}` : "Making a change";
    case "office_check": return "Checking it";
    case "office_create": return args.type === "xlsx" ? "Starting a spreadsheet" : args.type === "pptx" ? "Starting a presentation" : "Starting a document";
    case "video_edit": return "Editing the video";
    case "video_ui": return str(args.label) ? `Using ${quote(args.label, 22)}` : "Using the editor";
    case "video_look": case "video_frame": return "Looking at the frame";
    case "video_import": return "Bringing in a clip";
    case "video_export": return "Exporting the video";
    case "studio_notes": return "Writing notes";
    case "studio_clip": return "Shaping a clip";
    case "studio_track": return "Setting up a track";
    case "studio_song": case "studio_make": return "Working on the song";
    case "studio_play": return "Playing it back";
    case "panacea_open": return "Opening the canvas";
    case "panacea_look": return "Looking at the canvas";
    case "panacea_surface":
      return str(args.remove) ? "Taking work off the canvas" : typeof args.csv === "string" ? "Putting a table on the canvas"
        : typeof args.document === "string" ? "Starting a page" : str(args.board) || str(args.flowchart) ? "Starting a board"
        : "Putting work on the canvas";
    case "panacea_board": return "Working on the board";
    case "panacea_project": return "Updating the project";
    case "panacea_export": return "Saving a file from the canvas";
    case "studio_open": return "Opening the song";
    case "video_open": return "Opening the video";
    case "game_open": return "Opening the game";
    case "photo_open": return "Opening the picture";
    case "office_open": return "Opening the file";
    case "panacea_place": return "Bringing a panel";
    case "panacea_set": return "Setting it";
    case "panacea_arrange": return "Arranging the canvas";
    case "panacea_bespoke": return "Making a piece";
    case "panacea_doc": return "Working on the document";
    case "game_edit": return count(args.ops) > 1 ? `Making ${noun(count(args.ops), "change")}` : "Changing the game";
    case "game_look": return "Looking at the scene";
    case "photo_edit": return "Editing the picture";
    case "office_history": case "pdf_history": case "studio_history": case "video_history": case "photo_history":
      return args.action === "revert" ? "Taking a change back" : "Checking what changed";
    case "game_play": return "Playing the game";
    case "photo_look": return "Looking at the picture";
    case "app_preview": return str(args.text) ? "Typing in the app" : str(args.target) ? "Pointing at the app" : "Working in the app";
    case "edit_file": return "Editing a file";
    default:
      if (name.startsWith("cad_")) return "Shaping the model";
      return null;
  }
}
