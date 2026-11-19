import { IconSparkle } from "./Icons";

/**
 * Learn mode's switch, in the header beside the chat's other choices: on, Autora shows how to use the tools by
 * highlighting them one step at a time instead of doing the work; off, it works at its own speed (docs/LEARN.md).
 */
export function LearnToggle({ on, onChange, dot = false }: { on: boolean; onChange: (on: boolean) => void; dot?: boolean }) {
  return (
    <button
      type="button"
      className={`learn-toggle${on ? " is-on" : ""}${dot ? " is-compact" : ""}`}
      aria-pressed={on}
      aria-label="Learn"
      title={on
        ? "Learn is on: Autora shows you how, one highlighted step at a time, and you do it. Click to let it work at its own speed"
        : "Learn is off: Autora works at its own speed. Click to be shown how to use the tools instead"}
      onClick={() => onChange(!on)}
    >
      <IconSparkle size={14} />
      {!dot && <span>Learn</span>}
    </button>
  );
}
