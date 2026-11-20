/**
 * Right-click on the page: the actions that apply to whatever is under the pointer.
 *
 * Two, today:
 *
 *   Edit text    — over words, opens a small box holding them as they are; what
 *                  is typed replaces them IN THE FILE. The change is made by
 *                  Autora's own replace engine (the code behind pdf_replace_text,
 *                  asked for over the bridge as `autora_edit_text`), which takes
 *                  the old words out of the page's content stream instead of
 *                  drawing over them, so the page stays vector and searchable and
 *                  nothing of the old words is left underneath. The desk then
 *                  hands the window the new document and the frame reloads.
 *   Delete       — over an annotation, the same removal the editor's own ✕ on a
 *                  selected mark does.
 *
 * Everything else is left alone: right-click off a word and off a mark is the
 * browser's (and the tool panels are untouched). Nothing here reads or writes the
 * editor's state; it works from what is on screen and from the bridge, which is
 * what keeps it out of Spectra's ~340k lines and safe across a pin bump.
 */
import { call } from "./transport";

/** What an item does. `run` returns a message to show, or nothing when the view
 *  is about to change under it (a reload). */
interface Item {
  label: string;
  hint?: string;
  run: () => Promise<string | null> | string | null;
}

/** A word's box, and the words it belongs to (the whole text run on screen). */
interface Target {
  page: number;
  /** The words as they are in the page's text layer: what the box is filled with. */
  words: string;
}

const MAX_WORDS = 120;

/** The page this element sits on, as the file's own page number.
 *
 *  src/renderer/components/canvas/PageCell.tsx writes `data-source-page` for it
 *  (the patch in spectra-editor/overlay/renderer.patch): the index of the page in
 *  the document the engine opens, which is what a reorder or a deletion in the
 *  workspace cannot shift out from under a change made here. */
function pageNumberOf(cell: HTMLElement): number {
  const own = Number(cell.dataset.sourcePage);
  if (Number.isInteger(own) && own >= 0) return own + 1;
  const all = [...document.querySelectorAll<HTMLElement>("[data-page-id]")];
  return all.indexOf(cell) + 1;
}

/** The text under (cx, cy), from pdf.js's own text layer: the whole run the word
 *  belongs to when it is short enough to be one edit, otherwise just the word. */
function wordsAt(cx: number, cy: number, span: HTMLElement): string | null {
  const text = (span.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  let word: string | null = null;
  const node = span.firstChild;
  if (node && node.nodeType === Node.TEXT_NODE) {
    let best: { d: number; text: string } | null = null;
    for (const m of (node.textContent ?? "").matchAll(/\S+/g)) {
      const start = m.index ?? 0;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + m[0].length);
      const r = range.getBoundingClientRect();
      const dx = cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0;
      const dy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { d, text: m[0] };
    }
    word = best?.text ?? null;
  }
  if (text.length <= MAX_WORDS) return text;
  return word;
}

/* --------------------------------------------------------------------- ui -- */

const ui = {
  menu: null as HTMLElement | null,
  box: null as HTMLElement | null,
  /** What closes the open menu or box, if anything is open. */
  close: null as (() => void) | null,
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function closeUi(): void {
  const close = ui.close;
  ui.close = null;
  close?.();
}

/** Put a floating panel at (x, y), kept inside the window. */
function place(panel: HTMLElement, x: number, y: number): void {
  panel.style.left = "0px";
  panel.style.top = "0px";
  const box = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

/** A menu of items at the pointer. Escape, an outside press, a scroll or a resize closes it. */
function openMenu(x: number, y: number, items: Item[]): void {
  closeUi();
  const menu = el("div", "autora-menu");
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const button = el("button", "autora-menu-item", item.label);
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (item.hint) button.title = item.hint;
    button.addEventListener("click", () => {
      closeUi();
      const said = item.run();
      void Promise.resolve(said).catch(() => undefined);
    });
    menu.append(button);
    buttons.push(button);
  }
  document.body.append(menu);
  ui.menu = menu;
  place(menu, x, y);

  const first = buttons[0];
  first?.focus();

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeUi();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Tab") return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Tab" && !event.shiftKey && at === buttons.length - 1) return closeUi();
    if (event.key === "Tab" && event.shiftKey && at <= 0) return closeUi();
    event.preventDefault();
    const step = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
    const next = (at + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node)) closeUi();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("scroll", closeUi, true);
  window.addEventListener("resize", closeUi);
  ui.close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("scroll", closeUi, true);
    window.removeEventListener("resize", closeUi);
    menu.remove();
    if (ui.menu === menu) ui.menu = null;
  };
}

/** The little box: the words as they are now, what they should say, and one button. */
function openEditBox(target: Target, x: number, y: number): void {
  closeUi();
  const panel = el("div", "autora-edit");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Edit text");

  const title = el("label", "autora-edit-label", "Edit text");
  const field = el("textarea", "autora-edit-field");
  title.htmlFor = "autora-edit-text";
  field.id = "autora-edit-text";
  field.value = target.words;
  field.rows = Math.min(4, Math.max(1, Math.ceil(target.words.length / 42)));
  field.spellcheck = false;

  const said = el("p", "autora-edit-said");
  said.setAttribute("role", "status");

  const row = el("div", "autora-edit-row");
  const go = el("button", "autora-edit-go", "Replace");
  go.type = "button";
  const cancel = el("button", "autora-edit-cancel", "Cancel");
  cancel.type = "button";
  row.append(cancel, go);

  panel.append(title, field, said, row);
  document.body.append(panel);
  ui.box = panel;
  place(panel, x, y);
  field.focus();
  field.select();

  let busy = false;
  const apply = async () => {
    if (busy) return;
    const words = field.value;
    if (words === target.words) {
      said.textContent = "Those are the same words.";
      return;
    }
    busy = true;
    panel.classList.add("is-busy");
    said.textContent = "Replacing…";
    try {
      await call("autora_edit_text", { page: target.page, find: target.words, with: words });
      said.textContent = "Replaced. The page is reloading with the new words.";
      panel.classList.add("is-done");
      window.setTimeout(closeUi, 600);
    } catch (err) {
      const message = (err as Error)?.message ?? "That could not be done.";
      said.textContent = message;
      panel.classList.remove("is-busy");
      panel.classList.add("is-wrong");
      busy = false;
      field.focus();
      field.select();
    }
  };

  go.addEventListener("click", () => void apply());
  cancel.addEventListener("click", () => closeUi());
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void apply();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeUi();
    }
  });
  const outside = (event: Event) => {
    if (!panel.contains(event.target as Node)) closeUi();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeUi();
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
  ui.close = () => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    panel.remove();
    if (ui.box === panel) ui.box = null;
  };
}

/* ------------------------------------------------------------------ wiring -- */

/** The editor's ✕ on a selected mark, used as the menu's Delete: click the mark
 *  (which selects it, exactly as a person's click does) and then its own ✕. */
function deleteMark(mark: HTMLElement): string | null {
  mark.click();
  const x = mark.querySelector<HTMLElement>(".page-annot-x") ?? mark.closest(".page-annot")?.querySelector<HTMLElement>(".page-annot-x") ?? null;
  if (!x) return "That mark has no delete button of its own — select it and press Delete.";
  x.click();
  return null;
}

/** The text run under (cx, cy) in a page, found by geometry: the rows of the text
 *  layer are drawn with `pointer-events: none` over the raster, so the element the
 *  press lands on is the layer itself, never the word. */
function spanUnder(cell: HTMLElement, cx: number, cy: number): HTMLElement | null {
  const SLACK = 6;
  let best: { span: HTMLElement; area: number; inside: boolean } | null = null;
  for (const span of cell.querySelectorAll<HTMLElement>(".textLayer span:not(.markedContent)")) {
    if (!span.textContent?.trim()) continue;
    const r = span.getBoundingClientRect();
    const inside = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    const near = cx >= r.left - SLACK && cx <= r.right + SLACK && cy >= r.top - SLACK && cy <= r.bottom + SLACK;
    if (!inside && !near) continue;
    const area = r.width * r.height;
    // The word inside the press beats a row merely near it; among equals, the tighter one.
    if (!best || (inside && !best.inside) || (inside === best.inside && area < best.area)) best = { span, area, inside };
  }
  return best?.span ?? null;
}

function itemsFor(event: MouseEvent): { items: Item[]; x: number; y: number } | null {
  const at = event.target as HTMLElement;
  if (!at || !(at instanceof Element)) return null;
  /* Never over the editor's own fields: the keyboard belongs to them. */
  if (at.closest("input, textarea, select, [contenteditable='true'], .autora-menu, .autora-edit")) return null;
  const cell = at.closest<HTMLElement>("[data-page-id]");
  if (!cell) return null;
  const x = event.clientX || 0;
  const y = event.clientY || 0;

  const span = at.closest<HTMLElement>(".textLayer span") ?? spanUnder(cell, x, y);
  const words = span && !span.classList.contains("markedContent") ? wordsAt(x, y, span) : null;
  if (words) {
    const target: Target = { page: pageNumberOf(cell), words };
    return {
      x,
      y,
      items: [
        {
          label: "Edit text",
          hint: "Change these words in the file itself",
          run: () => {
            openEditBox(target, x, y);
            return null;
          },
        },
      ],
    };
  }

  const mark = at.closest<HTMLElement>(".page-annot");
  if (mark) {
    return {
      x,
      y,
      items: [{ label: "Delete", hint: "Remove this mark", run: () => deleteMark(mark) }],
    };
  }
  return null;
}

let installed = false;

/** Listen for right-clicks on the page. Called once, from installHost(). */
export function installEditText(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "contextmenu",
    (event) => {
      /* A right-click that starts or ends a drag or a gesture is not a menu. */
      const found = itemsFor(event);
      if (!found) {
        closeUi();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openMenu(found.x, found.y, found.items);
    },
    true,
  );
}
