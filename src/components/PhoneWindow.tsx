import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowFull } from "../lib/fullscreen";
import { usePhoneState } from "../lib/phonedesk";
import { IconMaximize, IconMinimize, IconPhone } from "./Icons";

/**
 * Autora Phone: the phone window.
 *
 * A real Android phone beside the conversation, driven by phonedriver (server/phone.ts). The screen is a picture fetched
 * again every time the phone moves on, by either of us; the same screen as text sits under it, which is what the agent
 * actually reads and what a tap names. The person can tap the picture themselves -- their tap goes through the server, so
 * the agent's next read sees it -- and can take the phone off the agent while they do.
 *
 * Nothing here holds the phone's state: the server does, so a window opened again shows where the phone really is.
 */
export function PhoneWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const state = usePhoneState();
  const [shot, setShot] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useWindowFull();
  const rev = useRef<number | undefined>(undefined);

  const base = `/api/phone/${encodeURIComponent(sessionId)}`;

  /** A new picture, and the text beside it. `force` is for the person's own tap, which never waits for the next tick. */
  const refresh = useCallback(async (force = false) => {
    if (!force && rev.current === state.rev && shot) return;
    rev.current = state.rev;
    try {
      const [pic, words] = await Promise.all([fetch(`${base}/screen`), fetch(`${base}/text`)]);
      if (pic.ok) {
        const blob = await pic.blob();
        setShot((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        setTrouble(null);
      } else {
        const why = (await pic.json().catch(() => ({}))) as { error?: string };
        setTrouble(why.error ?? "The phone did not answer.");
      }
      setText(words.ok ? ((await words.json()) as { text: string }).text : null);
    } catch {
      setTrouble("The phone did not answer.");
    }
  }, [base, state.rev, shot]);

  // Every move, by either of us, takes a new picture.
  useEffect(() => { void refresh(); }, [refresh]);

  // And a slow tick, for a screen that changes on its own (a clock, a loading page).
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void refresh(true); }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot); }, [shot]);

  const act = useCallback(async (body: Record<string, string>) => {
    setBusy(true);
    try {
      const r = await fetch(`${base}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const why = (await r.json().catch(() => ({}))) as { error?: string };
        setTrouble(why.error ?? "That did not work.");
      }
      await refresh(true);
    } finally {
      setBusy(false);
    }
  }, [base, refresh]);

  const tap = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const box = img.getBoundingClientRect();
    // The picture is the screen's own points at one pixel each: a click maps straight to a point.
    const x = Math.round(((e.clientX - box.left) / box.width) * img.naturalWidth);
    const y = Math.round(((e.clientY - box.top) / box.height) * img.naturalHeight);
    void act({ action: "tap", target: `${x},${y}` });
  };

  const hold = () => void fetch(`${base}/held`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ held: !state.held }),
  });

  return (
    <div className={`pdf-window phone-window has-rail ${phone ? "is-phone" : "is-desk"}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconPhone size={14} /></span>
        <span className="pdf-bar-app">Phone</span>
        <span className="pdf-bar-name">{state.trouble ? "No phone connected" : state.device ? state.device.replace(/^android:/, "") : "The phone"}</span>
        {busy && <span className="pdf-bar-note">Working…</span>}
        {state.held && <span className="pdf-bar-note">Yours</span>}
        <div className="spacer" />
        <button className={`cell-act${state.held ? " is-on" : ""}`} onClick={hold} title={state.held ? "Give the phone back to Autora" : "Take the phone off Autora"}>
          {state.held ? "Hand back" : "Take control"}
        </button>
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
      {(trouble || state.trouble) && <div className="pdf-problem" role="status">{trouble ?? state.trouble}</div>}
      <div className="phone-stage">
        {shot
          ? <img className="phone-shot" src={shot} alt="The phone's screen" onClick={tap} draggable={false} />
          : <p className="phone-empty">{state.trouble ?? "Waiting for the phone…"}</p>}
        {text && <pre className="phone-text">{text}</pre>}
      </div>
      <div className="phone-keys">
        <button className="cell-act" disabled={busy} onClick={() => act({ action: "press", key: "back" })}>Back</button>
        <button className="cell-act" disabled={busy} onClick={() => act({ action: "press", key: "home" })}>Home</button>
        <button className="cell-act" disabled={busy} onClick={() => act({ action: "press", key: "recents" })}>Recents</button>
        <button className="cell-act" disabled={busy} onClick={() => act({ action: "scroll", direction: "down" })}>Down</button>
        <button className="cell-act" disabled={busy} onClick={() => act({ action: "scroll", direction: "up" })}>Up</button>
      </div>
    </div>
  );
}
