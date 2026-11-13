/*
 * The one tool bar, in Pages, Sheets and Slides (docs/TOOL-RAIL.md): round coloured tools down the right side of a desktop
 * and along the bottom of a phone, as many as fit and never scrolling, and a grid button last that opens every tool in a
 * modal. It replaces the ribbon on both, and nothing is shown of the ribbon at all: it is closed to nothing (its place in the
 * layout kept, because Sheets lays out in rows and a row that goes missing moves every other row up).
 *
 * Every command of the ribbon is a tool. The common ones are listed here (TOOLS) with a colour per verb and a place on the
 * bar; the rest are read from the ribbon itself once the editor is up (it opens each tab once, unseen, and notes its
 * controls), and appear in All tools under the name of their tab, each one pinnable like the others. A tool presses the
 * editor's own button, found by the start of the name each carries (`data-tip`, `aria-label`, `title`), so there is nothing
 * to keep in step with the editor but the names, and no second implementation of bold. A command that opens a drop-down (a
 * colour, borders, a table size) has its drop-down open beside the bar, because while it runs the ribbon is laid out, unseen,
 * at a fixed place there. The agent has every tool whatever is shown. Pins live in the page's storage, which a frame with no
 * origin only has for the session (common.js). Runs only in the framed editor; the server's headless render never gets it.
 */
(() => {
  "use strict";
  if (window.parent === window || typeof window.__autoraHeadless !== "undefined" || typeof window.__autoraHost === "function") return;
  let phone = false;
  try { phone = new URLSearchParams(location.search).get("phone") === "1"; } catch { /* no address: the desktop editor */ }
  const root = document.documentElement;
  const app = /\/(docs|sheets|slides)\//.exec(location.pathname)?.[1] ?? "docs";
  /* Pages and Sheets on a desktop have no bar at all: their tools are a card that comes to what the person picks, beside it and
     never over it, and goes when the pick does (docs/TOOL-RAIL.md, "Pages and Sheets: the card"). Sheets' formula bar rides in
     that card. Slides, and every phone, keep the bar. */
  const card = !phone && (app === "docs" || app === "sheets");
  root.classList.add("autora-rail-ui", phone ? "autora-phone" : card ? "autora-card" : "autora-desktop", `autora-${app}`);
  /* Last pointer-up position over the editor canvas: the card opens here (sheets = last click on grid; docs = end of selection). */
  let lastPointer = null;

  const css = `
    html.autora-rail-ui .ribbon, html.autora-rail-ui header.excel-header { max-height: 0 !important; min-height: 0 !important; overflow: hidden !important; visibility: hidden; border: 0 !important; padding: 0 !important; }
    /* The ribbon is never seen. While a tool needs it, it is laid out at a fixed place (so a drop-down opens beside the bar, not at the
       top-left corner) and stays invisible; the tools of a tab are shown as tiles in our own panel, and pressing one presses the real button. */
    html.autora-rail-ui.rail-ribbon .ribbon, html.autora-rail-ui.rail-ribbon header.excel-header {
      position: fixed !important; z-index: 85; box-sizing: border-box; overflow: visible !important; visibility: hidden; pointer-events: none; max-height: min(70vh, 520px) !important; }
    /* What a command opens inside the ribbon (a table size, a list of styles) is seen, though the ribbon is not. */
    html.autora-rail-ui.rail-ribbon .ribbon :is([class*="picker"], [class*="popover"], [class*="popup"], [class*="menu"], [class*="dropdown"], [class*="gallery"], [role="menu"], [role="listbox"], [role="dialog"]),
    html.autora-rail-ui.rail-ribbon header.excel-header :is([class*="picker"], [class*="popover"], [class*="popup"], [class*="menu"], [class*="dropdown"], [class*="gallery"], [role="menu"], [role="listbox"], [role="dialog"]) { visibility: visible; pointer-events: auto; box-shadow: 0 16px 48px -10px #000; outline: 1px solid rgba(255,255,255,.16); border-radius: 10px; }
    html.autora-desktop.rail-ribbon .ribbon, html.autora-desktop.rail-ribbon header.excel-header { right: 66px; top: 12px; width: min(680px, calc(100vw - 100px)); }
    html.autora-phone.rail-ribbon .ribbon, html.autora-phone.rail-ribbon header.excel-header { left: 8px; right: 8px; bottom: 64px; max-height: 46vh !important; }
    /* A side pane (Styles, Comments, the format pane) floats over the work area, beside the bar (above the dock on a phone): it never
       pushes the page or the slide sideways, so what is being worked on stays where it is. */
    html.autora-rail-ui aside.styles-pane, html.autora-rail-ui aside.comments-pane, html.autora-rail-ui aside.format-pane, html.autora-rail-ui aside.nav-pane {
      position: fixed !important; z-index: 60; box-sizing: border-box; border: 1px solid rgba(255,255,255,.14) !important; border-radius: 16px; box-shadow: 0 24px 60px -16px #000; overflow: hidden; }
    html.autora-desktop aside.styles-pane, html.autora-desktop aside.comments-pane, html.autora-desktop aside.format-pane { right: 66px; top: 12px; bottom: 12px; width: 300px !important; }
    html.autora-desktop aside.nav-pane { left: 12px; top: 12px; bottom: 12px; }
    html.autora-phone aside.styles-pane, html.autora-phone aside.comments-pane, html.autora-phone aside.format-pane, html.autora-phone aside.nav-pane { left: 8px; right: 8px; bottom: 64px; top: auto; width: auto !important; max-height: 55vh; }
    html.autora-rail-ui .qa-btn, html.autora-rail-ui .autosave-toggle, html.autora-rail-ui .ribbon-tab-file { display: none !important; }
    html.autora-rail-ui .ribbon-tabs { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
    html.autora-rail-ui .ribbon-tabs::-webkit-scrollbar { display: none; }
    html.autora-rail-ui .ribbon-tabs > * { flex: 0 0 auto; }
    html.autora-rail-ui .ribbon-body { overflow-x: auto; }
    html.autora-phone footer.status-bar, html.autora-phone .status-bar { display: none !important; }
    html.autora-phone #root { box-sizing: border-box; padding-bottom: 56px; }
    html.autora-desktop #root { box-sizing: border-box; padding-right: 60px; }
    html.autora-phone .ribbon-tab { min-height: 40px; padding: 0 12px; border-radius: 12px; }
    html.autora-phone .slide-list { width: 76px !important; min-width: 0 !important; }
    html.autora-phone .thumb-resizer, html.autora-phone .notes-pane { display: none !important; }
    /* The card (Pages and Sheets on a desktop): nothing on screen until something is picked; then one small card beside the pick. */
    html.autora-card aside.styles-pane, html.autora-card aside.comments-pane, html.autora-card aside.format-pane { right: 12px; top: 12px; bottom: 12px; width: 300px !important; }
    html.autora-card aside.nav-pane { left: 12px; top: 12px; bottom: 12px; }
    html.autora-card.rail-ribbon .ribbon, html.autora-card.rail-ribbon header.excel-header { left: var(--rb-x, 8px); top: var(--rb-y, 8px); width: min(680px, calc(100vw - 16px)); }
    html.autora-card #autora-rail { left: 0; top: 0; flex-direction: row; flex-wrap: wrap; justify-content: flex-start; max-width: min(436px, calc(100vw - 16px)); gap: 2px; padding: 4px; border-radius: 12px;
      opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .12s, visibility 0s .12s; }
    html.autora-card #autora-rail[data-open="1"] { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity .12s; }
    html.autora-card.autora-sheets #autora-rail { width: min(436px, calc(100vw - 16px)); }
    html.autora-card #autora-rail button.rb { width: 30px; height: 30px; }
    html.autora-card #autora-rail button.rb svg { width: 16px; height: 16px; }
    html.autora-card #autora-rail button.rb[data-need="0"] { display: none; }
    html.autora-card #autora-rail .div { width: 1px; height: 20px; margin: 0 2px; align-self: center; }
    html.autora-card #autora-rail .fx-slot { flex: 0 0 100%; height: var(--fx-h, 28px); }
    /* Sheets' formula bar (Univer's own, name box and all) leaves its strip at the top and sits in the card's first row; out of sight with the card. */
    html.autora-card [data-u-comp="formula-bar"] { position: fixed !important; z-index: 72; left: -10000px; top: 0; width: var(--fx-w, 428px) !important; box-sizing: border-box; border-radius: 8px; overflow: hidden; }
    html.autora-card.fx-on [data-u-comp="formula-bar"] { left: var(--fx-x); top: var(--fx-y); }
    @keyframes autora-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(110,91,255,0); } 30% { box-shadow: 0 0 0 4px rgba(110,91,255,.85); } }
    .autora-flash { animation: autora-flash 1.4s ease-in-out 2; border-radius: 6px; }

    #autora-rail { position: fixed; z-index: 70; box-sizing: border-box; display: flex; align-items: center; gap: 4px; padding: 8px; font-family: inherit;
      background: rgba(21,24,36,.92); border: 1px solid rgba(255,255,255,.13); box-shadow: 0 18px 48px -12px rgba(0,0,0,.7); backdrop-filter: blur(8px); }
    html.autora-desktop #autora-rail { right: 10px; top: 50%; transform: translateY(-50%); flex-direction: column; gap: 3px; padding: 5px; border-radius: 999px; max-height: calc(100% - 16px); overflow: hidden; }
    html.autora-phone #autora-rail { left: 0; right: 0; bottom: 0; height: 56px; justify-content: center; gap: 2px; padding: 8px 6px; border-width: 1px 0 0; border-radius: 0; background: #0e1016; box-shadow: none; }
    #autora-rail button.rb { --tc: #98a1b6; flex: none; display: grid; place-items: center; border: 0; border-radius: 50%; cursor: pointer; padding: 0; color: var(--tc);
      background: color-mix(in srgb, var(--tc) 16%, transparent); touch-action: manipulation; transition: background .15s, box-shadow .15s; }
    html.autora-desktop #autora-rail button.rb { width: 34px; height: 34px; }
    html.autora-desktop #autora-rail button.rb svg { width: 18px; height: 18px; }
    html.autora-phone #autora-rail button.rb { width: 40px; height: 40px; }
    #autora-rail button.rb:hover:not(:disabled) { background: color-mix(in srgb, var(--tc) 28%, transparent); }
    #autora-rail button.rb.on { color: #fff; background: var(--tc); box-shadow: 0 6px 18px color-mix(in srgb, var(--tc) 45%, transparent); }
    #autora-rail button.rb:disabled { opacity: .35; cursor: default; }
    #autora-rail button.rb svg, .ar-tile svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    /* The bar follows the work (RULES below): a tool the document has nothing for collapses out of its place and fades, and the others slide;
       it comes back the same way. Hidden, it is out of the tab order and cannot be pressed. */
    #autora-rail button.rb { transition: background .15s, box-shadow .15s, opacity .25s, transform .25s, height .25s, width .25s, margin .25s; }
    html.autora-desktop #autora-rail button.rb[data-need="0"] { height: 0; margin: -1.5px 0; opacity: 0; transform: scale(.6); pointer-events: none; visibility: hidden; transition: background .15s, opacity .25s, transform .25s, height .25s, margin .25s, visibility 0s .25s; }
    html.autora-phone #autora-rail button.rb[data-need="0"] { width: 0; margin: 0 -1px; opacity: 0; transform: scale(.6); pointer-events: none; visibility: hidden; transition: background .15s, opacity .25s, transform .25s, width .25s, margin .25s, visibility 0s .25s; }
    @media (prefers-reduced-motion: reduce) { #autora-rail button.rb { transition: none !important; } }
    #autora-rail .div { flex: none; background: rgba(255,255,255,.13); }
    html.autora-desktop #autora-rail .div { width: 20px; height: 1px; margin: 2px 0; }
    html.autora-phone #autora-rail .div { width: 1px; height: 24px; margin: 0 2px; }

    #autora-grid { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; background: var(--autora-scrim, rgba(8,9,13,.5)); backdrop-filter: var(--autora-scrim-blur, blur(10px) saturate(140%)); -webkit-backdrop-filter: var(--autora-scrim-blur, blur(10px) saturate(140%)); font-family: inherit; }
    #autora-grid .box { width: min(560px, 100%); max-height: min(88vh, 720px); overflow-y: auto; box-sizing: border-box; padding: 16px; border-radius: 20px; background: #0e1016; border: 1px solid rgba(255,255,255,.13); color: #edeff5; box-shadow: 0 30px 80px -20px #000; }
    html.autora-phone #autora-grid .box { width: min(340px, 100%); padding: 12px; }
    #autora-grid .head { display: flex; align-items: center; gap: 8px; }
    #autora-grid h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
    #autora-grid h4 { margin: 14px 4px 8px; font-size: 10.5px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: #7a8297; }
    #autora-grid .hint { margin: 4px 0 0; font-size: 12px; color: #7a8297; min-height: 1.4em; }
    #autora-grid .plain { border: 0; background: transparent; color: #98a1b6; font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 999px; cursor: pointer; }
    #autora-grid .plain:hover { background: #151824; color: #edeff5; }
    #autora-grid .x { width: 30px; height: 30px; padding: 0; border-radius: 50%; display: grid; place-items: center; }
    .ar-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
    html.autora-phone .ar-tiles { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 6px; }
    .ar-wrap { position: relative; --tc: #98a1b6; }
    .ar-tile { width: 100%; height: 76px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 0 4px; box-sizing: border-box; border: 0; border-radius: 16px; cursor: pointer; font: inherit; font-size: 11.5px; line-height: 1.15; text-align: center;
      color: var(--tc); background: color-mix(in srgb, var(--tc) 16%, transparent); }
    .ar-tile span { color: #edeff5; }
    .ar-tile:hover:not(:disabled) { background: color-mix(in srgb, var(--tc) 26%, transparent); }
    .ar-tile:disabled { opacity: .35; cursor: default; }
    .ar-tile.on { box-shadow: inset 0 0 0 1px rgba(110,91,255,.6); }
    html.autora-phone .ar-tile { height: 56px; border-radius: 14px; gap: 4px; font-size: 10px; }
    .ar-pin { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer; background: transparent; color: #7a8297; }
    .ar-pin svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .ar-pin.on { color: #fff; background: var(--tc); }

    /* Ask Autora button and popover (card mode: appears when there is a selection). */
    #autora-ask-btn { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 10px; height: 30px; border: 0; border-radius: 999px; background: linear-gradient(135deg,#6e5bff,#2563eb); color: #fff; font: 600 11.5px/1 inherit; cursor: pointer; white-space: nowrap; }
    html.autora-card #autora-ask-btn { height: 26px; font-size: 11px; }
    #autora-ask-btn svg { width: 14px; height: 14px; fill: none; stroke: none; }
    #autora-ask-btn:hover { opacity: .9; }
    /* The context menu (M1): a short vertical list of groups at the pointer, a group's entries beside it. */
    #autora-menu { position: fixed; z-index: 95; left: 0; top: 0; font-family: inherit; }
    #autora-menu .am-list { display: flex; flex-direction: column; min-width: 168px; padding: 4px; box-sizing: border-box; border-radius: 10px;
      background: rgba(21,24,36,.96); border: 1px solid rgba(255,255,255,.13); box-shadow: 0 18px 48px -12px rgba(0,0,0,.7); color: #edeff5; }
    #autora-menu .am-sub { position: absolute; min-width: 200px; }
    #autora-menu button { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    #autora-menu button span { flex: 1; white-space: nowrap; }
    #autora-menu button i { font-style: normal; opacity: .6; }
    #autora-menu button kbd { font: inherit; font-size: 11px; opacity: .55; }
    #autora-menu button svg { width: 16px; height: 16px; flex: 0 0 16px; color: var(--tc, currentColor); stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    #autora-menu button:is(:hover, :focus-visible, [aria-expanded="true"]):not(:disabled) { background: rgba(255,255,255,.08); outline: none; }
    #autora-menu button.on { box-shadow: inset 2px 0 0 var(--tc, #8b7bff); }
    #autora-menu button:disabled { opacity: .4; cursor: default; }
    #autora-ask-pop { position: fixed; z-index: 100; background: #0e1016; border: 1px solid rgba(255,255,255,.18); border-radius: 14px; padding: 10px 12px; box-shadow: 0 20px 50px -10px #000; width: min(300px,calc(100vw - 24px)); display: flex; flex-direction: column; gap: 8px; font-family: inherit; }
    #autora-ask-pop-title { font-size: 12px; font-weight: 600; color: #edeff5; }
    #autora-ask-pop-sub { font-size: 11px; color: #7a8297; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #autora-ask-input { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 7px 10px; color: #edeff5; font: inherit; font-size: 12.5px; outline: none; width: 100%; box-sizing: border-box; }
    #autora-ask-input:focus { border-color: rgba(110,91,255,.6); box-shadow: 0 0 0 3px rgba(110,91,255,.18); }
    #autora-ask-foot { display: flex; gap: 6px; justify-content: flex-end; }
    #autora-ask-foot button { border: 0; border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer; }
    .ask-cancel { background: rgba(255,255,255,.06); color: #98a1b6; }
    .ask-cancel:hover { background: rgba(255,255,255,.12); }
    .ask-send { background: #6e5bff; color: #fff; font-weight: 500; }
    .ask-send:hover:not(:disabled) { background: #5a48e8; }
    .ask-send:disabled { opacity: .4; cursor: default; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  (document.head || root).appendChild(style);

  // The ribbon starts open in the editor's own memory (the ribbon sheet needs its body); the CSS above is what hides it.
  for (const key of ["aidocs.ribbonCollapsed", "ai-sheets-ribbon-collapsed", "ai-slides-ribbon-collapsed"]) {
    try { window.localStorage.setItem(key, "0"); } catch { /* no storage: the editor's default */ }
  }

  /* ---------------------------------------------------------------- the tools */
  const BLUE = "#2563eb", EMERALD = "#059669", AMBER = "#f59e0b", PURPLE = "#9333ea", INDIGO = "#4f46e5", SKY = "#0284c7", GOLD = "#d97706", ROSE = "#e11d48", CYAN = "#0891b2", SLATE = "#94a3b8";
  /** id, label, group, icon, colour, what it presses, how, flags. `jump` opens the ribbon on the control (and on `tab` first). */
  const t = (id, label, group, icon, color, starts, o = {}) => ({ id, label, group, icon, color, starts: starts || [], ...o });

  const HIST = [t("undo", "Undo", "History", "undo-2", SLATE, ["undo"], { phone: 1, desktop: 1 }), t("redo", "Redo", "History", "redo-2", SLATE, ["redo"], { desktop: 1 })];
  const CLIP = [
    t("cut", "Cut", "Clipboard", "scissors", SLATE, ["cut"]), t("copy", "Copy", "Clipboard", "copy", SLATE, ["copy"]),
    t("paste", "Paste", "Clipboard", "clipboard-paste", SLATE, ["paste"]), t("painter", "Format painter", "Clipboard", "paintbrush", SLATE, ["format painter"]),
  ];

  const TOOLS = {
    docs: [
      ...HIST,
      t("bold", "Bold", "Text", "bold", EMERALD, ["bold"], { phone: 1, desktop: 1 }),
      t("italic", "Italic", "Text", "italic", EMERALD, ["italic"], { phone: 1, desktop: 1 }),
      t("underline", "Underline", "Text", "underline", EMERALD, ["underline"], { phone: 1, desktop: 1 }),
      t("strike", "Strikethrough", "Text", "strikethrough", EMERALD, ["strikethrough"]),
      t("highlight", "Highlight", "Text", "highlighter", AMBER, ["text highlight color"], { pop: 1, phone: 1, desktop: 1 }),
      t("color", "Text colour", "Text", "baseline", PURPLE, ["font color"], { pop: 1, desktop: 1 }),
      t("larger", "Bigger text", "Text", "a-arrow-up", EMERALD, ["increase font size"]),
      t("smaller", "Smaller text", "Text", "a-arrow-down", EMERALD, ["decrease font size"]),
      t("clearfmt", "Clear formatting", "Text", "eraser", ROSE, ["clear all formatting"]),
      t("h1", "Heading", "Paragraph", "heading-1", INDIGO, ["heading 1"]),
      t("bullets", "Bullets", "Paragraph", "list", SKY, ["bullets"], { phone: 1, desktop: 1 }),
      t("numbering", "Numbering", "Paragraph", "list-ordered", SKY, ["numbering"], { phone: 1, desktop: 1 }),
      t("left", "Align left", "Paragraph", "align-left", INDIGO, ["align left"], { desktop: 1 }),
      t("centre", "Centre", "Paragraph", "align-center", INDIGO, ["center"], { desktop: 1 }),
      t("right", "Align right", "Paragraph", "align-right", INDIGO, ["align right"]),
      t("justify", "Justify", "Paragraph", "align-justify", INDIGO, ["justify"]),
      t("indent", "Indent", "Paragraph", "indent-increase", INDIGO, ["increase indent"]),
      t("outdent", "Outdent", "Paragraph", "indent-decrease", INDIGO, ["decrease indent"]),
      t("spacing", "Line spacing", "Paragraph", "text-select", INDIGO, ["line spacing"], { pop: 1 }),
      t("find", "Find", "Edit", "search", BLUE, ["find text in the document"]), t("replace", "Replace", "Edit", "replace", BLUE, ["find and replace"]),
      t("selectall", "Select all", "Edit", "text-select", BLUE, ["select the whole document"]), t("words", "Word count", "Edit", "hash", SKY, ["word count"]),
      t("track", "Track changes", "Edit", "file-diff", ROSE, ["track changes"]),
      ...CLIP,
    ],
    sheets: [
      ...HIST,
      t("bold", "Bold", "Text", "bold", EMERALD, ["bold"], { phone: 1, desktop: 1 }),
      t("italic", "Italic", "Text", "italic", EMERALD, ["italic"], { phone: 1, desktop: 1 }),
      t("underline", "Underline", "Text", "underline", EMERALD, ["underline"], { desktop: 1 }),
      t("strike", "Strikethrough", "Text", "strikethrough", EMERALD, ["strikethrough"]),
      t("larger", "Bigger text", "Text", "a-arrow-up", EMERALD, ["increase font size"]), t("smaller", "Smaller text", "Text", "a-arrow-down", EMERALD, ["decrease font size"]),
      t("color", "Text colour", "Colour", "baseline", PURPLE, ["font color"], { desktop: 1 }),
      t("fill", "Fill colour", "Colour", "paint-bucket", AMBER, ["fill color"], { phone: 1, desktop: 1 }),
      t("borders", "Borders", "Colour", "grid-3x3", INDIGO, ["borders"], { pop: 1 }),
      t("left", "Align left", "Align", "align-left", INDIGO, ["align left"], { desktop: 1 }), t("centre", "Centre", "Align", "align-center", INDIGO, ["align center"]),
      t("right", "Align right", "Align", "align-right", INDIGO, ["align right"]), t("wrap", "Wrap text", "Align", "wrap-text", INDIGO, ["wrap text"], { desktop: 1 }),
      t("merge", "Merge cells", "Align", "merge", INDIGO, ["merge cells"], { pop: 1 }),
      t("currency", "Currency", "Numbers", "dollar-sign", GOLD, ["currency"], { desktop: 1 }), t("percent", "Percent", "Numbers", "percent", GOLD, ["percent"], { desktop: 1 }),
      t("thousands", "Thousands", "Numbers", "hash", GOLD, ["thousands"]), t("moredec", "More decimals", "Numbers", "plus", GOLD, ["increase decimal"]), t("lessdec", "Fewer decimals", "Numbers", "table-properties", GOLD, ["decrease decimal"]),
      t("insrow", "Insert row", "Cells", "rows-3", CYAN, ["insert row"], { phone: 1, desktop: 1 }), t("inscol", "Insert column", "Cells", "columns-3", CYAN, ["insert column"], { phone: 1, desktop: 1 }),
      t("delrow", "Delete row", "Cells", "trash-2", ROSE, ["delete row"]), t("delcol", "Delete column", "Cells", "trash-2", ROSE, ["delete column"]),
      t("fmtcells", "Format cells", "Cells", "table-properties", BLUE, ["format cells"]),
      t("autosum", "AutoSum", "Data", "sigma", SKY, ["autosum"], { pop: 1, phone: 1, desktop: 1 }), t("sort", "Sort & filter", "Data", "funnel", SKY, ["sort & filter"], { pop: 1 }),
      t("cond", "Conditional formatting", "Data", "palette", AMBER, ["conditional formatting"], { pop: 1 }), t("astable", "Format as table", "Data", "table-properties", INDIGO, ["format as table"], { pop: 1 }),
      t("styles", "Cell styles", "Data", "palette", PURPLE, ["cell styles"], { pop: 1 }),
      t("replace", "Replace", "Edit", "replace", BLUE, ["replace"]), t("goto", "Go to", "Edit", "search", BLUE, ["go to"]),
      ...CLIP,
    ],
    slides: [
      ...HIST,
      t("newslide", "New slide", "Slides", "square-plus", CYAN, ["new blank slide"], { phone: 1, desktop: 1 }),
      t("layoutpick", "Layout", "Slides", "layout-template", INDIGO, ["change current slide layout"], { pop: 1, phone: 1, desktop: 1 }),
      t("section", "Add section", "Slides", "plus", CYAN, ["add a section"]),
      t("present", "Present", "Slides", "play", ROSE, ["full-screen show"], { phone: 1, desktop: 1 }),
      t("bold", "Bold", "Text", "bold", EMERALD, ["bold"], { phone: 1, desktop: 1 }),
      t("italic", "Italic", "Text", "italic", EMERALD, ["italic"], { phone: 1, desktop: 1 }),
      t("underline", "Underline", "Text", "underline", EMERALD, ["underline"], { phone: 1, desktop: 1 }),
      t("strike", "Strikethrough", "Text", "strikethrough", EMERALD, ["strikethrough"]),
      t("color", "Text colour", "Text", "baseline", PURPLE, ["font color"], { pop: 1, desktop: 1 }),
      t("larger", "Bigger text", "Text", "a-arrow-up", EMERALD, ["increase font size"], { desktop: 1 }), t("smaller", "Smaller text", "Text", "a-arrow-down", EMERALD, ["decrease font size"], { desktop: 1 }),
      t("clearfmt", "Clear formatting", "Text", "eraser", ROSE, ["clear all formatting"]), t("para", "Paragraph", "Text", "align-left", INDIGO, ["paragraph"], { pop: 1 }),
      t("formatpane", "Format pane", "Arrange", "panel-right", BLUE, ["show or hide the format pane"], { desktop: 1 }), t("arrange", "Align & distribute", "Arrange", "layout-grid", INDIGO, ["align or evenly distribute"], { pop: 1 }),
      t("notes", "Notes", "Arrange", "message-square", SKY, ["hide notes", "show notes"]),
      ...CLIP,
    ],
  }[app];

  /* ------------------------------------------------------------ the editor's own buttons */
  const named = (el) => ["data-tip", "aria-label", "title"].map((a) => (el.getAttribute(a) || "").trim().toLowerCase()).filter(Boolean);
  const mine = (el) => el.closest("#autora-rail, #autora-grid, #autora-ask-pop, #autora-menu") || el.classList.contains("ai-entry");
  /** The editor's button whose name starts with one of `starts`, never one of ours and never an AI one. */
  function find(starts) {
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (mine(el)) continue;
      const names = named(el);
      if (starts.some((s) => names.some((n) => n.startsWith(s)))) return el;
    }
    return null;
  }
  /** A ribbon tab, by its whole name. */
  function tabButton(name) {
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (mine(el)) continue;
      if (named(el).includes(name) || (el.textContent || "").trim().toLowerCase() === name) return el;
    }
    return null;
  }
  const isOn = (el) => !!el && (el.getAttribute("aria-pressed") === "true" || el.classList.contains("active") || el.classList.contains("is-active") || el.classList.contains("on"));
  const isOff = (el) => !el || el.disabled || el.getAttribute("aria-disabled") === "true";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Press a button the way a hand does: some of the editors' buttons act on the press, not on the click. */
  function press(el) {
    if (!el) return;
    const at = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, view: window, clientX: at.left + at.width / 2, clientY: at.top + at.height / 2, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
    }
    el.click();
  }

  /** The label a ribbon control goes by: the start of its name, without the shortcut or the tip after it. */
  const short = (el) => {
    const shown = (el.textContent || "").trim().replace(/\s+/g, " ");
    const tip = (el.getAttribute("data-tip") || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    let nice = (tip || shown).split(/\s*[:—(]\s*/)[0].trim().replace(/^(insert|add|create)\s+(a|an|the)\s+/i, "").replace(/^(insert|add)\s+/i, "");
    if (nice.length > 24 && shown && shown.length <= 24) nice = shown;
    nice = nice.charAt(0).toUpperCase() + nice.slice(1);
    return nice.length > 24 ? `${nice.slice(0, 23)}…` : nice;
  };
  /** The controls of the ribbon tab that is open: not the tabs, not the title row, not a drop-down's second half. */
  function controlsOfTab() {
    const box = document.querySelector(".ribbon, header.excel-header");
    if (!box) return [];
    const out = [];
    for (const el of box.querySelectorAll("button, [role=button]")) {
      if (mine(el) || el.closest(".ribbon-tabs, .qa-btn") || el.classList.contains("ribbon-tab") || el.classList.contains("qa-btn")) continue;
      if (/caret/.test(el.className?.toString() || "")) continue;
      const label = short(el);
      if (!label || label.length < 2) continue;
      out.push({ el, label, names: named(el), icon: el.querySelector("svg, img")?.outerHTML ?? "" });
    }
    return out;
  }

  /* ----------------------------------------------- which ribbon tab is open, and every command on every tab */
  const TABS = {
    docs: [["home", "Home", BLUE], ["insert", "Insert", CYAN], ["draw", "Draw", PURPLE], ["design", "Design", AMBER], ["layout", "Layout", INDIGO], ["references", "References", SKY], ["review", "Review", GOLD], ["view", "View", BLUE]],
    sheets: [["home", "Home", BLUE], ["insert", "Insert", CYAN], ["page layout", "Page layout", INDIGO], ["formulas", "Formulas", SKY], ["data", "Data", SKY], ["review", "Review", GOLD], ["view", "View", BLUE]],
    slides: [["home", "Home", BLUE], ["insert", "Insert", CYAN], ["draw", "Draw", PURPLE], ["design", "Design", AMBER], ["transitions", "Transitions", INDIGO], ["animations", "Animations", GOLD], ["slide show", "Slide show", ROSE], ["review", "Review", GOLD], ["view", "View", BLUE]],
  }[app];
  let curTab = "home";
  /** Opens a ribbon tab (unseen) and waits for its controls to be drawn. */
  async function showTab(name) {
    if (curTab === name) return;
    press(tabButton(name));
    curTab = name;
    await wait(220);
  }
  /** Every curated tool already names its button, so a command the ribbon has under one of those names is not listed twice. */
  const curated = (names) => TOOLS.some((x) => x.starts.some((s) => names.some((n) => n.startsWith(s))));
  let scanned = false;
  async function scan() {
    if (scanned) return;
    scanned = true;
    const found = [];
    for (const [key, label, color] of TABS) {
      await showTab(key);
      const seen = new Set();
      for (const c of controlsOfTab()) {
        const id = `r:${key}:${c.label.toLowerCase()}`;
        if (seen.has(id) || curated(c.names)) continue;
        seen.add(id);
        found.push({ id, label: c.label, group: label, color, tab: key, names: c.names.length ? c.names : [c.label.toLowerCase()], iconHtml: c.icon, starts: [], auto: 1, pop: /dropdown|caret|menu/.test(c.el.className?.toString() || "") || !!c.el.getAttribute("aria-haspopup") });
      }
    }
    await showTab("home");
    for (const x of found) { TOOLS.push(x); byId.set(x.id, x); }
    refresh();
    // Every command is read and the Home tab is back: tools can be pressed and their state read (tests wait for this).
    root.setAttribute("data-rail-scanned", "1");
  }

  const anchored = () => root.classList.contains("rail-ribbon");
  function setAnchor(on) { root.classList.toggle("rail-ribbon", on); }
  let busy = false;
  /** Press a tool: the editor's own button, on the right ribbon tab, with a drop-down opening beside the bar. */
  /** In the card, the (unseen) ribbon is moved so the control about to be pressed sits where `at` is: its drop-down opens there, by the card. */
  async function lineUp(el, at) {
    const box = document.querySelector(".ribbon, header.excel-header");
    if (!el || !box || !at) return;
    await wait(30);
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    root.style.setProperty("--rb-x", `${Math.round(at.left - (r.left - b.left))}px`);
    root.style.setProperty("--rb-y", `${Math.round(at.top - (r.top - b.top))}px`);
    await wait(30);
  }
  async function run(tool, at = null) {
    if (busy) return;
    busy = true;
    try {
      const tab = tool.tab || "home";
      // A drop-down opens next to its button, so for it the (unseen) ribbon sits beside the bar; any other press puts it away.
      const opens = !!(tool.pop || tool.auto);
      setAnchor(opens);
      if (curTab !== tab) await showTab(tab);
      const el = tool.auto
        ? (controlsOfTab().find((c) => c.names.join("|") === tool.names.join("|") || c.label === tool.label) || {}).el
        : find(tool.starts);
      if (card && opens) await lineUp(el, at || cardSpot());
      press(el);
      // A command that does not open anything leaves the Home tab as it found it, so the common tools can read their state again.
      if (tab !== "home" && !opens) { await wait(200); await showTab("home"); }
      // One that may have opened something keeps its tab until the person moves on (a click in the page, Esc), or a while passes.
      if (opens) setTimeout(() => { if (!document.querySelector("[role=dialog]:not(#autora-grid .box), [role=menu], [role=listbox]")) { setAnchor(false); if (curTab !== "home") void showTab("home"); } }, 8000);
    } finally { busy = false; }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && anchored() && !grid) { setAnchor(false); if (curTab !== "home") void showTab("home"); } }, true);
  // Pressing in the page puts a drop-down's anchor away and brings the Home tab back.
  document.addEventListener("pointerdown", (e) => {
    if (!anchored() || (e.target instanceof Element && e.target.closest("#autora-rail, #autora-grid"))) return;
    setTimeout(() => { setAnchor(false); if (curTab !== "home") void showTab("home"); }, 400);
  }, true);

  /* ---------------------------------------------------------------- card positioning (docs / sheets desktop) */
  /*
   * Ask Autora contract (host op: "ask-selection"):
   *   payload: { app: "docs"|"sheets"|"slides", range: string, text: string, instruction: string }
   *   The shell's OfficeWindow.tsx handles "ask-selection" by posting to /api/sessions/:id/message
   *   with a prefixed user message: "[Autora App: range] instruction\n<selection>text</selection>"
   *   Another engine opts in by calling window.__autora.host("ask-selection", payload) with the same shape.
   */
  function cardSpot() {
    if (app === "docs") {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width || r.height) return r;
      }
    }
    if (lastPointer) return { left: lastPointer.x, top: lastPointer.y, right: lastPointer.x, bottom: lastPointer.y, width: 0, height: 0 };
    return null;
  }

  function placeCard(spot) {
    if (!bar || !spot) return;
    const margin = 10;
    const cardW = bar.offsetWidth || 200;
    const cardH = bar.offsetHeight || 48;
    let left = spot.left;
    let top = (spot.bottom != null ? spot.bottom : spot.top) + 10;
    if (left + cardW > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - cardW - margin);
    if (top + cardH > window.innerHeight - margin) top = Math.max(margin, (spot.top || 0) - cardH - 10);
    if (left < margin) left = margin;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  function openCard(spot) {
    if (!card || !bar) return;
    if (spot) placeCard(spot);
    bar.setAttribute("data-open", "1");
  }

  function closeCard() {
    if (!card || !bar) return;
    bar.setAttribute("data-open", "0");
    root.classList.remove("fx-on");
    closeAsk();
  }

  if (card) {
    // Open the card when the person interacts with the grid (sheets) or the document (docs).
    document.addEventListener("pointerup", (e) => {
      if (!bar || !e.target || mine(e.target) || e.button !== 0) return;
      const inWork = !!(
        (app === "sheets" && e.target.closest?.("#univer-container, .spreadsheet, [data-u-comp]")) ||
        (app === "docs" && e.target.closest?.(".ProseMirror, [contenteditable='true']"))
      );
      if (inWork) {
        lastPointer = { x: e.clientX, y: e.clientY };
        setTimeout(() => { const c = readContext(); if (c.doc) openCard(cardSpot()); }, 60);
      }
    }, true);

    // Close when the person clicks outside both the editor and our card.
    document.addEventListener("pointerdown", (e) => {
      if (!bar || bar.getAttribute("data-open") !== "1" || !e.target || mine(e.target)) return;
      const keepOpen = !!(
        (app === "sheets" && e.target.closest?.("#univer-container, .spreadsheet, [data-u-comp]")) ||
        (app === "docs" && e.target.closest?.(".ProseMirror, [contenteditable='true']"))
      );
      if (!keepOpen) setTimeout(closeCard, 50);
    }, true);

    // For docs: also open/update card position when the selection changes.
    if (app === "docs") {
      document.addEventListener("selectionchange", () => {
        if (!bar) return;
        const sel = window.getSelection();
        const surface = document.querySelector(".ProseMirror");
        if (sel && surface && sel.anchorNode && surface.contains(sel.anchorNode)) {
          const spot = (() => {
            if (!sel.rangeCount) return null;
            const r = sel.getRangeAt(0).getBoundingClientRect();
            return (r.width || r.height) ? r : null;
          })();
          if (spot) lastPointer = { x: spot.right || spot.left, y: spot.bottom || spot.top };
          setTimeout(() => { const c = readContext(); if (c.doc) openCard(spot || cardSpot()); }, 50);
        } else if (bar.getAttribute("data-open") === "1") {
          setTimeout(() => {
            const sel2 = window.getSelection();
            const s2 = document.querySelector(".ProseMirror");
            if (!sel2 || !s2 || !sel2.anchorNode || !s2.contains(sel2.anchorNode)) closeCard();
          }, 200);
        }
      });
    }

    // Escape closes the card.
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && bar && bar.getAttribute("data-open") === "1" && !grid) closeCard(); }, true);

    /* The card belongs to the cell (or words) it came to (R17b). It sits at a point on the screen, so when the work moves under
       it -- a scroll, a pan, a zoom, the window resized, the pick moved with the keys -- it would stay where it was and drift
       off its cell, across the work. So it goes as soon as the view moves, and comes back at the pick on the next click. A
       formula being typed in its bar is the exception: that bar is where the person is typing, and it stays with them. */
    const typingFx = () => !!document.activeElement?.closest?.("[data-u-comp='formula-bar']");
    const viewMoved = (e) => {
      // Only what the person does: this shim tells the editor of its own changes with made-up resizes (refit, below).
      if (!e.isTrusted || !bar || bar.getAttribute("data-open") !== "1" || typingFx()) return;
      if (e.target instanceof Element && mine(e.target)) return;
      closeCard();
    };
    const WORK = app === "sheets" ? "#univer-container, .spreadsheet, [data-u-comp]" : ".ProseMirror, [contenteditable='true']";
    // A scroll of the work itself (the page, or the grid's own panes), not of a list or field that scrolls inside a dialog.
    const ofWork = (e) => e.target === document || e.target === document.documentElement || e.target === document.body
      || (e.target instanceof Element && (e.target.matches(WORK) || !!e.target.querySelector?.(WORK)));
    document.addEventListener("wheel", (e) => { if (e.target instanceof Element && e.target.closest(WORK)) viewMoved(e); }, { capture: true, passive: true });
    document.addEventListener("scroll", (e) => { if (bar?.getAttribute("data-open") === "1" && ofWork(e)) viewMoved(e); }, { capture: true, passive: true });
    window.addEventListener("resize", viewMoved);
    // In Sheets the keys move the pick to another cell (Pages' card follows its selection as it changes, above).
    const MOVES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Tab", "Enter"]);
    if (app === "sheets") document.addEventListener("keydown", (e) => { if (MOVES.has(e.key) && !e.altKey) viewMoved(e); }, true);
  }

  /* ------------------------------------------------------- the bar follows the work */
  /*
   * What the work needs on the bar now (docs/TOOL-RAIL.md, "The bar follows the work"). A tool with a rule is there when its rule says so;
   * one without is always there (once a document is open: with none, the bar has no tools). Everything stays in All tools. An app with no
   * RULES keeps the bar it has always had (all three have them now).
   */
  const RULES = {
    docs: {
      // Words that are picked: what can be done to them.
      bold: (c) => c.selected, italic: (c) => c.selected, underline: (c) => c.selected,
      strike: (c) => c.selected, highlight: (c) => c.selected, color: (c) => c.selected, larger: (c) => c.selected, smaller: (c) => c.selected,
      clearfmt: (c) => c.selected, painter: (c) => c.selected, cut: (c) => c.selected, copy: (c) => c.selected,
      // A paragraph with words in it: how it sits and is spaced; a list item or picked paragraphs: how far in.
      left: (c) => c.text, centre: (c) => c.text, right: (c) => c.text, justify: (c) => c.text, spacing: (c) => c.text,
      indent: (c) => c.inList || c.selected, outdent: (c) => c.inList || c.selected,
      // The editor's own word on whether there is anything to take back or put back.
      undo: (c) => c.undo, redo: (c) => c.redo,
    },
    slides: {
      // Something on the slide picked (the editor's own Bold is lit): what can be done to it, and how it sits among the others.
      bold: (c) => c.selected, italic: (c) => c.selected, underline: (c) => c.selected, strike: (c) => c.selected, color: (c) => c.selected,
      larger: (c) => c.selected, smaller: (c) => c.selected, clearfmt: (c) => c.selected, para: (c) => c.selected, arrange: (c) => c.selected,
      formatpane: (c) => c.selected, cut: (c) => c.selected, copy: (c) => c.selected,
      undo: (c) => c.undo, redo: (c) => c.redo,
    },
    sheets: {
      // A block of cells picked: how it sits, wraps, joins, is bordered and written as numbers, and what can be done to it as data.
      left: (c) => c.range, centre: (c) => c.range, right: (c) => c.range, wrap: (c) => c.range, merge: (c) => c.range, borders: (c) => c.range,
      currency: (c) => c.range, percent: (c) => c.range, thousands: (c) => c.range, moredec: (c) => c.range, lessdec: (c) => c.range,
      strike: (c) => c.range, sort: (c) => c.range, cond: (c) => c.range, astable: (c) => c.range, styles: (c) => c.range,
      undo: (c) => c.undo, redo: (c) => c.redo,
    },
  }[app];
  /** What the open document has, read off the editor's page (a few times a second, with the bar's other state). */
  function readContext() {
    if (app === "docs") {
      const surface = document.querySelector('.ProseMirror[contenteditable="true"]') || document.querySelector(".ProseMirror");
      const sel = window.getSelection();
      const inside = !!(surface && sel && sel.anchorNode && surface.contains(sel.anchorNode));
      const at = inside ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
      const undo = find(["undo"]), redo = find(["redo"]);
      return {
        doc: !!surface, text: !!surface && (surface.textContent || "").trim().length > 0,
        selected: inside && !sel.isCollapsed, inList: !!at?.closest("li"),
        undo: !!undo && !isOff(undo), redo: !!redo && !isOff(redo),
        pick: inside && !sel.isCollapsed ? String(sel).replace(/\s+/g, " ").trim().slice(0, 120) : "",
      };
    }
    if (app === "sheets") {
      // The grid is drawn on a canvas; the name box above it says what is picked ("A1", or "A1:B3", "A:A", "3:3" for more than a cell).
      const box = document.querySelector("[data-u-comp='defined-name'] input");
      const undo = find(["undo"]), redo = find(["redo"]);
      return { doc: !!box, range: !!box && String(box.value || "").includes(":"), pick: box ? String(box.value || "").slice(0, 40) : "", undo: !!undo && !isOff(undo), redo: !!redo && !isOff(redo) };
    }
    if (app === "slides") {
      // The slide is drawn on a canvas, but the ribbon's own buttons know what is picked: they are lit when a box or shape is, dim when not.
      const bold = find(["bold"]), undo = find(["undo"]), redo = find(["redo"]);
      const picked = !!bold && !isOff(bold);
      return { doc: !!document.querySelector(".stage-wrap, .slide-list"), selected: picked, pick: picked ? "a box or shape on the slide" : "", undo: !!undo && !isOff(undo), redo: !!redo && !isOff(redo) };
    }
    return { doc: true };
  }
  /*
   * The editor reads "no document", "no words" or "nothing picked" for a beat while it re-renders; each is held for a while before the bar
   * believes it (a document or words for two seconds, a Slides pick for under one), so tools do not blink out and back.
   */
  const HOLD = { doc: 2000, text: 2000, selected: app === "slides" ? 800 : 0 };
  const lastTrue = {};
  function steady(raw) {
    const now = Date.now();
    const out = { ...raw };
    for (const [key, ms] of Object.entries(HOLD)) {
      if (!ms || !(key in raw)) continue;
      if (raw[key]) lastTrue[key] = now;
      else if (lastTrue[key] && now - lastTrue[key] < ms) out[key] = true;
    }
    return out;
  }
  /** What the person has picked, said to the host when it changes (at most once a second): the agent's briefing carries it. */
  let sentPick = "", sentAt = 0;
  function reportPick(c) {
    const pick = c.doc ? String(c.pick || "") : "";
    const now = Date.now();
    if (pick === sentPick || now - sentAt < 1000) return;
    sentPick = pick; sentAt = now;
    try { void window.__autora.host("pick", { text: pick }).catch(() => undefined); } catch { /* no host: nobody to tell */ }
  }
  const needed = (tool, c) => !!c.doc && (RULES[tool.id] ? !!RULES[tool.id](c) : true);
  /** Marks which of the pinned tools the work needs, as many as fit; the CSS fades the rest out. */
  function applyNeed() {
    if (!RULES || !bar) return;
    const c = steady(readContext());
    reportPick(c);
    // The card shows all needed tools with no space limit; the fixed bar respects room().
    let free = card ? Infinity : room();
    for (const b of bar.querySelectorAll("button[data-tool]")) {
      const yes = needed(byId.get(b.dataset.tool), c) && free > 0;
      if (yes && free !== Infinity) free--;
      const want = yes ? "1" : "0";
      if (b.dataset.need !== want) b.dataset.need = want;
    }
  }

  /* ------------------------------------------------------------------ the bar and the grid */
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${(window.__autoraIcons || {})[name] || (window.__autoraIcons || {}).plus || ""}</svg>`;
  const iconOf = (tool) => (tool.iconHtml ? tool.iconHtml.replace(/<svg/, '<svg style="width:20px;height:20px"') : svg(tool.icon));
  const PINS = `autora-rail-pins-${app}`;
  let pins = (() => {
    try { const saved = JSON.parse(localStorage.getItem(PINS) || "null"); if (Array.isArray(saved)) return saved; } catch { /* the defaults */ }
    return TOOLS.filter((x) => x.desktop).map((x) => x.id);
  })();
  const savePins = () => { try { localStorage.setItem(PINS, JSON.stringify(pins)); } catch { /* this session only */ } };
  const byId = new Map(TOOLS.map((x) => [x.id, x]));
  const shownIds = () => (phone ? TOOLS.filter((x) => x.phone).map((x) => x.id) : pins.filter((id) => byId.has(id)));

  // The sizes every app's bar uses (docs/TOOL-RAIL.md, "Sizes").
  const BTN = phone ? 40 : 34, GAP = phone ? 2 : 3, PAD = phone ? 8 : 5;
  const room = () => {
    const space = phone ? window.innerWidth : window.innerHeight - 16;
    return Math.max(1, Math.floor((space - 2 * PAD - 12 + GAP) / (BTN + GAP)) - 1);
  };

  let bar = null, grid = null, toast = "";
  const swallow = (el) => { el.addEventListener("pointerdown", (e) => e.preventDefault()); el.addEventListener("mousedown", (e) => e.preventDefault()); };

  function state(tool) {
    if (tool.auto || tool.tab) return { on: false, off: false, found: true };
    const el = find(tool.starts);
    return { on: isOn(el), off: isOff(el), found: !!el, key: el && !phone ? shortcutOf(el, tool.id) : "" };
  }
  /** The editor's own shortcut for a command, as its button names it: "Bold (Ctrl+B)" or "Paste Ctrl+V". Kept working: the editor handles the keys. */
  const COMMON = { bold: "Ctrl+B", italic: "Ctrl+I", underline: "Ctrl+U", undo: "Ctrl+Z", redo: "Ctrl+Y", cut: "Ctrl+X", copy: "Ctrl+C", paste: "Ctrl+V", find: "Ctrl+F", replace: "Ctrl+H", selectall: "Ctrl+A", goto: "Ctrl+G", left: "Ctrl+L", centre: "Ctrl+E", right: "Ctrl+R", justify: "Ctrl+J", newslide: "Ctrl+M" };
  function shortcutOf(el, id) {
    for (const n of [el.getAttribute("data-tip"), el.getAttribute("aria-label"), el.getAttribute("title")]) {
      const m = /\(((?:ctrl|shift|alt|cmd|⌘)[^)]*)\)/i.exec(n || "") || /\b((?:ctrl|shift|alt)\+[A-Za-z0-9+]+)\s*$/i.exec(n || "");
      if (m) return m[1];
    }
    return COMMON[id] || "";
  }

  function drawBar() {
    if (!bar) return;
    bar.textContent = "";
    // In the sheets card, the formula bar occupies the first full row.
    if (card && app === "sheets") {
      const fxSlot = document.createElement("div");
      fxSlot.className = "fx-slot";
      bar.appendChild(fxSlot);
    }
    for (const id of RULES ? shownIds() : shownIds().slice(0, room())) {
      const tool = byId.get(id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rb";
      b.dataset.tool = id;
      if (tool.starts.length) b.dataset.starts = tool.starts.join("|");
      b.style.setProperty("--tc", tool.color);
      b.title = tool.label;
      b.setAttribute("aria-label", tool.label);
      b.innerHTML = iconOf(tool);
      swallow(b);
      b.addEventListener("click", () => void run(tool, bar ? bar.getBoundingClientRect() : null));
      if (RULES) b.dataset.need = "1";
      bar.appendChild(b);
    }
    // Marked before the first frame is drawn, so nothing fades that was never in; a transition runs on each change from there.
    if (RULES) applyNeed();
    // Ask Autora button: shown in the card when there is something selected.
    if (card) {
      const askBtn = document.createElement("button");
      askBtn.type = "button";
      askBtn.id = "autora-ask-btn";
      askBtn.setAttribute("aria-label", "Ask Autora");
      // Sparkle icon (filled paths, no stroke)
      askBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7L12 3z" fill="currentColor"/><path d="M19 15l.85 2.3L22 18.15l-2.15.85L19 21.3l-.85-2.3-2.15-.85 2.15-.85L19 15z" fill="currentColor"/></svg>Ask Autora`;
      swallow(askBtn);
      askBtn.addEventListener("click", openAsk);
      bar.appendChild(askBtn);
    }
    const div = document.createElement("i");
    div.className = "div";
    bar.appendChild(div);
    const g = document.createElement("button");
    g.type = "button";
    g.className = "rb";
    g.style.setProperty("--tc", "#98a1b6");
    g.title = "All tools";
    g.setAttribute("aria-label", "All tools");
    g.setAttribute("aria-haspopup", "dialog");
    g.innerHTML = svg("layout-grid");
    swallow(g);
    g.addEventListener("click", openGrid);
    bar.appendChild(g);
    paint();
  }

  /** Which tools are lit or dimmed: read from the editor's own buttons, a few times a second (only while its Home tab is the one open). */
  function paint() {
    if (curTab !== "home") return;
    applyNeed();
    if (bar) {
      for (const b of bar.querySelectorAll("button[data-tool]")) {
        const s = state(byId.get(b.dataset.tool));
        b.classList.toggle("on", !!s.on);
        b.disabled = !!s.off;
        if (s.key) { const label = byId.get(b.dataset.tool).label; b.title = `${label} (${s.key})`; }
        if (b.dataset.starts) b.toggleAttribute("data-linked", !!s.found);
      }
    }
    if (grid) {
      for (const b of grid.querySelectorAll("button[data-tile]")) {
        const s = state(byId.get(b.dataset.tile));
        b.classList.toggle("on", !!s.on);
        b.disabled = !!s.off;
      }
    }
  }
  function refresh() { drawBar(); if (grid) fillGrid?.(); }

  let fillGrid = null;
  function openGrid() {
    closeGrid();
    grid = document.createElement("div");
    grid.id = "autora-grid";
    grid.setAttribute("role", "presentation");
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "All tools");
    grid.appendChild(box);
    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = "<h3>All tools</h3>";
    if (!phone) {
      const reset = document.createElement("button");
      reset.type = "button"; reset.className = "plain"; reset.textContent = "Reset bar";
      reset.addEventListener("click", () => { pins = TOOLS.filter((x) => x.desktop).map((x) => x.id); savePins(); refresh(); });
      head.appendChild(reset);
    }
    const x = document.createElement("button");
    x.type = "button"; x.className = "plain x"; x.setAttribute("aria-label", "Close"); x.innerHTML = svg("x");
    x.addEventListener("click", closeGrid);
    head.appendChild(x);
    box.appendChild(head);
    const hint = document.createElement("p");
    hint.className = "hint";
    box.appendChild(hint);
    const body = document.createElement("div");
    box.appendChild(body);

    fillGrid = () => {
      const ids = shownIds();
      hint.textContent = toast || (phone ? "Tap a tool to use it." : `Pin the tools you use most to your bar. It has room for ${room()} at this window size (${ids.length} pinned).`);
      body.textContent = "";
      const groups = [];
      for (const tool of TOOLS) if (!groups.includes(tool.group)) groups.push(tool.group);
      for (const g of groups) {
        const h = document.createElement("h4");
        h.textContent = g;
        body.appendChild(h);
        const tiles = document.createElement("div");
        tiles.className = "ar-tiles";
        for (const tool of TOOLS.filter((y) => y.group === g)) {
          const wrap = document.createElement("div");
          wrap.className = "ar-wrap";
          wrap.style.setProperty("--tc", tool.color);
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ar-tile";
          b.dataset.tile = tool.id;
          b.innerHTML = `${iconOf(tool)}<span></span>`;
          b.querySelector("span").textContent = tool.label;
          swallow(b);
          b.addEventListener("click", () => { closeGrid(); void run(tool); });
          wrap.appendChild(b);
          if (!phone) {
            const pin = document.createElement("button");
            const pinned = ids.includes(tool.id);
            pin.type = "button";
            pin.className = `ar-pin${pinned ? " on" : ""}`;
            pin.setAttribute("aria-pressed", String(pinned));
            pin.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${tool.label} ${pinned ? "from" : "to"} the bar`);
            pin.innerHTML = svg("pin");
            pin.addEventListener("click", () => {
              if (pinned) pins = pins.filter((p) => p !== tool.id);
              else if (ids.length >= room()) { toast = "The bar is full. Unpin a tool first."; refresh(); return; }
              else pins = [...pins, tool.id];
              toast = "";
              savePins(); refresh();
            });
            wrap.appendChild(pin);
          }
          tiles.appendChild(wrap);
        }
        body.appendChild(tiles);
      }
      paint();
    };
    toast = "";
    fillGrid();
    grid.addEventListener("click", (e) => { if (e.target === grid) closeGrid(); });
    document.body.appendChild(grid);
  }
  function closeGrid() { grid?.remove(); grid = null; fillGrid = null; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && grid) closeGrid(); }, true);

  /* ---------------------------------------------------------------- Ask Autora popover */
  let askPop = null;
  function openAsk(near) {
    closeAsk();
    const c = readContext();
    const range = String(c.pick || "");
    askPop = document.createElement("div");
    askPop.id = "autora-ask-pop";
    askPop.setAttribute("role", "dialog");
    askPop.setAttribute("aria-label", "Ask Autora");
    const title = document.createElement("div");
    title.id = "autora-ask-pop-title";
    title.textContent = "Ask Autora";
    askPop.appendChild(title);
    if (range) {
      const sub = document.createElement("div");
      sub.id = "autora-ask-pop-sub";
      sub.textContent = range;
      askPop.appendChild(sub);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.id = "autora-ask-input";
    input.placeholder = "What would you like to do?";
    input.setAttribute("aria-label", "Instruction");
    askPop.appendChild(input);
    const foot = document.createElement("div");
    foot.id = "autora-ask-foot";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "ask-cancel"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeAsk);
    const send = document.createElement("button");
    send.type = "button"; send.className = "ask-send"; send.textContent = "Send →";
    send.disabled = true;
    input.addEventListener("input", () => { send.disabled = input.value.trim().length === 0; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && !send.disabled) { e.preventDefault(); doAsk(input.value.trim(), range); }
      if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
    });
    send.addEventListener("click", () => { if (!send.disabled) doAsk(input.value.trim(), range); });
    foot.appendChild(cancel); foot.appendChild(send);
    askPop.appendChild(foot);
    // Position below/above the bar (or what it was asked from: the menu's row).
    if (near || bar) {
      const br = near && typeof near.left === "number" ? near : bar.getBoundingClientRect();
      const popW = Math.min(300, window.innerWidth - 24);
      let popLeft = Math.max(8, Math.min(br.left, window.innerWidth - popW - 8));
      const popBelow = br.bottom + 8;
      const popAbove = br.top - 8 - 170; // estimated height
      const top = popBelow + 170 <= window.innerHeight - 8 ? popBelow : Math.max(8, popAbove);
      askPop.style.left = `${Math.round(popLeft)}px`;
      askPop.style.top = `${Math.round(top)}px`;
    }
    document.body.appendChild(askPop);
    setTimeout(() => input.focus(), 30);
  }
  function closeAsk() { askPop?.remove(); askPop = null; }
  function doAsk(instruction, range) {
    if (!instruction) return;
    closeAsk();
    try {
      void window.__autora.host("ask-selection", { app, range, text: range, instruction }).catch(() => undefined);
    } catch { /* no host */ }
  }


  /* ---------------------------------------------------------------- the context menu (M1, M2) */
  /*
   * Right-click in the work gives one short vertical list of groups, the same shape in every Panacea app (M1): Formatting,
   * Data, Formula, Autora. A group opens beside it to its entries, and only the entries that apply to what is picked are
   * there (the card's own rules); a group with none is not shown. Each entry presses the editor's own command, as the card
   * does, so it is the editor that does the work. It sits at the pointer and goes when anything else happens. The
   * editor's own menu is off (office/patches/0004), so this is the one menu.
   */
  const MENU = {
    sheets: [
      ["Formatting", ["bold", "italic", "underline", "color", "fill"]],
      ["Data", ["sort", "cond", "astable", "insrow", "inscol", "delrow", "delcol"]],
      ["Formula", ["autosum", "fn"]],
      ["Autora", ["ask", "all"]],
    ],
  }[app] || null;
  const MENU_LABEL = { fill: "Cell colour", sort: "Sort & filter" };
  const MENU_WORK = app === "sheets" ? "#univer-container, .spreadsheet, [data-u-comp]" : ".ProseMirror, [contenteditable='true']";
  /** What an entry is: a tool of the card, the Formulas tab's Insert function (once All tools has read the ribbon), or ours. */
  function menuEntry(id, c) {
    if (id === "ask") return c.doc ? { id, label: "Ask Autora…", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7L12 3z" fill="currentColor"/><path d="M19 15l.85 2.3L22 18.15l-2.15.85L19 21.3l-.85-2.3-2.15-.85 2.15-.85L19 15z" fill="currentColor"/></svg>', color: "#8b7bff", act: (at) => openAsk(at) } : null;
    if (id === "all") return { id, label: "All tools", icon: svg("layout-grid"), color: "#98a1b6", act: () => openGrid() };
    const tool = id === "fn" ? TOOLS.find((x) => x.tab === "formulas" && /function/i.test(x.label)) : byId.get(id);
    if (!tool || !needed(tool, c)) return null;
    const st = state(tool);
    if (!st.found) return null;
    return { id, label: MENU_LABEL[id] || tool.label, icon: iconOf(tool), color: tool.color, on: !!st.on, off: !!st.off, key: st.key || "", act: (at) => void run(tool, at) };
  }
  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  function openMenu(x, y) {
    closeMenu();
    if (!MENU) return;
    const c = steady(readContext());
    const groups = MENU.map(([name, ids]) => [name, ids.map((id) => menuEntry(id, c)).filter(Boolean)]).filter(([, items]) => items.length);
    if (!groups.length) return;
    menu = document.createElement("div");
    menu.id = "autora-menu";
    const list = document.createElement("div");
    list.className = "am-list";
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", c.pick ? `Menu for ${c.pick}` : "Menu");
    menu.appendChild(list);
    let sub = null, open = null;
    const shut = () => { sub?.remove(); sub = null; if (open) open.setAttribute("aria-expanded", "false"); open = null; };
    const rowsOf = (panel) => [...panel.querySelectorAll("button:not(:disabled)")];
    const step = (panel, d) => {
      const rows = rowsOf(panel);
      if (!rows.length) return;
      const i = rows.indexOf(document.activeElement);
      rows[(i + d + rows.length) % rows.length].focus();
    };
    const showGroup = (row, items, focus) => {
      if (open === row) { if (focus) rowsOf(sub)[0]?.focus(); return; }
      shut();
      open = row;
      row.setAttribute("aria-expanded", "true");
      sub = document.createElement("div");
      sub.className = "am-list am-sub";
      sub.setAttribute("role", "menu");
      sub.setAttribute("aria-label", row.dataset.group);
      for (const it of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "menuitem");
        b.className = it.on ? "on" : "";
        b.disabled = it.off;
        b.style.setProperty("--tc", it.color);
        b.innerHTML = `${it.icon}<span></span>${it.key ? "<kbd></kbd>" : ""}`;
        b.querySelector("span").textContent = it.label;
        if (it.key) b.querySelector("kbd").textContent = it.key;
        swallow(b);
        b.addEventListener("click", () => {
          const at = b.getBoundingClientRect();
          closeMenu();
          it.act({ left: at.left, top: at.top, right: at.right, bottom: at.bottom, width: at.width, height: at.height });
        });
        b.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); step(sub, e.key === "ArrowDown" ? 1 : -1); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); const r = open; shut(); r?.focus(); }
        });
        sub.appendChild(b);
      }
      menu.appendChild(sub);
      // Beside its row, on the side there is room; pulled up if it would run off the bottom.
      const r = row.getBoundingClientRect(), m = menu.getBoundingClientRect(), w = sub.offsetWidth, h = sub.offsetHeight;
      const right = r.right + 2 + w <= window.innerWidth - 8;
      sub.style.left = `${Math.round(right ? r.right - m.left + 2 : r.left - m.left - w - 2)}px`;
      sub.style.top = `${Math.round(Math.min(r.top, window.innerHeight - 8 - h) - m.top - 4)}px`;
      if (focus) rowsOf(sub)[0]?.focus();
    };
    for (const [name, items] of groups) {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.group = name;
      row.setAttribute("role", "menuitem");
      row.setAttribute("aria-haspopup", "menu");
      row.setAttribute("aria-expanded", "false");
      row.innerHTML = `<span></span><i aria-hidden="true">›</i>`;
      row.querySelector("span").textContent = name;
      swallow(row);
      row.addEventListener("pointerenter", () => showGroup(row, items, false));
      row.addEventListener("click", () => showGroup(row, items, true));
      row.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); shut(); step(list, e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") { e.preventDefault(); showGroup(row, items, true); }
      });
      list.appendChild(row);
    }
    document.body.appendChild(menu);
    // At the pointer, kept on screen: below and right of it where there is room, never under it.
    const w = list.offsetWidth, h = list.offsetHeight;
    const left = x + 4 + w <= window.innerWidth - 8 ? x + 4 : Math.max(8, x - 4 - w);
    const top = y + 4 + h <= window.innerHeight - 8 ? y + 4 : Math.max(8, y - 4 - h);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    list.querySelector("button")?.focus({ preventScroll: true });
  }
  if (MENU && !phone) {
    window.addEventListener("contextmenu", (e) => {
      if (!(e.target instanceof Element) || mine(e.target) || !e.target.closest(MENU_WORK)) return;
      e.preventDefault();
      e.stopPropagation();
      closeCard();
      const { clientX: x, clientY: y } = e;
      // The right press has just moved the pick under the pointer: what applies is read once the name box says so.
      setTimeout(() => openMenu(x, y), 60);
    }, true);
    document.addEventListener("pointerdown", (e) => { if (menu && !(e.target instanceof Element && e.target.closest("#autora-menu"))) closeMenu(); }, true);
    document.addEventListener("keydown", (e) => { if (menu && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);
    document.addEventListener("wheel", () => closeMenu(), { capture: true, passive: true });
    window.addEventListener("resize", (e) => { if (e.isTrusted) closeMenu(); });
    window.addEventListener("blur", () => closeMenu());
  }

  function build() {
    if (document.getElementById("autora-rail") || !document.body) return;
    bar = document.createElement("nav");
    bar.id = "autora-rail";
    bar.setAttribute("aria-label", "Tools");
    document.body.appendChild(bar);
    drawBar();
    window.addEventListener("resize", drawBar);
    setInterval(paint, 400);
    // Once the editor is up, read every command from the ribbon, unseen, so All tools has the lot.
    const ready = setInterval(() => { if (find(["undo"])) { clearInterval(ready); setTimeout(() => void scan(), 800); } }, 500);

    // Sheets card: position the formula bar inside the card when a cell enters edit mode.
    if (card && app === "sheets") {
      /* The bar is laid over its slot in the card, measured every frame while it shows: the card's own rows change as tools
         come and go, and a bar measured once was left behind when they did (R17b). */
      let fxFrame = 0;
      const fxFit = () => {
        fxFrame = 0;
        if (!root.classList.contains("fx-on") || !bar || bar.getAttribute("data-open") !== "1") return;
        const slot = bar.querySelector(".fx-slot");
        if (slot) {
          const sr = slot.getBoundingClientRect(), fbEl = document.querySelector("[data-u-comp='formula-bar']");
          const px = (n) => `${Math.round(n)}px`;
          if (root.style.getPropertyValue("--fx-x") !== px(sr.left)) root.style.setProperty("--fx-x", px(sr.left));
          if (root.style.getPropertyValue("--fx-y") !== px(sr.top)) root.style.setProperty("--fx-y", px(sr.top));
          if (root.style.getPropertyValue("--fx-w") !== px(sr.width)) root.style.setProperty("--fx-w", px(sr.width));
          const h = px(fbEl ? fbEl.offsetHeight : 32);
          if (root.style.getPropertyValue("--fx-h") !== h) root.style.setProperty("--fx-h", h);
        }
        fxFrame = requestAnimationFrame(fxFit);
      };
      document.addEventListener("focusin", (e) => {
        if (!bar || bar.getAttribute("data-open") !== "1") return;
        const fb = e.target && e.target.closest && e.target.closest("[data-u-comp='formula-bar']");
        if (!fb) return;
        root.classList.add("fx-on");
        if (fxFrame) cancelAnimationFrame(fxFrame);
        fxFit();
      }, true);
      document.addEventListener("focusout", (e) => {
        const fb = e.target && e.target.closest && e.target.closest("[data-u-comp='formula-bar']");
        if (!fb) return;
        setTimeout(() => {
          if (!document.activeElement?.closest?.("[data-u-comp='formula-bar']")) root.classList.remove("fx-on");
        }, 100);
      }, true);
    }
  }
  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build, { once: true });

  /* Hiding the ribbon changes the room the page has without the editor being told (a canvas grid draws at the size it last
     measured), so it is told: a resize, a few times while the editor starts, and whenever the anchor comes or goes. */
  const refit = () => window.dispatchEvent(new Event("resize"));
  for (const ms of [400, 1200, 2500, 5000]) setTimeout(refit, ms);
  new MutationObserver(refit).observe(root, { attributes: true, attributeFilter: ["class"] });
})();
