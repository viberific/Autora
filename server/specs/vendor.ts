/**
 * Handing work to a subscription CLI, in the open.
 *
 * Two tools, one per vendor, because which vendor was asked is the whole point
 * of the feature: the person wants to see when the console is talking to Claude
 * or Gemini and when it is doing the work itself. What actually happens -- the
 * wrapper, the JSON Lines contract, the redaction -- is server/vendor.ts.
 *
 * Grouped with `terminal`, deliberately and not by accident: these run a
 * process on this host, spend the person's quota, and can write files, so if
 * Terminal is off they must be off too rather than being a way round it.
 */

import type { ToolSpec } from "../tools";

export const vendorSPECS: ToolSpec[] = [
  {
    name: "claude_cli",
    group: "terminal",
    /* It spends the person's subscription quota, and with write it changes
       files: under "ask only for the risky ones" this must be one of them. */
    risky: true,
    description:
      "Hand a job to Claude Code, the subscription CLI signed in on this host, and have the answer " +
      "land in this conversation as Claude's own bubble -- its name, its mark, its words as they " +
      "arrive. Use it when the person asks for Claude specifically, or when a second pair of hands " +
      "is worth it: a long refactor, a review of a file, a question where Claude's judgement is wanted. " +
      "It runs on the person's own Claude subscription, so it costs no API money but does use his quota. " +
      "Read-only unless you set write. If it fails (signed out, rate limited, timed out, not " +
      "installed) its bubble says which, in words the person can act on -- that is not the end of the " +
      "job: do the work yourself, or retry with an API model through http_request, rather than " +
      "repeating the same call. Never put a token, key or sign-in detail in the prompt.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to ask it. Complete in itself: it has not seen this chat." },
        cwd: { type: "string", description: "The folder it works in. Default: this chat's working folder." },
        write: { type: "boolean", description: "Let it edit files and run commands in cwd. Default false: it only reads." },
        timeout: { type: "string", description: "Its own time limit, e.g. 10m. Default 10m." },
        model: { type: "string", description: "Its model, where the wrapper takes one." },
        effort: { type: "string", description: "low, medium, high, xhigh or max, where the wrapper takes one." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "gemini_cli",
    group: "terminal",
    risky: true,
    description:
      "Hand a job to Gemini through the Antigravity CLI signed in on this host, and have the answer " +
      "land in this conversation as Gemini's own bubble -- its name, its four-point mark, its words " +
      "as they arrive. Use it when the person asks for Gemini specifically, or for what Gemini is " +
      "good at: long documents, a design or UI critique, bulk text, a second opinion on a plan. It " +
      "runs on the person's Google AI Plus quota, so it costs no API money but does use his quota. " +
      "Read-only unless you set write. If it fails (signed out, rate limited, timed out, not " +
      "installed) its bubble says which, in words the person can act on -- do the work yourself, or " +
      "retry with an API model, rather than repeating the same call. Never put a token, key or " +
      "sign-in detail in the prompt.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to ask it. Complete in itself: it has not seen this chat." },
        cwd: { type: "string", description: "The folder it works in. Default this chat's working folder, or a scratch folder it may write in." },
        write: { type: "boolean", description: "Let it edit files and run commands in cwd. Default false: it only reads." },
        timeout: { type: "string", description: "Its own time limit, e.g. 10m. Default 10m." },
        model: { type: "string", description: "Its model, e.g. gemini-3.8-flash-high." },
        effort: { type: "string", description: "low, medium, high, xhigh or max." },
      },
      required: ["prompt"],
    },
  },
];
