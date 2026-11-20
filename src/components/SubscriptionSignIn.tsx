import { useCallback, useEffect, useRef, useState } from "react";

type SignIn = {
  installed: boolean;
  signed_in: boolean;
  via: string;
  pending: { url: string } | null;
  detail: string;
};

/**
 * A subscription's sign-in, done here rather than in a terminal in the container: the CLI's own sign-in runs on the server, the
 * link it prints opens the vendor's page in a new tab, and the code that page shows is pasted back (server/cli-signin.ts).
 */
export function SubscriptionSignIn({ id, label, onSignedIn }: {
  id: string;
  label: string;
  /** Told once the CLI says it is signed in, so the page around it can move on (the chat's setup card connects). */
  onSignedIn?: () => void;
}) {
  const [status, setStatus] = useState<SignIn | null>(null);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  /* Held in a ref: a caller's new function each render must not fetch the status again. */
  const told = useRef(onSignedIn);
  useEffect(() => { told.current = onSignedIn; });
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/providers/${id}/signin`)
      .then((r) => r.json())
      .then((body: SignIn) => {
        if (!live) return;
        setStatus(body);
        if (body.signed_in) told.current?.();
        if (body.pending?.url) setUrl(body.pending.url);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [id]);

  const start = useCallback(async () => {
    setBusy(true);
    setSaid(null);
    try {
      const res = await fetch(`/api/providers/${id}/signin`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) { setSaid({ ok: false, text: body.detail ?? "The sign-in did not start." }); return; }
      setUrl(body.url);
      setCode("");
    } catch {
      setSaid({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }, [id]);

  const finish = useCallback(async () => {
    setBusy(true);
    setSaid(null);
    try {
      const res = await fetch(`/api/providers/${id}/signin/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (res.ok) {
        setStatus(body);
        setUrl("");
        setCode("");
        setSaid({ ok: true, text: "Signed in. Chats on this provider now run on the subscription." });
        told.current?.();
      } else {
        if (res.status === 409) setUrl("");
        setSaid({ ok: false, text: body.detail ?? "The code was not taken." });
      }
    } catch {
      setSaid({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }, [id, code]);

  if (!status) return null;
  const signedIn = status.signed_in;
  /* agy keeps its own sign-in on the boxes that have it: nothing to do here. */
  const canSignIn = status.installed && status.via !== "agy";

  return (
    <div className="set-key">
      <div className="set-key-head">
        <b>{label} sign-in</b>
        {signedIn ? <em className="set-badge">signed in</em> : <em className="set-badge is-unset">not signed in</em>}
      </div>
      <p className="set-note">{status.detail}</p>
      {canSignIn && url ? (
        <>
          <p className="set-note">
            <a href={url} target="_blank" rel="noreferrer">Open the sign-in page</a>, approve it, then paste the code it shows.
          </p>
          <div className="set-key-edit">
            <input
              type="password"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) { e.preventDefault(); void finish(); } }}
              placeholder="paste the code"
              spellCheck={false}
              aria-label={`${label} sign-in code`}
            />
            <button className="btn primary" onClick={() => void finish()} disabled={busy || !code.trim()}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button className="btn ghost" onClick={() => { setUrl(""); setCode(""); }}>Cancel</button>
          </div>
        </>
      ) : canSignIn ? (
        <button className="btn ghost" onClick={() => void start()} disabled={busy}>
          {busy ? "Starting…" : signedIn ? "Sign in again" : "Sign in"}
        </button>
      ) : null}
      {said && <p className={said.ok ? "prov-ok" : "set-warn"}>{said.text}</p>}
    </div>
  );
}
