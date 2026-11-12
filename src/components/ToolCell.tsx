import { useState } from "react";
import type { SpanState } from "../lib/derive";
import { thoughtForTool } from "../lib/thought";
import { IconChevron } from "./Icons";

/**
 * Everything else the agent did, one line each.
 *
 * A memory lookup or a file read does not deserve a card, but it does deserve
 * to be in the record: the transcript is the record now, and a transcript with
 * holes in it is the thing the old hidden timeline was rightly criticised for.
 */
export function ToolCell({ span }: { span: SpanState }) {
  const [open, setOpen] = useState(false);
  const detail = span.output || span.preview;
  const tone = span.status === "error" ? "is-bad"
    : span.status === "denied" && !span.held ? "is-warn" : "";

  return (
    <div className={`cell-line ${tone} ${open ? "is-open" : ""}`}>
      <button
        className="cell-line-top"
        onClick={() => detail && setOpen((v) => !v)}
        aria-expanded={detail ? open : undefined}
      >
        {detail ? <IconChevron size={10} /> : <span className="cell-line-dot" />}
        <b>{span.name}</b>
        <span className="cell-line-text">{stepWords(span.name, span.args)}</span>
        {span.status === "running" && <em className="cell-chip is-running">running</em>}
        {span.status === "denied" && <em className={`cell-chip ${span.held ? "" : "is-warn"}`.trim()}>{heldWords(span.held)}</em>}
        {span.status === "error" && <em className="cell-chip is-bad">failed</em>}
      </button>
      {open && detail && <pre className="cell-line-body">{detail.slice(0, 8000)}</pre>}
    </div>
  );
}

/** Why a step was not run, where that is the app's own rule working and not a failure. */
export function heldWords(held: SpanState["held"]): string {
  return held === "planning" ? "planning first" : held === "theirs" ? "yours to write" : held === "busy" ? "waited for you" : "declined";
}

/** The part of a call a person would recognise as what it was about: a command, a file, a search, a page. */
function natural(args: Record<string, any>): string | null {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return args.query;
  if (typeof args.url === "string") return args.url;
  if (typeof args.action === "string" && (args.command || args.dir || args.url)) {
    return `${args.action} ${args.command ?? args.dir ?? args.url}`;
  }
  if (typeof args.action === "string") {
    return `${args.action} ${args.selector ?? args.url ?? args.text ?? ""}`.trim();
  }
  if (Array.isArray(args.todos)) return `${args.todos.length} item${args.todos.length === 1 ? "" : "s"}`;
  // The to-do list ticked off by position (todo's `done` / `start`): said as what happened to the list.
  if (Array.isArray(args.done) && Object.keys(args).every((k) => k === "done" || k === "start")) {
    return `ticked ${args.done.length} task${args.done.length === 1 ? "" : "s"}`;
  }
  if (typeof args.to === "string" && Object.keys(args).every((k) => k === "to" || k === "reason")) {
    return `switch to ${args.to}`;
  }
  return null;
}

/** A call as one line of its arguments: for the record a person opens, where the exact call is what they came for. */
export function describeArgs(args: Record<string, any>): string {
  return natural(args) ?? Object.entries(args)
    .map(([k, v]) => `${k}=${shortValue(v)}`)
    .join(" ");
}

/**
 * A step in a few words, for the line a person reads without opening anything: what it was about when the call has such
 * a thing (a command, a file, a page), else what the agent was doing ("Putting work on the canvas"). Never the call's
 * arguments as `key=value`: those are plumbing, and are one tap away in the opened step.
 */
export function stepWords(name: string, args: Record<string, any>): string {
  return thoughtForTool(name, args) ?? natural(args) ?? sentence(name);
}

const sentence = (name: string) => { const words = name.replace(/_/g, " "); return words.charAt(0).toUpperCase() + words.slice(1); };

/** A value as one short piece of text: a string as it is, anything else as
    JSON -- String() of a list of objects is "[object Object]". */
function shortValue(value: unknown): string {
  // A list reads as how many, not as the first thirty characters of its JSON.
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
