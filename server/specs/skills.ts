/**
 * The skill library's one tool (server/skills.ts): find, use, read and write
 * skills in the Agent Skills format. Always offered, like notebooks and the
 * organization: a skill is how work gets done, not a setting.
 */

import type { ToolSpec } from "../tools";

export const skillsSPECS: ToolSpec[] = [
  {
    name: "skill",
    group: "files",
    description:
      "The skill library, shared by you and every agent: ways of doing a kind of work, each a folder with a SKILL.md " +
      "(front matter name and description, then instructions) and any scripts, templates or references beside it. " +
      "The skills there are listed by name and description in your briefing. Actions: use (name: load a skill's " +
      "instructions -- do this BEFORE starting work its description covers, and follow them); read (name, path: one " +
      "of its files, e.g. references/api.md or scripts/run.sh); list (query: search skills by what they are for, " +
      "when the briefing names only some); write (name, description, body, and optionally files: create a skill, or " +
      "improve one -- the whole new text, which replaces the old, which is kept as a version). Write a skill when you " +
      "have worked out a method you would want next time and it is more than a note: when to use it, the steps, how to " +
      "check the result, the gotchas, and any script that does the mechanical part. A skill you write is a draft until " +
      "the person approves it or it has worked three times. When a skill proved wrong or incomplete, fix it with write " +
      "rather than writing another. No secrets: name where a key is kept, never the key.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["use", "read", "list", "write"] },
        name: {
          type: "string",
          description: "The skill's name: lowercase letters, digits and hyphens, at most 64 (e.g. invoice-from-timesheet).",
        },
        path: { type: "string", description: "read: a file in the skill's folder, relative to it." },
        query: { type: "string", description: "list: a few words about the work." },
        description: {
          type: "string",
          description:
            "write: what the skill does and when to use it, in the words someone asking for that work would use; at most 1024 characters. " +
            "This is all you will see of it until you use it, so make it say when it applies.",
        },
        body: {
          type: "string",
          description:
            "write: the instructions, in Markdown: when to use it, numbered steps, how to check it worked, gotchas. " +
            "Point to files by path (\"run scripts/build.sh\", \"read references/fields.md for the field list\").",
        },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "write: files beside SKILL.md, path -> text (an empty text removes that file): scripts/, references/, assets/.",
        },
        rename: { type: "string", description: "write: the skill's old name, when this write gives it a new one." },
      },
      required: ["action"],
    },
    risky: true,
  },
];
