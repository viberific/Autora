/**
 * The phone window: a real Android phone, driven from the chat.
 *
 * phonedriver (phonedriver.dev) does the work -- it reads the screen as text, taps, types and scrolls over adb, and asks
 * before it pays. Autora runs it as a child process, one command at a time, and this file is the wire between that and
 * the window: the screen as a picture, the same screen as text, the taps the person makes, and the agent's own calls.
 *
 * Why a window rather than the MCP server alone: the person has to see the phone to trust it, and has to be able to take
 * it off the agent mid-run. So the window follows the same convention the other engines use (server/desks.ts): a state
 * per chat, a notification when it changes, and a briefing the model reads. The tools themselves come from phonedriver's
 * own MCP server, registered as "phone" (server/mcphandoff.ts installs it); the two share one daemon, so a tap in the
 * window and a tool call act on the same phone and the same session.
 *
 * The binary is glibc and this image is musl: it is run with gcompat's loader and a shim lib that supplies the one symbol
 * gcompat lacks (see the Dockerfile), never without. Nothing here assumes it is installed -- a box without it says so.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";

/** Where the phone's own state lives: the daemon's socket and traces. Under /data so it outlives an update. */
const HOME = process.env.PHONEDRIVER_HOME || "/data/phonedriver";
const BIN = process.env.PHONEDRIVER_BIN || "/usr/local/bin/phonedriver";
const SHIM = process.env.PHONEDRIVER_SHIM || "/usr/local/lib/libresinit.so";
/** One command at a time: adb and the daemon's lease do not take two taps at once. */
const QUEUE: Array<() => void> = [];
let busy = false;
/** How long one command may take before it is given up on. A settle waits for the screen; a launch can be slow. */
const TIMEOUT_MS = 60_000;

interface PhoneState {
  open: boolean;
  since?: number;
  /** Goes up on every command, by anyone: the window takes a new screen when it moves. */
  rev?: number;
  /** Who ran the last command. */
  by?: "agent" | "person";
  /** The device as phonedriver names it, once one is connected. */
  device?: string;
  /** Why there is no phone, in the person's words, when there is not. */
  trouble?: string;
  /** The agent holds the phone (the person pressed Take control to take it back). */
  held?: boolean;
}

const state = new Map<string, PhoneState>();
const listeners = new Set<(session: string) => void>();

function entryFor(session: string): PhoneState {
  let entry = state.get(session);
  if (!entry) {
    entry = { open: false };
    state.set(session, entry);
  }
  return entry;
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

export function onPhoneChange(fn: (session: string) => void) {
  listeners.add(fn);
}

export function dropPhone(session: string) {
  state.delete(session);
}

/** Whether this server has the tool at all (the image installs it; a dev box may not). */
export function phoneAvailable(): boolean {
  return fs.existsSync(BIN) && fs.existsSync(SHIM);
}

export function phoneState(session: string): PhoneState {
  const entry = state.get(session);
  if (!entry?.open) return { open: false };
  return { ...entry };
}

/** The line of the capability briefing, so the model knows the window exists and what it is for. */
export function phoneBriefing(enabled: boolean): string {
  if (!enabled) return "Phone (off): the phone window is switched off on the Tools page.";
  return (
    "Phone: a real Android phone beside the chat. The person sees the screen and can tap it; you read it with " +
    "phone_screen (text) and phone_look (a picture), and act with phone_tap, phone_type, phone_scroll and phone_press. " +
    "Read before you tap, and say what you are doing. Unlocking and fingerprints stay theirs."
  );
}

/* ------------------------------------------------------------------ running it */

function run(args: string[], timeout = TIMEOUT_MS): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, {
      env: { ...process.env, LD_PRELOAD: SHIM, PHONEDRIVER_HOME: HOME, PHONEDRIVER_GUARD: "on" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      err += `\n(timed out after ${Math.round(timeout / 1000)}s)`;
    }, timeout);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
  });
}

/** One command at a time, queued rather than refused: a person's tap waits for the agent's read, not the other way. */
function serial<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      busy = true;
      void job().then(resolve, reject).finally(() => {
        busy = false;
        QUEUE.shift()?.();
      });
    };
    if (busy) QUEUE.push(start);
    else start();
  });
}

/** The one device phonedriver can see, or null. */
async function device(): Promise<string | null> {
  const first = await onlyDevice();
  if (first) return first;
  /* A phone that slept, or whose wireless debugging idled out, drops its tunnel. Try the address it was paired on once. */
  const last = lastDevice;
  if (!last) return null;
  await run(["connect", last], 20_000);
  return onlyDevice();
}

let lastDevice = "";

async function onlyDevice(): Promise<string | null> {
  const r = await run(["devices", "--json"], 20_000);
  const text = r.out.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Array<{ id?: string }> | { devices?: Array<{ id?: string }> };
    const list = Array.isArray(parsed) ? parsed : parsed.devices ?? [];
    lastDevice = list[0]?.id ?? lastDevice;
    return list[0]?.id ?? null;
  } catch {
    const first = text.split("\n").find((l) => l.startsWith("android:") || l.startsWith("ios:"));
    lastDevice = first?.split(/\s+/)[0] ?? lastDevice;
    return first?.split(/\s+/)[0] ?? null;
  }
}

/** Runs a command against the phone, and moves the window on. The reason a command failed is handed back, not thrown. */
async function command(session: string, by: "agent" | "person", args: string[]) {
  const entry = entryFor(session);
  return serial(async () => {
    const id = await device();
    if (!id) {
      entry.trouble = "No phone is connected. Turn on Wireless debugging on the phone, then pair it in Settings.";
      delete entry.device;
      changed(session);
      return { ok: false as const, error: entry.trouble };
    }
    entry.device = id;
    delete entry.trouble;
    const r = await run(["--device", id, ...args]);
    entry.rev = (entry.rev ?? 0) + 1;
    entry.by = by;
    changed(session);
    const text = (r.out || r.err).trim();
    if (r.code !== 0) return { ok: false as const, error: text || `phonedriver exited ${r.code}` };
    return { ok: true as const, text };
  });
}

/* ------------------------------------------------------------------ the agent's tools */

/** What is on the phone's screen, as text, with the references a tap can name. */
export async function phoneScreen(session: string): Promise<string> {
  const r = await command(session, "agent", ["snapshot"]);
  return r.ok ? r.text : `Could not read the screen: ${r.error}`;
}

/** A picture of the screen, as a PNG path. */
export async function phoneLook(session: string): Promise<string> {
  const r = await command(session, "agent", ["screenshot"]);
  return r.ok ? r.text : `Could not take a picture: ${r.error}`;
}

export async function phoneTap(session: string, target: string): Promise<string> {
  const r = await command(session, "agent", ["tap", "--target", target]);
  return r.ok ? r.text : `The tap failed: ${r.error}`;
}

export async function phoneType(session: string, text: string, into?: string): Promise<string> {
  const args = ["type", "--text", text];
  if (into) args.push("--into", into);
  const r = await command(session, "agent", args);
  return r.ok ? r.text : `Typing failed: ${r.error}`;
}

export async function phoneScroll(session: string, direction: string, until?: string): Promise<string> {
  const args = ["scroll", "--direction", direction];
  if (until) args.push("--until", until);
  const r = await command(session, "agent", args);
  return r.ok ? r.text : `Scrolling failed: ${r.error}`;
}

export async function phonePress(session: string, key: string): Promise<string> {
  const r = await command(session, "agent", ["press", key]);
  return r.ok ? r.text : `Pressing ${key} failed: ${r.error}`;
}

/* ------------------------------------------------------------------ the routes */

const validSession = (id: string) => /^[A-Za-z0-9_-]{6,64}$/.test(id);

export function phoneRoutes(app: Express, opts: { exists: (session: string) => boolean; off: () => boolean }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    if (!phoneAvailable()) {
      res.status(503).json({ error: "The phone tool is not installed in this server." });
      return null;
    }
    return id;
  };

  app.get("/api/phone/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json({ ...phoneState(id), available: true });
  });

  app.post("/api/phone/:session/open", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "The phone window is switched off on the Tools page." });
    const entry = entryFor(id);
    if (!entry.open) {
      entry.open = true;
      entry.since = Date.now();
      changed(id);
    }
    /* Look for the phone now, so the header says which one it is (or that none is connected) instead of guessing. */
    const dev = await device();
    if (dev) {
      entry.device = dev;
      delete entry.trouble;
    } else {
      entry.trouble = "No phone is connected. Turn on Wireless debugging on the phone, then pair it in Settings.";
      delete entry.device;
    }
    changed(id);
    res.json(phoneState(id));
  });

  app.post("/api/phone/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const entry = entryFor(id);
    entry.open = false;
    changed(id);
    res.json(phoneState(id));
  });

  /* The person's own hands: the same commands the agent's tools run, marked as theirs, so the window knows the screen moved
     without asking again. */
  app.post("/api/phone/:session/act", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const { action, target, text, direction, key } = req.body as Record<string, string | undefined>;
    const args: string[] | null =
      action === "tap" && target ? ["tap", "--target", target]
        : action === "type" && text ? ["type", "--text", text, ...(target ? ["--into", target] : [])]
          : action === "scroll" && direction ? ["scroll", "--direction", direction]
            : action === "press" && key ? ["press", key]
              : null;
    if (!args) return res.status(400).json({ error: "Nothing to do." });
    const r = await command(id, "person", args);
    res.status(r.ok ? 200 : 502).json(r);
  });

  /* A picture of the screen for the window. It is the person's own eyes, so it is allowed while the agent works. */
  app.get("/api/phone/:session/screen", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const r = await serial(async () => {
      /* device() already retries the paired address, so a phone that slept comes back on its own. */
      const dev = await device();
      if (!dev) return { code: 1, out: "", err: "no phone" };
      return run(["--device", dev, "screenshot", "--json", "--timeout", "15000"], 30_000);
    });
    if (r.code !== 0) return res.status(502).json({ error: (r.err || "no picture").trim() });
    /* --json answers one object with the file in it; without it, "path WxH". Either way the path is what is wanted. */
    let file = "";
    try {
      file = (JSON.parse(r.out.trim()) as { path?: string }).path ?? "";
    } catch {
      file = r.out.trim().split(/\s+/)[0] ?? "";
    }
    if (!file || !fs.existsSync(file)) return res.status(502).json({ error: "no picture" });
    /* A picture means the phone answered, so the header should stop saying it is missing. */
    const entry = entryFor(id);
    if (entry.trouble) {
      delete entry.trouble;
      changed(id);
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(file).pipe(res);
  });

  /* The screen as text, for the person to read beside the picture. */
  app.get("/api/phone/:session/text", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const r = await serial(async () => {
      const dev = await device();
      if (!dev) return { code: 1, out: "", err: "no phone" };
      return run(["--device", dev, "snapshot"], 30_000);
    });
    res.status(r.code === 0 ? 200 : 502).json({ text: (r.out || r.err).trim() });
  });

  /* Take the phone off the agent, and give it back. While held, the agent's tools are told so in the briefing. */
  app.post("/api/phone/:session/held", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const entry = entryFor(id);
    entry.held = Boolean(req.body?.held);
    changed(id);
    res.json(phoneState(id));
  });
}

/** The path the window's picture is fetched from, for the briefing. */
const _PHONE_SCREEN_PATH = (session: string) => `/api/phone/${encodeURIComponent(session)}/screen`;

const _phonePath = path;
