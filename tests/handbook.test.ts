/**
 * The tools handbook (server/handbook.ts): each window has a manual, tools map to the right one, the overview every turn
 * points at them, and `tool_manual` reads one.
 *
 *   npx tsx tests/handbook.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const stateDir = path.resolve(`.test-handbook-${process.pid}`);
fs.mkdirSync(stateDir, { recursive: true });
process.once("exit", () => fs.rmSync(stateDir, { recursive: true, force: true }));
process.env.AUTORA_STATE_DIR = stateDir;
const { MANUAL_IDS, manualId, manualText, windowsOverview } = await import("../server/handbook");
const { capabilityBriefing, runTool, findTool } = await import("../server/tools");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("every window has a manual that names its tools", () => {
  const expect: Record<string, string[]> = {
    browser: ["Autora Browser", "browser_handoff"], creator: ["Autora Creator", "app_preview"], terminal: ["Shell commands", "run_background"],
    pdf: ["Autora PDF", "pdf_compose"], video: ["Autora Video", "video_ui"], studio: ["Autora Music", "studio_make"],
    panacea: ["Panacea", "panacea_bespoke"],
    office: ["Pages, Sheets and Slides", "office_create"], cad: ["Autora 3D", "cad_shape_measure"], game: ["Autora Games", "game_catalog"], photo: ["Autora Photo", "photo_edit"],
    widgets: ["Widgets", "widget_show"],
  };
  assert.deepEqual([...MANUAL_IDS].sort(), Object.keys(expect).sort());
  for (const id of MANUAL_IDS) for (const needle of expect[id]) assert.ok(manualText(id).includes(needle), `${id} lacks ${needle}`);
});

await test("the overview puts the conversation where it is: on the left of the canvas on a desktop", () => {
  const text = windowsOverview();
  assert.match(text, /on desktop a panel on the left, beside the app rail \(its right edge resizes it\)/);
  assert.doesNotMatch(text, /panel on the right/);
  // Full screen is the board's Maximise, and what it does on a phone.
  assert.match(text, /Full screen button is its Maximise/);
  assert.match(text, /on a phone it also drops the conversation to its strip and the jump dock steps aside/);
});

await test("the browser manual says who has the browser and how it comes back", () => {
  const browser = manualText("browser");
  for (const needle of ["Take control", "Hand back to agent", "strip", "above the message box", "I'm done", "by itself", "never ask"]) {
    assert.ok(browser.includes(needle), `the browser manual lacks "${needle}"`);
  }
});

await test("every retained engine's manual identifies its integrated Panacea work mode", () => {
  for (const id of MANUAL_IDS.filter((id) => id !== "terminal" && id !== "panacea")) {
    const text = manualText(id);
    assert.ok(text.startsWith("Panacea ·"), `the ${id} manual must describe its workspace mode`);
    assert.ok(text.includes("not separate applications"), `the ${id} manual must not claim a standalone app`);
  }
});

await test("the PDF manual teaches the window as it is now: the bar, the grid, the trays, tap to redact, sign", () => {
  const pdf = manualText("pdf");
  for (const needle of ["All tools", "colour wheel", "Redact N regions", "pending", "never an image", "replaces the old toolbar", "Shapes has a round button", "pin any tool", "Reset bar", "down the right side on a desktop", "page thumbnails", "Merge, Add pages, Split"]) {
    assert.ok(pdf.includes(needle), `the PDF manual lacks "${needle}"`);
  }
  assert.ok(!/menu bar of|Mark up, Fill & sign/.test(pdf), "and says nothing of the bar it replaced, except that it is replaced");
});

await test("the Music manual teaches the tool bar and not the toolbar it replaced", () => {
  const music = manualText("studio");
  for (const needle of ["All tools", "Add track", "Split, Duplicate and Delete", "pin any tool", "no old toolbar", "whatever is shown"]) {
    assert.ok(music.includes(needle), `the Music manual lacks "${needle}"`);
  }
});

await test("the Games manual teaches the tool bar, Play in the window and the Advanced rules", () => {
  const game = manualText("game");
  for (const needle of ["All tools", "Add object", "Abilities", "pin any tool", "inside the window", "Advanced", "Back to the scene", "whatever is shown"]) {
    assert.ok(game.includes(needle), `the Games manual lacks "${needle}"`);
  }
});

await test("the 3D manual teaches the tool bar and not the bottom bar it replaced", () => {
  const cad = manualText("cad");
  for (const needle of ["All tools", "Size & position", "Pick edges", "Push & pull", "pin any tool", "no bottom bar", "whatever is shown", "parts pane", "Edit inside", "independent copy", "cad_group_enter", "Search by name"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the Office manual teaches the tool bar and not the ribbon it replaced", () => {
  const office = manualText("office");
  for (const needle of ["All tools", "no ribbon", "one group per old ribbon tab", "pin any of them", "keyboard shortcuts work", "whatever is shown"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("the Video manual teaches the tool bar and not the tab strip and toolbar it replaced", () => {
  const video = manualText("video");
  for (const needle of ["All tools", "no strip of tabs", "pin any of them", "keyboard shortcuts work", "video_ui by its name"]) {
    assert.ok(video.includes(needle), `the Video manual lacks "${needle}"`);
  }
});

await test("the Photo manual teaches the tool bar and not the menu bar and toolbox it replaced", () => {
  const photo = manualText("photo");
  for (const needle of ["All tools", "no menu bar, no toolbox", "pin any tool or command", "keyboard shortcuts work", "whatever is shown"]) {
    assert.ok(photo.includes(needle), `the Photo manual lacks "${needle}"`);
  }
});

await test("the Office manual says that with Visible work on office_edit's words are typed in the window by hand", () => {
  const office = manualText("office");
  for (const needle of ["With Visible work on", "typed there by your hand, live", "name box", "formula bar's tick", "box is opened on its slide", "With Visible work off"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("every window's manual says where its Save is and what it keeps; the overview says how folders work", () => {
  const kept: Record<string, string> = {
    pdf: "kept in Artifacts", office: "Saved by you", studio: ".song.json", panacea: ".panacea.json", cad: "GLB", game: "GDevelop project", photo: "PNG", video: "writes the project now",
  };
  for (const [id, needle] of Object.entries(kept)) {
    const text = manualText(id as Parameters<typeof manualText>[0]);
    assert.ok(text.includes("has Save") || text.includes("also has Save"), `the ${id} manual does not say it has Save`);
    assert.ok(text.includes(needle), `the ${id} manual lacks "${needle}"`);
  }
  const overview = windowsOverview();
  for (const needle of ["its top bar has Save", "without waking you", "folders, one per project", "share one folder"]) {
    assert.ok(overview.includes(needle), `the overview lacks "${needle}"`);
  }
});

await test("the shell manual teaches collapsible conversation runs, not an interactive terminal window", () => {
  const t = manualText("terminal");
  for (const needle of ["collapsible card in the conversation", "Show output", "Hide output", "Copy output", "no standalone terminal", "does not persist", "no TTY", "timeout", "run_background"]) {
    assert.ok(t.includes(needle), `the Terminal manual lacks "${needle}"`);
  }
  assert.doesNotMatch(t, /Typed into the shell|their Terminal tab|live pseudo-terminal/);
});

await test("the Video manual says Panacea's Video panels drive the project, with a Clip list", () => {
  const video = manualText("video");
  for (const needle of ["Panacea's Video panels drive this same project", "Clip list", "panacea_set", "no panels for colour grade"]) {
    assert.ok(video.includes(needle), `the Video manual lacks "${needle}"`);
  }
});

await test("the Video manual says which edits are done in the window by hand with Visible work on", () => {
  const v = manualText("video");
  for (const needle of ["With Visible work on", "by your hand, live", "the ruler clicked at the cut", "Delete pressed", "dragged along the timeline", "Default text", "With Visible work off"]) {
    assert.ok(v.includes(needle), `the Video manual lacks "${needle}"`);
  }
});

await test("the 3D manual teaches organic forms: blend, loft, smooth, and that the person decides the form", () => {
  const cad = manualText("cad");
  for (const needle of ["cad_sculpt_blend", "cad_sculpt_loft", "cad_sculpt_smooth", "tapered capsules", "mirror", "Work big to small", "they decide the character of the form"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the 3D manual teaches the command log: who did what, history_log since a revision, and the person's own commands", () => {
  const cad = manualText("cad");
  for (const needle of ["Who did what", "cad_history_log", "since_revision", "the person's own hand and are not given to you", "history_revert"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the Office manual teaches the workbook's and deck's command log: who did what, office_history, revert, no person-only commands", () => {
  const text = manualText("office");
  for (const needle of ["Who did what in a workbook, a deck or a document", "office_history", "since_revision", "app says sheets, slides or pages", "just before command n", "shows in the log as a revert", "no commands that are the person's alone", "words in paragraphs in Pages"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the Office manual says what the person has picked reaches the briefing, so \"this\" means it", () => {
  const text = manualText("office");
  for (const needle of ["is in your briefing for about two minutes", "they mean that, so act on it without asking which"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the windows overview says the navigation dock and Tidy appear only when the work needs them, and a blank canvas shows nothing", () => {
  const text = windowsOverview();
  for (const needle of ["The dock is not there on a blank canvas", "Tidy joins it only once there is more than one piece of work", "A blank canvas shows nothing at all, no instructions", "the canvas name and Save bar arrive with the first piece of work", "the undo and redo slider once there is something to take back"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the Games manual teaches game_play: it plays the game, brings back pictures and errors, and the agent still asks how it feels", () => {
  const text = manualText("game");
  for (const needle of ["Playing the game", "game_play", "(press, hold, wait, click, shot)", "the errors the game threw", "with fresh false it plays the last preview", "ask the person how it plays"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the Photo manual teaches the command log and that the look is the person's: only your own changes can be taken back", () => {
  const text = manualText("photo");
  for (const needle of ["Who did what in the picture", "photo_history", "since_revision", "just before command n", "shows in the log as a revert", "you may take back only your own changes", "the last 10 commands"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the Video manual teaches the command log and that the cut is the person's: only your own changes can be taken back", () => {
  const text = manualText("video");
  for (const needle of ["Who did what in the video", "video_history", "since_revision", "just before command n", "the editor's own undo", "nothing changes and you are told", "you may take back only your own changes", "the last 30 commands"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the Music manual teaches the command log and that music is the person's: only your own changes can be taken back", () => {
  const text = manualText("studio");
  for (const needle of ["Who did what in the song", "studio_history", "since_revision", "just before command n", "shows in the log as a revert", "you may take back only your own changes", "the last 30 commands"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the PDF manual teaches the command log: who did what, pdf_history, revert", () => {
  const text = manualText("pdf");
  for (const needle of ["Who did what in the PDF", "pdf_history", "since_revision", "just before command n", "shows in the log as a revert", "declining one of your changes"]) {
    assert.ok(text.includes(needle), needle);
  }
});

await test("the PDF, Video and Photo manuals say what the person has picked reaches the briefing, so \"this\" means it", () => {
  for (const [id, needle] of [["pdf", "selected in a page"], ["video", "picked on the timeline"], ["photo", "layer the person is on"]] as const) {
    const text = manualText(id);
    assert.ok(text.includes(needle), `${id}: ${needle}`);
    assert.ok(text.includes("act on") && text.includes("without asking which"), `${id}: acts without asking`);
  }
});

await test("the Office manual says the Slides bar follows what is picked: slide tools always, text tools only with a box picked", () => {
  const office = manualText("office");
  for (const needle of ["Slides does the same", "New slide, Layout and Present are always there", "only while a box or shape on the slide is picked (click it first)"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("the Office manual says the Sheets bar follows what is picked: block tools only with a range, the essentials with a cell", () => {
  const office = manualText("office");
  for (const needle of ["Sheets follows what is picked the same way", "Insert row, Insert column and AutoSum are always there", "only while a block of cells is picked (a range, a column or a row, not a single cell)", "type its address in the name box"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("the Office manual says the Pages bar follows the document: text tools only while words are picked, Undo only with something to take back", () => {
  const office = manualText("office");
  for (const needle of ["In Pages the bar follows the document", "Highlight, Text colour, Bigger text, Clear formatting and Cut or Copy only while words are picked", "Undo only once there is something to take back", "pick the words first, or say"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("the Video manual says the bar follows the work: clip tools only with clips picked, Undo only with something to take back", () => {
  const video = manualText("video");
  for (const needle of ["follows the work and shows only as many tools as fit", "Media and Text are always there", "Duplicate, Delete and (on a phone) Edit only while clips are picked", "Undo only once there is something to take back", "pick the clip first, or say"]) {
    assert.ok(video.includes(needle), `the Video manual lacks "${needle}"`);
  }
});

await test("the Photo manual says the bar follows the picture: Undo only with something to take back, specialist tools wait in All tools", () => {
  const photo = manualText("photo");
  for (const needle of ["that follows the picture", "with no picture open it has no tools", "Undo only once there is something to take back", "wait in All tools until the person reaches for one", "say \"open All tools\" and name it"]) {
    assert.ok(photo.includes(needle), `the Photo manual lacks "${needle}"`);
  }
});

await test("the PDF manual says the bar follows the work: no tools without a document, specialist tools wait in All tools until reached for", () => {
  const pdf = manualText("pdf");
  for (const needle of ["The bar follows the work", "with no document open it has no tools, only All tools", "Erase comes only when there are unsaved marks", "wait in All tools until the person reaches for one", "say \"open All tools\" and name it"]) {
    assert.ok(pdf.includes(needle), `the PDF manual lacks "${needle}"`);
  }
});

await test("the Music and Games manuals say the tool bar shows only what the work needs, and that tools fade in and out", () => {
  const music = manualText("studio");
  for (const needle of ["shows only what the song needs", "an empty song has Add track and Song", "fade in while a clip is picked and fade out when nothing is"]) assert.ok(music.includes(needle), `the Music manual lacks "${needle}"`);
  const game = manualText("game");
  for (const needle of ["only what the moment needs", "Abilities and Delete only once an object is picked", "fades out and fades back in when it has"]) assert.ok(game.includes(needle), `the Games manual lacks "${needle}"`);
});

await test("the 3D manual says the tool bar is contextual and where to find every tool", () => {
  const cad = manualText("cad");
  for (const needle of ["The tool bar is contextual", "with nothing made it is Shape and Draw", "Sculpt only for a mesh shape", "All tools (the grid icon"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the 3D manual teaches the sculpt tool as the person's hand, and not to rebuild what they sculpted", () => {
  const cad = manualText("cad");
  for (const needle of ["Sculpting by hand", "Grab", "Carve or Shift", "Finer surface", "one undo step", "you have no brush tool, on purpose", "Do not rebuild a shape they have sculpted"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the 3D manual teaches mesh import: the tool, the formats, what a mesh cannot do, and Load adding one", () => {
  const cad = manualText("cad");
  for (const needle of ["cad_mesh_import", "GLB (or glTF), OBJ or STL", "bytes never go through the conversation", "size sets its longest side", "no outline, faces, bevels or holes", "Load in the window's top bar takes a .glb", "without replacing it"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the 3D manual says Panacea's 3D panels drive the model, with a Part list", () => {
  const cad = manualText("cad");
  for (const needle of ["Panacea's 3D panels drive this same model", "Part list", "panacea_set", "no panels for rotation"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the 3D manual says every changing call is done in the window by hand with Visible work on, and what has no control", () => {
  const cad = manualText("cad");
  for (const needle of ["With Visible work on", "every call that changes the model is done there", "by your hand, live", "Shape tray", "with Draw", "Size & position", "Shift for each after the first", "dragging the ring", "Curved edge", "Undo and Redo in the top bar", "one command at a time", "Done by hand in the 3D window", "Not by hand", "cad_doc_set", "With Visible work off"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the Music manual says Panacea's Music panels drive the song, with a Track list for a track's controls", () => {
  const music = manualText("studio");
  for (const needle of ["Panacea's Music panels drive this same song", "Track list", "panacea_set", "Drum pattern", "no panels for envelope"]) {
    assert.ok(music.includes(needle), `the Music manual lacks "${needle}"`);
  }
});

await test("the Music manual says that with Visible work on the studio tools are done in the window by hand", () => {
  const music = manualText("studio");
  for (const needle of ["With Visible work on", "by your hand, live", "Song tray", "Add track", "piano roll", "drum grid", "finished song goes in", "With Visible work off"]) {
    assert.ok(music.includes(needle), `the Music manual lacks "${needle}"`);
  }
});

await test("the Panacea manual teaches a document's history and suggestions: proposed, never applied, the person accepts", () => {
  const p = manualText("panacea");
  for (const needle of ["keeps a history", "take any one step back on its own", "{op:\"suggest\"", "A suggestion changes nothing", "their own edit", "never new writing"]) {
    assert.ok(p.includes(needle), `the Panacea manual lacks "${needle}"`);
  }
});

await test("the Panacea manual teaches laying out the windows: the person's gestures and the agent's, kept with the canvas", () => {
  const p = manualText("panacea");
  for (const needle of ["Layout. The apps' windows", "Tidy in the board's", "panacea_arrange: `windows`", "`tidy`", "front first", "same gesture"]) {
    assert.ok(p.includes(needle), `the Panacea manual lacks "${needle}"`);
  }
});

await test("the Panacea manual teaches the canvas as it is: no toolbar, the library and atoms, ghosts, fading, the history", () => {
  const p = manualText("panacea");
  for (const needle of ["single workspace", "Capabilities", "share one camera", "no nested canvas", "right-side icons", "same dotted grid", "about twenty ready-made panels", "at most 8 controls in view", "Keep in library", "ghost", "Not now",
    "Not this", "put away", "double-click the grid or press /", "Ask Autora", "Undo, Redo", "behind More", "denser panels", "Whose choices", "Open on canvas"]) {
    assert.ok(p.includes(needle), `the Panacea manual lacks "${needle}"`);
  }
});

await test("the Panacea manual teaches documents: the selection, the ids, and whose words they are", () => {
  const p = manualText("panacea");
  for (const needle of ["panacea_doc", "panacea_look doc", "You write", "Autora writes", "may not write", "creative", "mode", "Ctrl+B"]) {
    assert.ok(p.toLowerCase().includes(needle.toLowerCase()), `the Panacea manual lacks "${needle}"`);
  }
});

await test("the Panacea manual teaches nested native composition and stable context-aware adaptation", () => {
  const text = manualText("panacea");
  for (const needle of ["panacea_place parts", "one root", "recipe, tree or parts", "focused surface kind", "Typing and dragging", "pinned panels", "person's caret"]) {
    assert.ok(text.includes(needle), `the Panacea manual lacks ${needle}`);
  }
});

await test("the Panacea manual says whose words a panel's fields are, how to switch it, and that unplanned work comes here", () => {
  const p = manualText("panacea");
  for (const needle of ["text or list fields", "\"You write\"", "\"Autora writes\"", "presses it to switch", "values refuse those fields", "panacea_arrange writes", "say you did", "no other window was made for"]) {
    assert.ok(p.includes(needle), `the Panacea manual lacks "${needle}"`);
  }
});

await test("the Panacea manual teaches boards: cards, links, questions, the panel, and whose words they are", () => {
  const p = manualText("panacea");
  for (const needle of ["Boards.", "panacea_surface board:", "panacea_look board:", "panacea_board", "Autora asks", "drag from the dot", "Answer", "Tidy",
    "Ask me questions", "(op ask: a question, ending with ?", "may not add, rewrite or remove their cards", "Markdown outline"]) {
    assert.ok(p.includes(needle), `the Panacea manual lacks "${needle}"`);
  }
});
await test("the Panacea manual distinguishes real flowcharts from idea boards", () => {
  for (const text of ["Flowcharts are explicit", "not renamed mind maps", "Shape", "connector", "SVG by default", "guide/agent"]) {
    assert.ok(manualText("panacea").includes(text), `flowchart manual lacks ${text}`);
  }
});

await test("the Panacea manual says that with Visible work on its changes are done in the window by hand, and what has no control", () => {
  const p = manualText("panacea");
  for (const needle of ["With Visible work on", "every Panacea call that changes the canvas is done there by your hand", "name typed in the picker",
    "listed there as yours", "dragging a slider", "More opened", "dragged by its title bar", "a table pasted, a file dropped",
    "a document's words typed in", "linked by dragging a dot", "finished canvas goes in", "With Visible work off", "a Board, Flowchart or Document",
    "panacea_project", "project strip", "only then can you move past the first phase", "picker (Project)",
    "moves by its title bar", "Maximise", "arrow halfway"]) {
    assert.ok(p.includes(needle), `the Panacea manual lacks "${needle}"`);
  }
  assert.ok(!p.includes("not done by hand yet"), "the Panacea manual still says writing is not done by hand");
});

await test("the PDF manual says that with Visible work on pdf_edit is done in the window by hand, and what is not", () => {
  const pdf = manualText("pdf");
  for (const needle of ["With Visible work on", "by your hand, live", "Fill N fields", "Ctrl+S", "done on the file afterwards", "With Visible work off"]) {
    assert.ok(pdf.includes(needle), `the PDF manual lacks "${needle}"`);
  }
});

await test("the Office manual says Pages' bold, italic and underline are pressed by hand", () => {
  assert.ok(manualText("office").includes("bold, italic or underline put on or taken off words"));
});

await test("the PDF manual says an item over several pages is done a page at a time", () => {
  assert.ok(manualText("pdf").includes("a page at a time"));
});

await test("the Video manual says which edits are done by hand, the fields a title is typed into, and what is not", () => {
  const video = manualText("video");
  for (const needle of ["Properties panel's own", "Extract audio", "dragged out to its time", "seek (the ruler clicked)", "Every other action", "With Visible work off"]) {
    assert.ok(video.includes(needle), `the Video manual lacks "${needle}"`);
  }
});

await test("the Music manual says an instrument is chosen in the track's menu and a velocity set with the Force slider", () => {
  const music = manualText("studio");
  for (const needle of ["Instrument", "Force slider", "a quantize at less than full strength"]) {
    assert.ok(music.includes(needle), `the Music manual lacks "${needle}"`);
  }
});

await test("the Games manual says Panacea's Game panels drive the game, with an Object list", () => {
  const game = manualText("game");
  for (const needle of ["Panacea's Game panels drive this same game", "Object list", "panacea_set", "no panels for camera"]) {
    assert.ok(game.includes(needle), `the Games manual lacks "${needle}"`);
  }
});

await test("the Games manual says Visible work is not here yet, and that no cursor is played over the game", () => {
  const game = manualText("game");
  assert.ok(game.includes("coming soon") && game.includes("no cursor is played"));
});

await test("the Photo manual says that with Visible work on the edit is done in the window by hand", () => {
  const photo = manualText("photo");
  for (const needle of ["Visible work on", "by your hand", "clicks its tile", "command's own dialog", "Visible work off"]) {
    assert.ok(photo.includes(needle), `the Photo manual lacks "${needle}"`);
  }
});

await test("a tool finds its window's manual, and a tool with no window finds none", () => {
  assert.equal(manualId("browser_click"), "browser");
  assert.equal(manualId("web_search"), "browser");
  assert.equal(manualId("app_preview"), "creator");
  assert.equal(manualId("terminal"), "terminal");
  assert.equal(manualId("pdf_edit"), "pdf");
  assert.equal(manualId("studio_clip"), "studio");
  assert.equal(manualId("panacea_place"), "panacea");
  assert.equal(manualId("office_edit"), "office");
  assert.equal(manualId("cad_batch"), "cad");
  assert.equal(manualId("photo_edit"), "photo");
  assert.equal(manualId("game_edit"), "game");
  assert.equal(manualId("widget_show"), "widgets");
  assert.equal(manualId("todo"), null);
  assert.equal(manualId("memory_search"), null);
});

await test("the overview every turn explains the layout and points at the manuals", async () => {
  const overview = windowsOverview();
  for (const needle of ["Panacea is the main area", "slim strip along the foot of the workspace", "Open Panacea", "without a message", "Capabilities", "icon dock at the canvas's bottom-left", "stay mounted", "manual jump", "Follow", "tool_manual", "Shell commands", "Show all work", "Ask Autora bar", "docked beside it", "edge tab", "bottom sheet", "left half", "Canvas only", "TODO", "Retract conversation", "contracted by default"]) {
    assert.ok(overview.includes(needle), `the overview lacks ${needle}`);
  }
  assert.doesNotMatch(overview, /x on its tab|Autora Terminal|Working on/);
  // The switch beside Follow, and what turning it off changes for the agent.
  assert.ok(overview.includes("Visible work on") && overview.includes("Visible work off you work at speed"));
  // Video: the name is in the window's bar, the editor's own row is the projects menu and Export.
  assert.match(manualText("video"), /only the projects menu \(New project, Rename/);
  const briefing = await capabilityBriefing();
  assert.ok(briefing.includes("How Autora's windows work"));
  assert.ok(!briefing.includes("a real Chromium running on this machine"), "the manuals are not in the briefing");
});

await test("the organization is briefed once, and the lead is told it routes the work", async () => {
  const briefing = await capabilityBriefing();
  const said = briefing.split("You run this organization, so you may shape it with the agents tool").length - 1;
  assert.equal(said, 1, "the hiring text is emitted once, not twice");
  assert.match(briefing, /Autora leads, plans and routes the work/);
});

await test("tool_manual returns a manual, and refuses a window that does not exist", async () => {
  const spec = findTool("tool_manual")!;
  assert.ok(spec);
  const ctx = { session: "s", onOutput: () => undefined } as never;
  const ok = await runTool(spec, { window: "Studio" }, ctx);
  assert.equal(ok.ok, true);
  assert.ok(ok.summary.includes("Autora Music"));
  const bad = await runTool(spec, { window: "nope" }, ctx);
  assert.equal(bad.ok, false);
  assert.ok(bad.summary.includes("browser, creator"));
});

await test("the general manual says every window has Load, and what the composer's Artifacts button attaches", () => {
  const text = windowsOverview();
  for (const needle of ["has Load", "opens in that window", "you did not open", "the Artifacts button beside the notebook", "project folder", "up to 20", "project notes", "comes with the folder"]) {
    assert.ok(text.includes(needle), `the windows overview lacks "${needle}"`);
  }
});

console.log(`\n${passed} passed`);
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(0);
