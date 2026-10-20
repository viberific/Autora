/**
 * The Skills page's routes: the library (server/skills.ts) to read, write,
 * approve, roll back, import and export. A skill written here is the person's
 * and live at once; one an agent wrote waits here as a draft.
 */

import express, { type Express, type Request, type Response } from "express";
import {
  SkillError, approveSkill, deleteSkill, exportSkill, exportSkills, getSkill, importSkills, listSkills, parseSkillMd,
  readSkillFile, revertSkill, skillVersions, writeSkill, writeSkillFile,
} from "../skills";

const failed = (res: Response, err: unknown) => {
  if (err instanceof SkillError) return res.status(400).json({ error: err.message });
  return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};

/** Files sent as path -> text, an empty text or null removing one. */
function filesOf(raw: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [p, v] of Object.entries(raw as Record<string, unknown>)) out[p] = v === null || v === "" ? null : String(v);
  return out;
}

export function skillRoutes(app: Express) {
  app.get("/api/skills", (_req: Request, res: Response) => {
    res.json({ skills: listSkills() });
  });

  app.get("/api/skills/:name", (req: Request, res: Response) => {
    const s = getSkill(req.params.name);
    if (!s) return res.status(404).json({ error: "No such skill." });
    const { dir: _dir, ...rest } = s;
    res.json({
      skill: rest,
      versions: skillVersions(s.name).map((v) => ({ at: v.at, by: v.by, text: v.text, files: v.files })),
    });
  });

  app.get("/api/skills/:name/file", (req: Request, res: Response) => {
    const got = readSkillFile(req.params.name, String(req.query.path ?? ""), 200_000);
    if (!got.ok) return res.status(404).json({ error: got.error });
    res.json({ text: got.text });
  });

  /** Is this SKILL.md valid, and why not: the editor asks as the person types. */
  app.post("/api/skills-check", (req: Request, res: Response) => {
    const parsed = parseSkillMd(String(req.body?.text ?? ""));
    res.json(parsed.ok ? { ok: true, name: parsed.name, description: parsed.description } : { ok: false, error: parsed.error });
  });

  app.post("/api/skills", (req: Request, res: Response) => {
    try {
      const text = String(req.body?.text ?? "");
      const parsed = parseSkillMd(text);
      if (parsed.ok && getSkill(parsed.name)) return res.status(409).json({ error: `There is already a skill called "${parsed.name}".` });
      res.json(writeSkill(text, { kind: "person" }, filesOf(req.body?.files)));
    } catch (err) {
      failed(res, err);
    }
  });

  /** A changed SKILL.md (and files). A different name in it renames the skill. */
  app.put("/api/skills/:name", (req: Request, res: Response) => {
    try {
      if (!getSkill(req.params.name)) return res.status(404).json({ error: "No such skill." });
      res.json(writeSkill(String(req.body?.text ?? ""), { kind: "person" }, filesOf(req.body?.files), { rename: req.params.name }));
    } catch (err) {
      failed(res, err);
    }
  });

  /** One file beside SKILL.md, written or removed on its own: the scripts are the person's to edit. */
  app.put("/api/skills/:name/files", (req: Request, res: Response) => {
    try {
      const rel = String(req.body?.path ?? "");
      /* Only null removes a file: an empty text is an empty file, which is what "New file" sends. */
      const text = req.body?.text === null ? null : String(req.body?.text ?? "");
      const info = writeSkillFile(req.params.name, rel, text, { kind: "person" });
      res.json({ skill: info, versions: skillVersions(info.name).map((v) => ({ at: v.at, by: v.by, text: v.text, files: v.files })) });
    } catch (err) {
      failed(res, err);
    }
  });

  app.post("/api/skills/:name/approve", (req: Request, res: Response) => {
    try { res.json({ skill: approveSkill(req.params.name) }); } catch (err) { failed(res, err); }
  });

  app.post("/api/skills/:name/revert", (req: Request, res: Response) => {
    try { res.json({ skill: revertSkill(req.params.name, Number(req.body?.index) || 0) }); } catch (err) { failed(res, err); }
  });

  app.delete("/api/skills/:name", (req: Request, res: Response) => {
    res.status(deleteSkill(req.params.name) ? 200 : 404).json({ ok: true });
  });

  app.get("/api/skills/:name/export", (req: Request, res: Response) => {
    try {
      const zip = exportSkill(req.params.name);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}.zip"`);
      res.send(Buffer.from(zip));
    } catch (err) {
      failed(res, err);
    }
  });

  /** Every skill in one zip, each in its own folder. */
  app.get("/api/skills-export", (_req: Request, res: Response) => {
    try {
      const { zip, count } = exportSkills();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="autora-skills-${count}.zip"`);
      res.send(Buffer.from(zip));
    } catch (err) {
      failed(res, err);
    }
  });

  /** A .zip of one or more skill folders, sent as the body itself. */
  app.post("/api/skills-import", express.raw({ type: "*/*", limit: "25mb" }), (req: Request, res: Response) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new SkillError("Send a .zip of a skill folder.");
      res.json(importSkills(new Uint8Array(req.body)));
    } catch (err) {
      failed(res, err);
    }
  });
}
