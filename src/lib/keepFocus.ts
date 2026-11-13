/**
 * The person's place is theirs (R17). While an agent's hand works in an editor's frame, the editor focuses its own
 * fields to type, and the browser moves the keyboard into the frame with them: the person, typing in the chat, would
 * find their cursor gone and their next keys landing in the cell the agent is filling. The hand needs that focus while
 * it works (a cell editor that loses it closes, and its typing goes nowhere), so it keeps it until it is done; then the
 * person's field gets the keyboard back with its caret and selection where they were. The keys they press meanwhile are
 * not the editor's: a frame that can tell (office/shim/hand.js, "stray-key") sends them back, and they are typed into
 * the person's field as if it had never lost the keyboard.
 */

type Field = HTMLTextAreaElement | HTMLInputElement;

export interface HeldFocus {
  /** A key the person pressed while the frame had the keyboard: a character, or "Backspace". */
  type(key: string): void;
  /** The hand is done: the person's field has the keyboard again, unless they have deliberately gone somewhere else. */
  release(): void;
}

const NONE: HeldFocus = { type() {}, release() {} };

const isField = (el: Element | null): el is Field =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|tel|password|)$/.test(el.type));

/** Hold the person's place while a hand works in `frame`. Nothing to hold (they were not in a text field) holds nothing. */
export function holdFocus(frame: HTMLIFrameElement | null | undefined): HeldFocus {
  const field = document.activeElement;
  if (!isField(field) || field.disabled || field.readOnly) return NONE;
  let start = field.selectionStart ?? field.value.length;
  let end = field.selectionEnd ?? start;
  let direction = field.selectionDirection ?? "none";
  // The person may go on typing until the frame takes the keyboard: where the caret was is read as the field loses it.
  const lost = () => {
    start = field.selectionStart ?? start;
    end = field.selectionEnd ?? end;
    direction = field.selectionDirection ?? direction;
  };
  field.addEventListener("blur", lost);
  // Typed into the field as the person would: the value set where the caret was, and the input event React listens for.
  const put = (text: string, from: number, to: number) => {
    field.setRangeText(text, from, to, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    start = end = from + text.length;
  };
  return {
    type(key) {
      if (!field.isConnected) return;
      if (key === "Backspace") {
        if (start !== end) put("", start, end);
        else if (start > 0) put("", start - 1, start);
      } else if (Array.from(key).length === 1) {
        put(key, start, end);
      }
      if (document.activeElement === field) field.setSelectionRange(start, end);
    },
    release() {
      field.removeEventListener("blur", lost);
      if (!field.isConnected || field.disabled) return;
      const now = document.activeElement;
      // Only taken back from the frame the hand worked in (or from nowhere): a place the person chose since stays chosen.
      if (now !== field && now !== frame && now !== document.body && now !== null) return;
      if (now !== field) field.focus({ preventScroll: true });
      try { field.setSelectionRange(start, end, start === end ? "none" : direction); } catch { /* a field type with no caret */ }
    },
  };
}
