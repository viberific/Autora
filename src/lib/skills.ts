/** The skill library as the client sees it: see server/skills.ts and server/routes/skills.ts. */

export type SkillAuthor = { kind: "person" } | { kind: "agent"; id: string; name: string };

export type SkillInfo = {
  name: string;
  description: string;
  status: "live" | "draft";
  author: SkillAuthor;
  created: number;
  updated: number;
  uses: number;
  worked: number;
  failed: number;
  files: string[];
  versions: number;
};

export type Skill = SkillInfo & { text: string; body: string };
export type SkillVersion = { at: number; by: string; text: string };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status}).`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const fetchSkills = () => call<{ skills: SkillInfo[] }>("/api/skills").then((d) => d.skills);
export const fetchSkill = (name: string) =>
  call<{ skill: Skill; versions: SkillVersion[] }>(`/api/skills/${encodeURIComponent(name)}`);
export const fetchSkillFile = (name: string, path: string) =>
  call<{ text: string }>(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`).then((d) => d.text);
export const checkSkill = (text: string) =>
  call<{ ok: true; name: string; description: string } | { ok: false; error: string }>("/api/skills-check", json("POST", { text }));
export const createSkill = (text: string) => call<{ info: SkillInfo }>("/api/skills", json("POST", { text }));
export const saveSkill = (name: string, text: string) =>
  call<{ info: SkillInfo }>(`/api/skills/${encodeURIComponent(name)}`, json("PUT", { text }));
export const approveSkill = (name: string) => call<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(name)}/approve`, { method: "POST" });
export const revertSkill = (name: string, index: number) =>
  call<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(name)}/revert`, json("POST", { index }));
export const deleteSkill = (name: string) => call<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
export const exportUrl = (name: string) => `/api/skills/${encodeURIComponent(name)}/export`;
export const importSkills = (file: Blob) =>
  call<{ imported: SkillInfo[]; skipped: { where: string; error: string }[] }>("/api/skills-import", {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: file,
  });

/** What a new skill starts as: the format's shape, with what each part is for. */
export const SKILL_TEMPLATE = `---
name: my-new-skill
description: What this does, and when to use it -- in the words someone would use asking for this work.
---

# My new skill

## When to use it

## Steps

1.

## Check the result

## Gotchas
`;

export const authorLabel = (a: SkillAuthor) => (a.kind === "person" ? "you" : a.name);
