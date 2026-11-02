import { useState } from "react";
import { addStep, currentStep, decide, setStepDone, type Project } from "../../lib/panacea/project";
import { IconCheck, IconChevron } from "../Icons";
import "./ProjectStrip.css";

/**
 * The project strip (docs/PANACEA-NEXT.md, N1): along the top of the canvas, the project's phases as pills, the step being
 * worked on with its tick, and, opened, every phase's steps, a field to add one, and the decisions made. Tapping a phase
 * moves the work there (the window glides the view to its region). Until the person approves the plan, the agent works
 * in the first phase only; Approve is here.
 *
 * Everything in it is the person's to change: it writes the project through `onChange` / `onPhase`, as one undoable step.
 * The agent's hand uses the same controls (hand.ts), found by their data attributes.
 */
export function ProjectStrip({ project, onChange, onPhase }: {
  project: Project;
  onChange: (next: Project, label: string) => void;
  onPhase: (phase: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [deciding, setDeciding] = useState("");
  const now = currentStep(project);
  const phaseNow = project.phases.find((p) => p.id === project.phase)!;
  const add = (phase: string, label: string) => {
    const r = addStep(project, phase, adding[phase] ?? "", "person");
    if (typeof r !== "string") { onChange(r, `Added a step to ${label}`); setAdding({ ...adding, [phase]: "" }); }
  };
  const record = () => {
    const r = decide(project, deciding, "person");
    if (typeof r !== "string") { onChange(r, "Recorded a decision"); setDeciding(""); }
  };
  const tick = (id: string, done: boolean) => {
    const r = setStepDone(project, id, done);
    if (typeof r !== "string") onChange(r, done ? "Ticked a step" : "Unticked a step");
  };
  return (
    <div className={`pa-proj pa-chrome${open ? " is-open" : ""}`} role="region" aria-label={`Project: ${project.title}`}>
      <div className="pa-proj-bar">
        <b className="pa-proj-title" title={project.stack ? `${project.title} · ${project.stack}` : project.title}>{project.title}</b>
        <div className="pa-proj-phases" role="tablist" aria-label="Phases">
          {project.phases.map((p, i) => {
            const done = p.steps.length > 0 && p.steps.every((s) => s.done);
            return (
              <button key={p.id} type="button" role="tab" data-phase={p.id} aria-selected={p.id === project.phase}
                className={`pa-proj-phase${p.id === project.phase ? " is-on" : ""}${done ? " is-done" : ""}`}
                onClick={() => onPhase(p.id)}>
                <span className="pa-proj-n" aria-hidden="true">{done ? <IconCheck size={10} /> : i + 1}</span>{p.label}
              </button>
            );
          })}
        </div>
        {now
          ? <span className="pa-proj-now">
              <button type="button" className="pa-proj-tick" data-step-tick={now.id} aria-label={`Done: ${now.text}`} onClick={() => tick(now.id, true)} />
              <span title={now.text}>{now.text}</span>
            </span>
          : <span className="pa-proj-now is-empty">{phaseNow.steps.length ? `${phaseNow.label} is done` : "No steps yet"}</span>}
        {!project.approved && <button type="button" className="pa-proj-approve" data-act="approve" onClick={() => onChange({ ...project, approved: true }, "Approved the plan")}>Approve plan</button>}
        <button type="button" className="pa-proj-open" data-act="project-open" aria-expanded={open} aria-label={open ? "Close the plan" : "Open the plan"} onClick={() => setOpen(!open)}>
          <IconChevron size={12} />
        </button>
      </div>
      {open && (
        <div className="pa-proj-body">
          <div className="pa-proj-cols">
            {project.phases.map((p) => (
              <section key={p.id} className={`pa-proj-col${p.id === project.phase ? " is-on" : ""}`} aria-label={p.label}>
                <h4>{p.label}</h4>
                <ul>
                  {p.steps.map((s) => (
                    <li key={s.id} data-step={s.id} className={s.done ? "is-done" : ""}>
                      <label><input type="checkbox" checked={s.done} onChange={(e) => tick(s.id, e.target.checked)} />{s.text}</label>
                    </li>
                  ))}
                </ul>
                <input className="pa-proj-field pa-proj-add" data-phase-add={p.id} value={adding[p.id] ?? ""} placeholder="Add a step" aria-label={`Add a step to ${p.label}`}
                  onChange={(e) => setAdding({ ...adding, [p.id]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(p.id, p.label); } }} />
              </section>
            ))}
          </div>
          <div className="pa-proj-decisions">
            <h4>Decisions</h4>
            {project.decisions.length ? <ul>{project.decisions.slice(-8).map((d, i) => <li key={i}>{d.text}<em>{d.by === "person" ? "you" : "Autora"}</em></li>)}</ul> : <p>None yet.</p>}
            <input className="pa-proj-field pa-proj-decide" value={deciding} placeholder="Record a decision" aria-label="Record a decision"
              onChange={(e) => setDeciding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); record(); } }} />
            {project.stack && <p className="pa-proj-stack">Built with {project.stack}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
