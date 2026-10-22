import { useCallback, useEffect, useState } from "react";
import { ago } from "../lib/ago";
import { every } from "../lib/poll";
import { IconTrash } from "./Icons";

/**
 * A standing agreement: a class of call the person has already said yes to,
 * so the guard stops asking about it. Added by the agent, by them on an
 * approval card, or by pressing "do not ask again" there.
 */
type Agreement = {
  id: string;
  tool: string;
  match: string;
  note: string;
  added: number;
  by: "agent" | "person";
  used: number;
  last_used: number | null;
};

/** What the guard no longer asks about, with somewhere to read each one and take it back. */
export function AgreementsCard() {
  const [rules, setRules] = useState<Agreement[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/autonomy");
      const body = await res.json().catch(() => ({ rules: [] }));
      setRules(Array.isArray(body?.rules) ? body.rules : []);
    } catch {
      /* the next poll will pick it up */
    }
  }, []);

  useEffect(() => {
    void load();
    return every(load, 15_000);
  }, [load]);

  const revoke = useCallback(async (rule?: Agreement) => {
    await fetch(rule ? `/api/autonomy/${encodeURIComponent(rule.id)}` : "/api/autonomy", { method: "DELETE" });
    await load();
  }, [load]);

  if (rules.length === 0) return null;

  return (
    <section className="set-card agree">
      <div className="agree-top">
        <h3>Standing agreements</h3>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => void revoke()}>Revoke all</button>
      </div>
      <p className="agree-why">
        These calls run without an approval card. Everything else still waits for one,
        and anything that cannot be undone is asked about every time.
      </p>
      {rules.map((rule) => (
        <article className="rule" key={rule.id}>
          <div className="rule-top">
            <code className="rule-match">{rule.match}</code>
            <div className="spacer" />
            <button
              className="btn icon ghost"
              title="Take this agreement back"
              aria-label={`Revoke ${rule.match}`}
              onClick={() => void revoke(rule)}
            >
              <IconTrash size={13} />
            </button>
          </div>
          <div className="rule-foot">
            <span className="muted">
              {rule.tool} · {rule.by === "person" ? "you agreed" : "the agent proposed it"} {ago(rule.added)}
            </span>
            <span className="muted">
              {rule.used === 0
                ? "not used yet"
                : `used ${rule.used}×${rule.last_used ? `, last ${ago(rule.last_used)}` : ""}`}
            </span>
          </div>
          {rule.note && <p className="rule-note">{rule.note}</p>}
        </article>
      ))}
    </section>
  );
}
