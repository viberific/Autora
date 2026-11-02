import { memo } from "react";
import { VendorMark } from "./Icons";
import { Markdown } from "./Markdown";

/**
 * A vendor's subscription CLI handed a job, and answering for itself.
 *
 * This is the transcript's way of showing *who* is working: Autora's own words
 * sit in the ordinary bubbles, and a delegate gets this -- the vendor's mark,
 * the vendor's name, and its reply arriving a piece at a time in its own
 * bubble. The point is that "I am talking to Claude" and "I am doing this
 * myself" must not look the same at a glance.
 *
 * It draws in every state it can be in, because a delegate fails in ways the
 * person has to act on: it is asked, it starts, it says what it is on, it
 * answers, it finishes -- or it is rate limited, signed out, timed out, not
 * installed, or it simply said nothing. A finished run says how long it took
 * and whether it touched any files, because that is the difference between a
 * conversation and work on the box.
 */
export const VendorCell = memo(function VendorCell({
  vendor, name, handoff, folder, text, doing, done, ok, reason, message, durationMs, files, working,
}: {
  vendor: string;
  name: string;
  /** The line Autora said when it handed the job over: who, and the folder. */
  handoff: string;
  /** The folder it was given: shown while it works, so "working" says where. */
  folder: string;
  /** The vendor's words, as much as has arrived. */
  text: string;
  /** What it says it is doing now, while it works. */
  doing: string | null;
  done: boolean;
  ok: boolean;
  reason: string | null;
  message: string;
  durationMs: number | null;
  files: string[];
  /** The turn is still live: a finished cell from an old turn has no pulse. */
  working: boolean;
}) {
  const live = working && !done;
  const bad = done && !ok;
  const howLong = durationMs === null ? "" : took(durationMs);

  return (
    <div className="cell-vendor" data-vendor={vendor} data-state={bad ? "bad" : live ? "live" : "done"}>
      {handoff && (
        <div className="vendor-handoff">{handoff}</div>
      )}
      <div className={`vendor-bubble${bad ? " is-bad" : ""}${live ? " is-live" : ""}`}>
        <div className="vendor-head">
          <span className={`vendor-mark${live ? " is-working" : ""}`} aria-hidden="true">
            <VendorMark vendor={vendor} size={13} />
          </span>
          <span className="vendor-name">{name}</span>
          {/* Announced, because it is the one short line that changes: "working
              in /x" then "3m 4s". The answer itself is not a live region -- it
              arrives every 120ms and a reader would hear it re-read. */}
          <span className="vendor-meta" role="status" aria-live="polite">
            {live
              ? doing ?? (text ? "answering" : folder ? `working in ${folder}` : "working")
              : bad
                ? reasonLabel(reason)
                : howLong
                  ? `${howLong}${files.length ? ` · ${files.length} file${files.length === 1 ? "" : "s"} edited` : " · read only"}`
                  : ""}
          </span>
        </div>

        {text ? (
          <div className="vendor-body">
            <Markdown text={text} />
            {live && <span className="vendor-caret" aria-hidden="true" />}
          </div>
        ) : live ? (
          <div className="vendor-wait">
            <span className="vendor-wait-dot" aria-hidden="true" />
            <span className="vendor-wait-dot" aria-hidden="true" />
            <span className="vendor-wait-dot" aria-hidden="true" />
          </div>
        ) : null}

        {bad && (
          <div className="vendor-fail" role="alert">
            <div className="vendor-fail-said">{message}</div>
            <div className="vendor-fail-next">
              {reason === "not_installed"
                ? "No CLI there to call. Autora can do this itself, or reach the vendor's API instead."
                : "Autora can retry this with an API model, or do it itself."}
            </div>
          </div>
        )}

        {done && ok && files.length > 0 && (
          <ul className="vendor-files">
            {files.slice(0, 6).map((file) => (
              <li key={file} title={file}>{file}</li>
            ))}
            {files.length > 6 && <li className="vendor-files-more">and {files.length - 6} more</li>}
          </ul>
        )}

        {done && ok && !text && !bad && (
          <div className="vendor-fail-said">It finished without saying anything.</div>
        )}
      </div>
    </div>
  );
});

/** 184_000 -> "3m 4s"; short runs stay in seconds. */
function took(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const total = Math.round(durationMs / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** The person's words for why it stopped, not the error code. */
function reasonLabel(reason: string | null): string {
  switch (reason) {
    case "rate_limit": return "rate limited";
    case "auth": return "signed out";
    case "timeout": return "timed out";
    case "not_installed": return "not installed";
    default: return "stopped";
  }
}
