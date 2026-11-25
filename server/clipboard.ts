/**
 * The clipboard: text in and out, on this host and on the open web page.
 *
 * Two places, because the need arises in both and neither covers the other. A token on a settings page lives in a disabled
 * input the page will not let you select; a file path lives in the shell. So a copy names its place (`page` or `host`) and
 * a paste does the same, and a paste with no place takes whichever has something in it, page first.
 *
 * The host side keeps its text in a file under /data, not in a real X selection: this container has no display and no
 * xclip, and a file survives a restart, which a selection would not.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HOST_CLIP = process.env.AUTORA_CLIPBOARD_FILE || "/data/settings/clipboard.txt";
const MAX = 200_000;

export type ClipPlace = "page" | "host";

/** What a copy or paste reads back: the text, where it came from, and how much of it there was. */
export interface ClipResult {
  text: string;
  place: ClipPlace;
  chars: number;
  truncated: boolean;
}

function hostRead(): string {
  try {
    return readFileSync(HOST_CLIP, "utf8");
  } catch {
    return "";
  }
}

function hostWrite(text: string): void {
  mkdirSync(dirname(HOST_CLIP), { recursive: true });
  writeFileSync(HOST_CLIP, text, "utf8");
}

/** What is on the host clipboard now, without the page. */
export function hostClipboard(): ClipResult {
  const text = hostRead();
  return { text: text.slice(0, MAX), place: "host", chars: text.length, truncated: text.length > MAX };
}

/**
 * Put text on a clipboard. `place` defaults to the page when one is open, because that is where a copy usually comes
 * from, and to the host when there is no page to hold it.
 */
export function copyText(text: string, place: ClipPlace = "host"): ClipResult {
  const body = text.slice(0, MAX);
  if (place === "host") hostWrite(body);
  return { text: body, place, chars: text.length, truncated: text.length > MAX };
}

/** A short line for the chat: never the whole text when it is long. */
export function describeClip(r: ClipResult, verb: "copied" | "pasted"): string {
  const where = r.place === "page" ? "the page" : "the host clipboard";
  const size = r.chars > 400 ? `${r.chars} characters` : `${r.chars} character${r.chars === 1 ? "" : "s"}`;
  if (verb === "copied") return `Copied ${size} to ${where}.${r.truncated ? " It was longer than the limit and is cut." : ""}`;
  if (!r.chars) return `Nothing on ${where}.`;
  const shown = r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text;
  return `From ${where} (${size}): ${shown}`;
}
