/**
 * A saved file, loaded into an app's window -- the person's own way in from Artifacts.
 *
 * Every app's bar has Save, which keeps what is in the window in Artifacts. This is its other half: Load picks a file
 * from Artifacts and puts it in the window beside the chat, with no message and no turn. The agent finds out the way it
 * finds out about anything the person does in a window (the window's news, said with its next result).
 *
 * Each app takes what it can use: Pages, Sheets and Slides their own kind of document, PDF a PDF, Photo a picture (or a
 * PSD), Video media for the project's library (a video, a sound or a picture), Music a song it kept, 3D a model it kept,
 * Games a game it kept or a file for the game's resources (a picture, a sound, a font). The same engines the agent's
 * tools use do the work, so a file loaded here is in the window exactly as one the agent opened would be.
 */
import type { Express, Request, Response } from "express";
import { getArtifact, readArtifact, saveArtifact, type Artifact } from "./artifacts";
import { cadState, loadModel } from "./caddesk";
import { gameState, loadGame, runGameTool } from "./gamedesk";
import { officeHooks } from "./officedesk";
import { runOfficeTool } from "./office";
import { runVideoTool } from "./opencut";
import { deskHooks, deskState } from "./pdfdesk";
import { photoState, runPhotoTool } from "./photodesk";
import { loadSong, studioState } from "./studio";
import { loadIntoPanacea, panaceaState } from "./panacea";
import { panaceaFileRoute, type PanaceaFileRoute, type PanaceaEngineName } from "./panacea-formats";
import { normalizeCanvas } from "../src/lib/panacea/canvas";
import { flushStore, readDoc } from "./store";
import { terminalDir } from "./tools";
import { LOAD_APPS, loadable, type LoadApp } from "../src/lib/loadable";


const NAME: Record<LoadApp, string> = {
  pdf: "Autora PDF", pages: "Autora Pages", sheets: "Autora Sheets", slides: "Autora Slides", photo: "Autora Photo",
  video: "Autora Video", studio: "Autora Music", cad: "Autora 3D", game: "Autora Games", panacea: "Panacea",
};

export type FileLoadResult = {
  ok: boolean; error?: string; said?: string; status?: number; replaceRequired?: boolean;
  kind?: "engine" | "canvas"; engine?: PanaceaEngineName; artifact?: string; name?: string;
};
type Done = FileLoadResult;
export type WorkspaceFileOptions = { engine?: PanaceaEngineName; native?: boolean; replace?: boolean };
export type FileLoadGuards = {
  exists: (id: string) => boolean;
  incognito: (id: string) => boolean;
  off: (app: LoadApp) => boolean;
};

async function load(session: string, app: LoadApp, art: Artifact, route?: PanaceaFileRoute): Promise<Done> {
  const data = readArtifact(art.id);
  if (!data) return { ok: false, error: "That file is no longer there." };
  const quiet = { cwd: terminalDir() };
  const origin = {
    working: art.origin === "agent" ? art.id : null,
    source: art.origin === "user" ? art.id : null,
  };
  switch (app) {
    case "pdf": {
      // A PDF that wants a password nobody has given is not opened here: the window could not show it.
      const { PDFDocument } = await import("@cantoo/pdf-lib");
      try {
        await PDFDocument.load(data);
      } catch (err) {
        return { ok: false, error: /encrypt|password/i.test(String((err as Error)?.message)) ? "That PDF is password-protected. Ask Autora to open it with the password." : "That is not a PDF Autora PDF can read." };
      }
      deskHooks(session).open({ name: art.name, base: data, items: [], ...origin, outName: art.name });
      return { ok: true, said: `${art.name} is open in Autora PDF.` };
    }
    case "pages": case "sheets": case "slides": {
      const win = officeHooks(session);
      // What was just typed in the document that is open reaches its file before another opens over it.
      await win.settle();
      if (route?.status === "engine" && route.tool === "office_convert") {
        let converted: Artifact | null = null;
        const alias = /\.htm$/i.test(art.name) ? art.name.replace(/\.htm$/i, ".html")
          : /\.markdown$/i.test(art.name) ? art.name.replace(/\.markdown$/i, ".md") : null;
        const source = alias ? saveArtifact({ origin: "user", session, name: alias, data, note: `Conversion source for ${art.name}` }) : art;
        const out = await runOfficeTool("office_convert", {
          ...route.args, file: source.id, output: `${art.name.replace(/\.[^.]+$/, "")}-${art.id}.${route.args.to}`,
        }, {
          session, cwd: terminalDir(), room: 2000, cancelled: () => false, onCancel: () => undefined,
          putBlob: () => { throw new Error("A file conversion cannot request an image."); },
          showImage: () => undefined,
          showFile: (file) => { converted = getArtifact(file.id); },
        });
        if (!out.ok || !converted) return { ok: false, error: out.summary };
        return load(session, app, converted, { status: "engine", engine: app, tool: "office_open", args: { file: art.id } });
      }
      // Do not accept a ZIP-shaped impostor as a document, even when the native editor is unavailable.
      const { unzipSync, strFromU8 } = await import("fflate");
      try {
        const part = app === "pages" ? "word/document.xml" : app === "sheets" ? "xl/workbook.xml" : "ppt/presentation.xml";
        const zip = unzipSync(data, { filter: (file) => (file.name === part || file.name === "[Content_Types].xml") && file.originalSize <= 50 * 1024 * 1024 });
        if (!zip["[Content_Types].xml"] || !zip[part] || !/<(?:\w+:)?(?:document|workbook|presentation)\b/.test(strFromU8(zip[part]))) {
          return { ok: false, error: `That is not a ${NAME[app]} file.` };
        }
      } catch { return { ok: false, error: `That is not a ${NAME[app]} file.` }; }
      const previous = win.at(app === "pages" ? "docx" : app === "sheets" ? "xlsx" : "pptx");
      if (route && previous) {
        // Opening a different Office file discards its engine versions. Keep the settled bytes first.
        saveArtifact({ origin: "user", session, name: previous.name, data: previous.data, note: "Preserved before loading another file" });
      }
      win.open({ name: art.name, data, ...origin, outName: art.name, label: "Opened by you" });
      return { ok: true, said: `${art.name} is open in ${NAME[app]}.` };
    }
    case "photo": {
      const out = await runPhotoTool(session, "photo_open", { file: art.id }, quiet);
      return out.ok ? { ok: true, said: `${art.name} is open in Autora Photo.` } : { ok: false, error: out.summary };
    }
    case "video": {
      const ctx = { session, cwd: terminalDir(), cancelled: () => false };
      const opened = await runVideoTool("video_open", {}, ctx);
      if (!opened.ok) return { ok: false, error: opened.summary };
      const out = await runVideoTool("video_import", { file: art.id }, ctx);
      return out.ok ? { ok: true, said: `${art.name} is in the video project's media.` } : { ok: false, error: out.summary };
    }
    case "studio": {
      const out = loadSong(session, data);
      return out.ok ? { ok: true, said: `${out.name ?? art.name} is open in Autora Music.` } : { ok: false, error: out.error };
    }
    case "cad": {
      const out = await loadModel(session, data);
      return out.ok ? { ok: true, said: `${art.name} is open in Autora 3D (${out.shapes ?? 0} shape${out.shapes === 1 ? "" : "s"}).` } : { ok: false, error: out.error };
    }
    case "panacea": {
      if (route?.status === "native" && route.kind === "canvas" && occupied(session, "panacea")) {
        flushStore();
        const saved = readDoc<{ canvas: unknown }>(`panacea-${session}`);
        const previous = normalizeCanvas(saved?.canvas);
        if (previous) saveArtifact({ origin: "user", session, name: `${previous.name}.panacea.json`,
          data: Buffer.from(JSON.stringify(previous)), note: "Preserved before loading another canvas" });
      }
      const out = loadIntoPanacea(session, art, data);
      return out.ok ? { ok: true, said: out.said } : { ok: false, error: out.error };
    }
    case "game": {
      if (route?.status === "loader") {
        const kept = loadGame(session, data);
        return kept.ok ? { ok: true, said: `${art.name} is open in Autora Games.` } : kept;
      }
      // A game that was kept replaces the game; any other file (JSON that is not a game too) is added to the game's resources.
      if (/\.json$/i.test(art.name) || art.mime === "application/json") {
        const kept = loadGame(session, data);
        if (kept.ok) return { ok: true, said: `${art.name} is open in Autora Games.` };
      }
      const out = await runGameTool(session, "game_import", { file: art.id }, quiet);
      return out.ok ? { ok: true, said: `${art.name} was added to the game's resources.` } : { ok: false, error: out.summary };
    }
  }
}

function occupied(session: string, target: LoadApp): boolean {
        switch (target) {
          case "panacea": { const state = panaceaState(session); return Boolean(state.surfaces || state.panels); }
          case "pages": case "sheets": case "slides": return Boolean(officeHooks(session).at(target === "pages" ? "docx" : target === "sheets" ? "xlsx" : "pptx"));
          case "pdf": return Boolean(deskState(session).name);
          case "photo": return photoState(session).open;
          case "studio": return studioState(session).open;
          case "cad": return cadState(session).open;
          case "game": return gameState(session).open;
          // Media is added to the existing library, never replaces its project.
          case "video": return false;
        }
      }

      /** Shared person-only load service for a raw drop and an existing Artifact. Never runs a model turn. */
      export async function loadPanaceaFile(
        session: string, art: Artifact, options: WorkspaceFileOptions, guards: FileLoadGuards,
        loader: typeof load = load,
      ): Promise<FileLoadResult> {
        if (!guards.exists(session)) return { ok: false, status: 404, error: "There is no such chat." };
        if (guards.incognito(session)) return { ok: false, status: 403, error: "An incognito chat has no workspace." };
        if (guards.off("panacea")) return { ok: false, status: 403, error: "Panacea is switched off on the Tools page." };
        const data = readArtifact(art.id);
        if (!data) return { ok: false, status: 404, error: "That file is no longer there." };
        if (!data.length) return { ok: false, status: 400, error: "That file is empty." };
        let json: unknown;
        if (/\.json$/i.test(art.name)) {
          try { json = JSON.parse(data.toString("utf8")); }
          catch { return { ok: false, status: 400, error: "That file is not valid JSON." }; }
        }
        const route = panaceaFileRoute({ file: art.id, name: art.name, engine: options.engine, native: options.native, json });
        if (route.status === "unsupported") return { ok: false, status: 415, error: `Panacea cannot open ${art.name} (${route.reason}).` };
        const target = route.status === "native" ? "panacea" : route.engine;
        if (guards.off(target)) return { ok: false, status: 403, error: `${NAME[target]} is switched off or unavailable on this server.` };
        const canvas = route.status === "native" && route.kind === "canvas";
        if (canvas && !normalizeCanvas(json)) return { ok: false, status: 400, error: "That file has no Panacea canvas in it." };
        if (route.status === "native" && route.kind === "image") {
          if (!validPanaceaImage(data)) return { ok: false, status: 400, error: "That is not an image Panacea can read." };
        }
        if ((canvas || target !== "panacea") && occupied(session, target) && options.replace !== true) {
          return { ok: false, status: 409, replaceRequired: true, ...(target !== "panacea" ? { engine: target } : {}),
            error: `There is already work in ${NAME[target]}. Confirm replacement before loading this file.` };
        }
        try {
          const out = await loader(session, target, art, route);
          if (!out.ok) return { ...out, status: out.status ?? 400 };
          return { ...out, ...(target !== "panacea" ? { kind: "engine", engine: target } : canvas ? { kind: "canvas" } : {}),
            artifact: art.id, name: art.name };
        } catch (err) {
          return { ok: false, status: 503, error: err instanceof Error ? err.message : String(err) };
        }
      }

/** Refuse incomplete native picture structures; pixel decoding also belongs to the window. */
export function validPanaceaImage(data: Buffer): boolean {
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR"
      || !data.readUInt32BE(16) || !data.readUInt32BE(20)) return false;
    const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[data[25]!]?.includes(data[24]!)
      || data[26] !== 0 || data[27] !== 0 || (data[28] !== 0 && data[28] !== 1)) return false;
    let at = 8;
    let pixels = false;
    while (at + 12 <= data.length) {
      const size = data.readUInt32BE(at);
      if (size > data.length - at - 12) return false;
      const kind = data.toString("ascii", at + 4, at + 8);
      if (kind === "IHDR" && at !== 8) return false;
      if (kind === "IDAT" && size) pixels = true;
      if (kind === "IEND") return pixels && size === 0 && at + 12 === data.length;
      at += size + 12;
    }
    return false;
  }
  if (data.length >= 14 && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) {
    return data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0 && data[data.length - 1] === 0x3b;
  }
  if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    return data.readUInt32LE(4) + 8 === data.length && /^(VP8 |VP8L|VP8X)$/.test(data.toString("ascii", 12, 16));
  }
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) {
    return data.includes(Buffer.from([0xff, 0xda])) && (data.includes(Buffer.from([0xff, 0xc0])) || data.includes(Buffer.from([0xff, 0xc2])));
  }
  return false;
}

/**
 * POST /api/sessions/:session/load -- { app, artifact } puts that file in the app's window beside this chat.
 *
 * Refused where there is no window to open: an incognito chat has none, and an app switched off on the Tools page is
 * not opened from here either.
 */
export function loadFileRoutes(app: Express, opts: FileLoadGuards): void {
  app.post("/api/sessions/:session/load", async (req: Request, res: Response) => {
    const session = String(req.params.session);
    if (!opts.exists(session)) return res.status(404).json({ error: "There is no such chat." });
    const which = String((req.body ?? {}).app ?? "") as LoadApp;
    if (!LOAD_APPS.includes(which)) return res.status(400).json({ error: "That is not an app that loads files." });
    const art = getArtifact(String((req.body ?? {}).artifact ?? ""));
    if (!art) return res.status(404).json({ error: "That file is no longer in Artifacts." });
    if (opts.incognito(session)) return res.status(403).json({ error: `An incognito chat has no window, so ${NAME[which]} cannot be opened in it.` });
    if (opts.off(which)) return res.status(403).json({ error: `${NAME[which]} is switched off on the Tools page.` });
    if (which === "panacea") {
      const body = req.body as Record<string, unknown>;
      if (body.native !== undefined && typeof body.native !== "boolean") return res.status(400).json({ error: "native must be true or false." });
      const out = await loadPanaceaFile(session, art, {
        engine: body.engine as PanaceaEngineName | undefined, native: body.native as boolean | undefined, replace: body.replace === true,
      }, opts);
      return res.status(out.ok ? 200 : out.status ?? 400).json(out);
    }
    if (!loadable(which, art)) return res.status(400).json({ error: `${NAME[which]} cannot open ${art.name}.` });
    try {
      const out = await load(session, which, art);
      if (!out.ok) return res.status(400).json({ error: out.error ?? `${NAME[which]} could not open ${art.name}.` });
      return res.json({ ok: true, name: art.name, said: out.said });
    } catch (err) {
      return res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
