/**
 * The clipboard's tools: text in and out, on the page and on the host.
 *
 * Small on purpose. The two places are named rather than guessed, because a copy that lands in the wrong one is silent,
 * and a paste that reads the wrong one is worse. A paste with no place takes the page if it has something, then the host.
 */
import type { ToolSpec } from "../tools";

export const CLIPBOARD_TOOLS: ToolSpec[] = [
  {
    name: "clipboard_copy",
    group: "files",
    description:
      "Put text on a clipboard so it can be pasted later, in a field or in a shell. `place` is `page` (the open web page, " +
      "which is what a person's Ctrl+V would paste) or `host` (this machine). Defaults to the page when one is open. " +
      "Use it instead of retyping something long, and for text you cannot select -- a disabled field, a token, a code.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to copy." },
        place: { type: "string", enum: ["page", "host"], description: "Where to put it. Optional." },
      },
      required: ["text"],
    },
  },
  {
    name: "clipboard_paste",
    group: "files",
    description:
      "Read a clipboard back: the page's, or the host's. With no `place`, whichever has something in it, the page first. " +
      "Returns the text (cut at 200,000 characters) and says where it came from.",
    parameters: {
      type: "object",
      properties: { place: { type: "string", enum: ["page", "host"], description: "Where to read from. Optional." } },
    },
  },
];
