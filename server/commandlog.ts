/**
 * The command log of a hosted editor whose document is a file (Sheets first): every change is a command with who made it, a
 * line saying what, and the version the document had just before it, so "go back to before this" is one restore. The
 * template is 3D's log (`caddesk.ts`); here the kernel stays the editor's own and the log is an adapter over the desk's
 * versions (docs/ENGINE-SURVEY.md, "adapter, not rewrite").
 *
 * Authority: Sheets is productivity work, so there is no command that is the person's alone; the agent may apply and revert
 * any of them. `who` says who did it.
 */

export type OfficeCommand = {
  n: number;
  who: "agent" | "person";
  name: "open" | "agent_edit" | "person_edit" | "revert";
  /** What it did, in a colleague's words. */
  summary: string;
  at: number;
  /** The desk's revision the command left the document at. */
  rev: number;
  /** The version the document was at just before it (the desk keeps it), or null when it began the document. */
  before: number | null;
};

export const MAX_COMMANDS = 200;
const SUMMARY_MAX = 400;

const clip = (s: string) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);

/** Add a command to the log (newest last), numbering it from `seq`. */
export function addCommand(log: OfficeCommand[], seq: number, cmd: Omit<OfficeCommand, "n" | "summary"> & { summary: string }): OfficeCommand {
  const entry: OfficeCommand = { ...cmd, n: seq, summary: clip(cmd.summary) };
  log.push(entry);
  while (log.length > MAX_COMMANDS) log.shift();
  return entry;
}

/**
 * The person's typing arrives as saves a few seconds apart: while nothing else has happened since (the document is still
 * dirty from them), those saves are one command, whose account is then redone from where it began.
 */
export function openPersonRun(log: OfficeCommand[], dirty: boolean): OfficeCommand | null {
  const last = log[log.length - 1];
  return dirty && last && last.who === "person" && last.name === "person_edit" ? last : null;
}

/** The log as the agent reads it: since a revision, newest last. */
export function logText(log: OfficeCommand[], sinceRev = 0): string {
  const shown = log.filter((c) => c.rev > sinceRev);
  if (shown.length === 0) return sinceRev > 0 ? `Nothing has changed in the workbook since revision ${sinceRev}.` : "The workbook has no changes logged yet.";
  const lines = shown.slice(-40).map((c) => `#${c.n} ${c.who === "agent" ? "you" : "the person"} (${c.name}, revision ${c.rev}): ${c.summary}`);
  const more = shown.length - lines.length;
  return `${more > 0 ? `(${more} earlier not shown)\n` : ""}${lines.join("\n")}\nrevert with the number of the first command to take back: the workbook goes back to just before it.`;
}
