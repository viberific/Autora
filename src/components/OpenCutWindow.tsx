import { useCallback, useEffect, useRef, useState } from "react";
import { useBootWatch } from "../lib/bootWatch";
import { useCollab } from "../lib/collab";
import { TakeControl } from "./TakeControl";
import { SaveButton } from "./SaveButton";
import { LoadButton } from "./LoadButton";
import { useFullscreen } from "../lib/fullscreen";
import { onVideoCommand, useVideoState, type VideoCommand } from "../lib/opencut";
import { IconMaximize, IconMinimize, IconVideo } from "./Icons";

/**
 * The video window: OpenCut's editor, beside the conversation.
 *
 * The editor is its own build (opencut-editor/), served at /opencut-editor/
 * and run in a frame sandboxed without an origin, so it cannot reach this app
 * or its API. This component is its only way out, and the whole wire between
 * them is `postMessage`:
 *
 *   frame -> here   store requests (where its projects and media are kept: the
 *                   server, see server/opencut.ts), its state, a finished export
 *   here -> frame   the answers, Autora's theme, and the agent's commands
 *
 * The agent does not edit the project behind the editor's back. It asks the
 * editor to, and the editor does it with its own timeline commands.
 */

/** The theme tokens the editor takes from this page (opencut-editor/src/autora/autora.css, `--a-*`). */
const THEME: Array<[string, string]> = [
  ["--bg", "--a-bg"], ["--s1", "--a-s1"], ["--s2", "--a-s2"], ["--s3", "--a-s3"], ["--s4", "--a-s4"], ["--sink", "--a-sink"],
  ["--border", "--a-border"], ["--border-strong", "--a-border-strong"],
  ["--text", "--a-text"], ["--text-2", "--a-text-2"], ["--text-3", "--a-text-3"],
  ["--accent", "--a-accent"], ["--accent-light", "--a-accent-light"], ["--accent-deep", "--a-accent-deep"], ["--on-accent", "--a-on-accent"],
  ["--accent-soft", "--a-accent-soft"], ["--accent-line", "--a-accent-line"], ["--accent-2", "--a-accent-2"],
  ["--live", "--a-live"], ["--warn", "--a-warn"], ["--danger", "--a-danger"],
  ["--sans", "--a-sans"], ["--mono", "--a-mono"], ["--r-sm", "--a-r-sm"], ["--r", "--a-r"], ["--r-lg", "--a-r-lg"],
];

function themeVars(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [from, to] of THEME) {
    const v = css.getPropertyValue(from).trim();
    if (v) out[to] = v;
  }
  return out;
}

/** How long the editor may take: an export or an import is as long as the file. */
const LONG: Record<string, number> = { export: 31 * 60_000, import_media: 11 * 60_000 };

export function OpenCutWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useVideoState();
  const frame = useRef<HTMLIFrameElement>(null);
  /* The project the frame opens on is the one open when the window mounted, and the frame's address never changes
     after that: it moves between projects itself, and a new address would reload it in the middle of the agent's work. */
  const [opening] = useState(desk.projectId ?? null);
  const mine = useCollab().held.includes("video");
  const [full, setFull] = useFullscreen();
  const [trouble, setTrouble] = useState<string | null>(null);

  /** This window's frame has said it is up: until then a command sent to it would be lost, so it claims none. */
  const up = useRef(false);
  /** Goes up when the frame is loaded afresh: a start that failed or stalled is tried once more by itself. */
  const [generation, setGeneration] = useState(0);
  useBootWatch(() => up.current, `${sessionId}:${generation}`, "video editor", setTrouble);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const query = `session=${encodeURIComponent(sessionId)}`;

  /** What the editor keeps, kept on the server. Media files go as bytes; everything else as JSON. */
  const store = useCallback(async (req: { op: string; ns: string; key?: string; value?: unknown }): Promise<unknown> => {
    const isFiles = req.ns.startsWith("files/");
    if (isFiles && req.op === "get") {
      const res = await fetch(`/api/opencut/file?ns=${encodeURIComponent(req.ns)}&key=${encodeURIComponent(req.key ?? "")}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Autora answered ${res.status}`);
      const meta = JSON.parse(decodeURIComponent(res.headers.get("X-Opencut-Meta") ?? "%7B%7D")) as { name?: string; type?: string; lastModified?: number };
      return { name: meta.name ?? req.key, type: meta.type ?? "", lastModified: meta.lastModified ?? 0, blob: await res.blob() };
    }
    if (isFiles && req.op === "set") {
      const kept = req.value as { name: string; type: string; lastModified: number; blob: Blob };
      const q = new URLSearchParams({ ns: req.ns, key: req.key ?? "", name: kept.name, type: kept.type, modified: String(kept.lastModified) });
      const res = await fetch(`/api/opencut/file?${q}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: kept.blob });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `Autora answered ${res.status}`);
      return null;
    }
    // Not application/json: the app's own parser stops at 5 MB, and a project with its thumbnail is not far off.
    const res = await fetch("/api/opencut/kv", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(req) });
    const body = (await res.json().catch(() => null)) as { value?: unknown; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(body?.error?.message ?? `Autora answered ${res.status}`);
    return body?.value ?? null;
  }, []);

  const send = useCallback((path: string, body: unknown) => {
    void fetch(`/api/opencut/${path}?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  }, [query]);

  /** Commands in flight to the frame: its answers find their way back here. */
  const waiting = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const seq = useRef(0);
  const toFrame = useCallback((name: string, args: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++seq.current;
    const timer = setTimeout(() => {
      waiting.current.delete(id);
      reject(new Error(`The editor did not answer ${name}`));
    }, LONG[name] ?? 120_000);
    waiting.current.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    post({ type: "autora:opencut:command", id, name, args });
  }), [post]);

  // What the frame says.
  useEffect(() => {
    const answer = (id: unknown, run: () => Promise<unknown>) => {
      if (typeof id !== "number") return;
      run().then(
        (value) => post({ type: "autora:opencut:result", id, ok: true, value }),
        (err: unknown) => {
          const message = String((err as Error)?.message ?? err);
          setTrouble(message);
          post({ type: "autora:opencut:result", id, ok: false, value: { message } });
        },
      );
    };
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "autora:opencut:store":
          answer(msg.id, () => store(msg.req as { op: string; ns: string }));
          break;
        case "autora:opencut:deliver":
          answer(msg.id, async () => {
            const q = new URLSearchParams({ session: sessionId, name: String(msg.name ?? "video.mp4"), mime: String(msg.mime ?? "video/mp4") });
            const res = await fetch(`/api/opencut/deliver?${q}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: msg.data as ArrayBuffer });
            const body = (await res.json().catch(() => null)) as { artifact?: string; error?: { message?: string } } | null;
            if (!res.ok || !body?.artifact) throw new Error(body?.error?.message ?? `Autora answered ${res.status}`);
            return { artifact: body.artifact };
          });
          break;
        case "autora:opencut:state":
          send("state", { projectId: msg.projectId ?? null, name: msg.name ?? null });
          break;
        case "autora:opencut:pick":
          send("pick", { text: String(msg.text ?? "") });
          break;
        case "autora:opencut:ready":
          up.current = true;
          setTrouble(null);
          post({ type: "autora:opencut:theme", vars: themeVars() });
          send("ready", { ready: true });
          break;
        case "autora:opencut:problem": {
          // The editor could not start, and said why: shown here, and told to the server so the agent hears it at once.
          if (up.current) break;
          const message = String(msg.message ?? "it stopped while starting").slice(0, 300);
          setTrouble(`The video editor could not start: ${message}`);
          send("ready", { ready: false, problem: message });
          break;
        }
        case "autora:opencut:reply": {
          const w = typeof msg.id === "number" ? waiting.current.get(msg.id) : undefined;
          if (!w || typeof msg.id !== "number") break;
          waiting.current.delete(msg.id);
          if (msg.ok) w.resolve(msg.value);
          else w.reject(new Error(String((msg.value as { message?: string } | null)?.message ?? "The editor could not do that")));
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, send, sessionId, store]);

  // A window that has just mounted (or reloaded its frame) has a frame that has not started: the server must not send it
  // commands yet.
  useEffect(() => {
    up.current = false;
    send("ready", { ready: false });
  }, [send, generation]);

  /* Up, it says so again every few seconds: the server forgets when it restarts (an update), and a word said once would
     then leave the agent waiting on an editor that is plainly there. */
  useEffect(() => {
    const beat = window.setInterval(() => { if (up.current) send("ready", { ready: true }); }, 5000);
    return () => window.clearInterval(beat);
  }, [send]);

  /* Not up after half a minute (a fetch that stalled, a start that hung): the frame is loaded once more, as a person would
     reload it. Only once: a second failure is said, not hidden behind more tries. */
  useEffect(() => {
    if (generation > 0) return;
    const timer = window.setTimeout(() => {
      if (up.current) return;
      setTrouble("The video editor is taking a while to start, so it is being loaded again.");
      setGeneration(1);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [generation]);

  // Autora's theme, followed: another theme, font or text size here is another one in the editor.
  useEffect(() => {
    const push = () => post({ type: "autora:opencut:theme", vars: themeVars() });
    const observer = new MutationObserver(push);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "style", "class"] });
    return () => observer.disconnect();
  }, [post]);

  /** One command from the agent, done by the editor and answered. */
  const play = useCallback(async (cmd: VideoCommand): Promise<unknown> => {
    let args = cmd.args;
    const name = cmd.name;
    // A file to import comes through the app's own route, by a link the agent's tool made.
    if (name === "import_media" && typeof args.sourceToken === "string") {
      const res = await fetch(`/api/opencut/source/${encodeURIComponent(args.sourceToken)}?${query}`);
      if (!res.ok) throw new Error("The file to import is no longer available");
      const { sourceToken: _t, ...rest } = args;
      args = { ...rest, file: await res.blob() };
      await toFrame("panel", { tab: "media" }).catch(() => undefined);
    }
    return await toFrame(name, args);
  }, [query, toFrame]);

  // The agent's commands for this chat. The first window to claim one does it: the same chat open in two tabs must not cut twice.
  useEffect(() => onVideoCommand((cmd) => {
    if (!up.current) return;
    void (async () => {
      const claim = await fetch(`/api/opencut/claim?${query}&id=${encodeURIComponent(cmd.id)}`, { method: "POST" })
        .then((r) => (r.ok ? (r.json() as Promise<{ won?: boolean }>) : { won: false }))
        .catch(() => ({ won: false }));
      if (!claim.won) return;
      try {
        send("reply", { id: cmd.id, ok: true, value: await play(cmd) });
      } catch (err) {
        send("reply", { id: cmd.id, ok: false, value: { message: String((err as Error)?.message ?? err) } });
      }
    })();
  }), [play, query, send]);

  /** Save: the editor writes the project now. A video project is yours across chats, so it stays here (Export makes the
      video file, which goes to Artifacts). */
  const keep = useCallback(async () => {
    await toFrame("save", {});
    return "Saved the project";
  }, [toFrame]);

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconVideo size={14} /></span>
        <span className="pdf-bar-app">Video</span>
        <span className="pdf-bar-name" title={desk.name ?? undefined}>{desk.name ?? "Video"}</span>
        <div className="spacer" />
        <LoadButton app="video" session={sessionId} phone={phone} />
        <SaveButton onSave={keep} phone={phone} disabled={!desk.name} />
        <TakeControl sessionId={sessionId} surface="video" mine={mine} phone={phone} thing="video" />
        {phone && (
          <button
            className="btn icon ghost pdf-full-btn"
            onClick={() => setFull(!full)}
            title={full ? "Back to the conversation" : "Full screen"}
            aria-label={full ? "Back to the conversation" : "Full screen"}
            aria-pressed={full}
          >
            {full ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
      </div>
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <div className="office-stage">
        <iframe
          ref={frame}
          key={generation}
          className="pdf-frame"
          src={`/opencut-editor/index.html?session=${encodeURIComponent(sessionId)}${opening ? `&project=${encodeURIComponent(opening)}` : ""}${phone ? "&phone=1" : ""}`}
          title={`${desk.name ?? "Video"}, in Panacea · Video`}
          sandbox="allow-scripts allow-downloads allow-modals allow-popups"
          allow="autoplay; fullscreen"
        />
      </div>
    </div>
  );
}
