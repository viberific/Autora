/**
 * The skill library's one tool (server/skills.ts): find, use, read and write
 * skills in the Agent Skills format. Always offered, like notebooks and the
 * organization: a skill is how work gets done, not a setting. When to use it is
 * in the briefing (SKILLS_GUIDE), so this stays short.
 */

import type { ToolSpec } from "../tools";

export const skillsSPECS: ToolSpec[] = [
  {
    name: "skill",
    group: "files",
    description:
      "The shared skill library (listed in your briefing). use: load a skill's instructions before work it covers. " +
      "read: one of its files. list: search by what the work is. write: create or improve one (the whole new text; " +
      "the old is kept). A new skill is a draft until approved or it has worked three times. No secrets.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["use", "read", "list", "write"] },
        name: { type: "string", description: "lowercase-and-hyphens, at most 64." },
        path: { type: "string", description: "read: a file in its folder." },
        query: { type: "string" },
        description: { type: "string", description: "write: what it does and when to use it (at most 1024); all anyone sees until it is used." },
        body: { type: "string", description: "write: Markdown instructions: when, steps, how to check, gotchas; name files by path." },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "write: path -> text beside SKILL.md (scripts/, references/); empty text removes one.",
        },
        rename: { type: "string", description: "write: its old name, to rename it." },
      },
      required: ["action"],
    },
    risky: true,
  },
];
