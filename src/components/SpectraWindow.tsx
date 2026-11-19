import { useCallback, useEffect, useRef, useState } from "react";
import { SaveButton, settle } from "./SaveButton";
import { LoadButton } from "./LoadButton";
import { useWindowFull } from "../lib/fullscreen";
import { useCollab } from "../lib/collab";
import { TakeControl } from "./TakeControl";
import { useDeskState } from "../lib/pdfdesk";
import { useBootWatch } from "../lib/bootWatch";
import { onSpectraEvent } from "../lib/spectra";
import { useFrameTheme } from "../lib/frameTheme";
import { IconDownload, IconFile, IconMaximize, IconMinimize } from "./Icons";

/**
 * The PDF window: the file the agent is working on, in Spectra-PDF's editor.
 *
 * Spectra's own renderer is a build of its own (spectra-editor/), served at
 * /spectra-editor/. It ran as a Tauri desktop app, talking to Rust over IPC;
 * here those commands go to Autora's server, which owns what each one means
 * (server/spectra.ts, server/spectra/commands.ts), and the engine that had been
 * a Rust child process runs beside it.
 *
 * The frame is sandboxed without an origin of its own -- it renders PDFs from
 * anywhere -- so it cannot reach this app or its API. This component is its
 * only way out: it answers the frame's commands over HTTP and relays the
 * events the frame asked for. That is the whole of the wire between them; the
 * editor's own state, its UI and its history are its own.
 */
export function SpectraWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useDeskState();
  const frame = useRef<HTMLIFrameElement>(null);
  /** The event names the frame has asked to be told about. */
  const wanted = useRef(new Set<string>());
  const [trouble, setTrouble] = useState<string | null>(null);
  /* Whether this server can run the PDF editor at all (its page and its engine, server/tools.ts installedWindows). When it
     cannot, the window says so in place of the editor: the editor's own page used to open on a full set of tools and a
     "Could Not Open" dialog. Unknown until the server answers, and unknown is not "missing". */
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/settings").then((r) => r.json())
      .then((body: { tools?: { installed?: Record<string, boolean> } }) => { if (live) setMissing(body?.tools?.installed?.pdf === false); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  /** Bumped when the agent changes the document under the editor: the frame is
   *  loaded again, which is the only way it re-reads a file it already has. */
  const [generation, setGeneration] = useState(0);
  /** The frame has said it is up (it is asked again after each reload). */
  const booted = useRef(false);
  useEffect(() => { booted.current = false; }, [generation]);
  useBootWatch(() => booted.current, generation, "PDF editor", setTrouble);
  /* Whether the person has taken the PDF for themselves: the agent leaves the
     file alone until they hand it back. Autora's own surface, not the editor's
     -- the editor does not know this window exists. */
  const mine = useCollab().held.includes("pdf");
  /** On a phone the pinned view is a third of the screen: editing wants all of it. */
  const [full, setFull] = useWindowFull();

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);
  useFrameTheme(frame);

  /** One command from the editor, answered by Autora's server. */
  const invoke = useCallback(
    async (msg: { id?: unknown; command?: unknown; args?: unknown }) => {
      const { id, command } = msg;
      if (typeof id !== "number" || typeof command !== "string") return;
      try {
        const res = await fetch(`/api/spectra/invoke?session=${encodeURIComponent(sessionId)}`, {
          method: "POST",
          /* Not application/json: the app's own JSON parser stops at 5 MB, and a
             command carrying a document's bytes is bigger than that. text/plain
             is read by the route's own parser, which has room for it. */
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ command, args: msg.args ?? {} }),
        });
        const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
        const failure = body?.error ?? (res.ok ? null : { message: `Autora answered ${res.status}` });
        post({ type: "autora:spectra:result", id, ok: !failure, value: failure ?? body?.result });
        if (!failure) setTrouble(null);
      } catch (err: any) {
        post({ type: "autora:spectra:result", id, ok: false, value: { message: String(err?.message ?? err) } });
      }
    },
    [post, sessionId],
  );

  /** Save: the editor's own Save, pressed now; the file in Artifacts follows it a moment later (server/pdfdesk.ts). */
  const savedNow = useRef<((ok: boolean) => void) | null>(null);
  const keep = useCallback(async () => {
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => done(false), 12_000);
      function done(v: boolean) { clearTimeout(t); savedNow.current = null; resolve(v); }
      savedNow.current = done;
      post({ type: "autora:spectra:save" });
    });
    if (!ok) throw new Error("The editor did not finish saving");
    await settle(800);
    return desk.name ? `Kept in Artifacts as ${desk.name}` : "Saved";
  }, [desk.name, post]);

  // What the frame says: it is up, it wants an event, or it is closing.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "autora:spectra:invoke") {
        void invoke(msg);
      } else if (msg.type === "autora:spectra:saved") {
        savedNow.current?.(msg.ok !== false);
      } else if (msg.type === "autora:spectra:asset" && typeof msg.id === "number" && typeof msg.path === "string") {
        // pdf.js's data files for the frame, fetched here, where the request carries what a login proxy wants.
        const id = msg.id;
        const path: string = msg.path;
        const answer = (status: number, mime: string | null, body: ArrayBuffer | null) => {
          const target = frame.current?.contentWindow;
          if (!target) return;
          target.postMessage({ type: "autora:spectra:asset-result", id, status, mime, body }, "*", body ? [body] : []);
        };
        if (!/^\/spectra-editor\/pdfjs\/[\w./-]+$/.test(path) || path.includes("..")) { answer(403, null, null); return; }
        void fetch(path)
          .then(async (res) => answer(res.status, res.headers.get("content-type"), res.ok ? await res.arrayBuffer() : null))
          .catch(() => answer(502, null, null));
      } else if (msg.type === "autora:spectra:pick" && typeof msg.text === "string") {
        // The words the person has selected in the page, for the agent's next briefing.
        void fetch(`/api/pdfdesk/${encodeURIComponent(sessionId)}/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: msg.text }) }).catch(() => undefined);
      } else if (msg.type === "autora:spectra:listen" && typeof msg.event === "string") {
        wanted.current.add(msg.event);
      } else if (msg.type === "autora:spectra:error" && typeof msg.message === "string") {
        // The editor threw on its way up or while running: shown, rather than left as a grey frame.
        setTrouble(`The PDF editor hit an error: ${msg.message.slice(0, 200)}`);
      } else if (msg.type === "autora:spectra:ready") {
        booted.current = true;
        setTrouble(null);
        /* The editor has booted: tell it to take the document, if it did not
           get one already. The frame can be up before the desk has the file
           (the window opens with the desk's own change), and an editor that
           asked once and found nothing would sit on Home for good. */
        frame.current.contentWindow?.postMessage({ type: "autora:spectra:event", event: "app:openFile", payload: {} }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [invoke, sessionId]);

  // The server's pushes for this session, on to the frame that asked for them.
  useEffect(
    () =>
      onSpectraEvent(({ event, payload }) => {
        /* The agent edited the document: the editor's own event is no use here
           (a hand-over of a path it already has open only focuses the tab), so
           the frame is reloaded and opens the file as it is now. */
        if (event === "autora:reload") {
          setGeneration((n) => n + 1);
          return;
        }
        if (wanted.current.has(event)) post({ type: "autora:spectra:event", event, payload });
      }),
    [post],
  );

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
        <span className="pdf-bar-app">PDF</span>
        <span className="pdf-bar-name" title={desk.name ?? undefined}>{desk.name ?? "PDF"}</span>
        <div className="spacer" />
        <LoadButton app="pdf" session={sessionId} phone={phone} />
        <SaveButton onSave={keep} phone={phone} disabled={!desk.name} />
        <TakeControl sessionId={sessionId} surface="pdf" mine={mine} phone={phone} thing="PDF" />
        {desk.working && (
          <a
            className="btn icon ghost"
            href={`/api/artifacts/${desk.working}?download`}
            title="Download the file as it is now"
            aria-label="Download the file as it is now"
          >
            <IconDownload size={14} />
          </a>
        )}
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
      {trouble && !missing && <div className="pdf-problem" role="status">{trouble}</div>}
      {missing ? (
        <div className="pdf-missing" role="status">
          <b>The PDF editor is not installed on this server.</b>
          <span>{desk.name ? `${desk.name} is safe in Artifacts, and can be downloaded from there.` : "PDFs can still be read, made and changed by asking Autora."}</span>
        </div>
      ) : <iframe
        ref={frame}
        key={generation}
        className="pdf-frame"
        src={`/spectra-editor/index.html?session=${encodeURIComponent(sessionId)}${phone ? "&phone=1" : ""}`}
        title={`${desk.name ?? "PDF"}, in Panacea · PDF`}
        sandbox="allow-scripts allow-downloads allow-modals allow-popups"
      />}
    </div>
  );
}
