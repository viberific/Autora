/**
 * A project on the canvas (docs/PANACEA-NEXT.md, N1): the work as phases, each with its steps; the phase being worked
 * on; the decisions made on the way; the links between its pieces; the stack an app is built with. It is data on the
 * canvas, so the agent (`panacea_project`) and the person (the project strip) change the same thing, and the canvas's
 * history and saving cover it.
 *
 * Each phase has a region of its own on the canvas, side by side: new work lands in the region of the phase being
 * worked on, and moving to a phase moves the view there. A surface remembers its phase (`Surface.phase`).
 *
 * Who decides: the agent drafts a plan, the person approves it. Until they do, the agent cannot move past the first
 * phase (the tool refuses, it is not a prompt rule); the person can do anything from the strip.
 *
 * Pure: plain JSON in and out.
 */
import type { Who } from "./canvas";

interface ProjectStep { id: string; text: string; done: boolean; by: Who }
export interface ProjectPhase { id: string; label: string; steps: ProjectStep[] }
export interface ProjectLink { from: string; to: string; why: string }
export interface ProjectDecision { at: number; text: string; by: Who }

export interface Project {
  title: string;
  phases: ProjectPhase[];
  /** The phase being worked on: one of `phases`' ids. */
  phase: string;
  /** The person has approved the plan; until then the agent works in the first phase only. */
  approved: boolean;
  decisions: ProjectDecision[];
  links: ProjectLink[];
  /** What an app is built with, chosen by the agent and said here for the person to see and change. */
  stack?: string;
}

const MAX_PHASES = 8;
const MAX_STEPS_PER_PHASE = 40;
const MAX_DECISIONS = 60;
const MAX_LINKS = 120;
const MAX_TEXT = 200;

/** How far apart the phases' regions are on the canvas: far enough that one phase's work never crowds another's. */
export const REGION_W = 6400;

/** The phases a project has when nobody says otherwise. */
const DEFAULT_PHASES = ["Plan", "Make", "Check"];

const clean = (s: unknown, max = MAX_TEXT) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const slug = (label: string, taken: Set<string>) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "phase";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
};
let counter = 0;
const stepId = () => `st${Date.now().toString(36).slice(-5)}${(counter = (counter + 1) % 1296).toString(36).padStart(2, "0")}`;

/** A new project: a title and its phases, each with its first steps. */
export function createProject(input: { title: string; phases?: Array<string | { label: string; steps?: string[] }>; stack?: string; by: Who; approved?: boolean }): Project | string {
  const title = clean(input.title, 80);
  if (!title) return "A project needs a title.";
  const raw = input.phases?.length ? input.phases : DEFAULT_PHASES;
  if (raw.length > MAX_PHASES) return `A project has at most ${MAX_PHASES} phases.`;
  const ids = new Set<string>();
  const phases: ProjectPhase[] = [];
  for (const p of raw) {
    const label = clean(typeof p === "string" ? p : p.label, 32);
    if (!label) return "Every phase needs a name.";
    const steps = (typeof p === "string" ? [] : p.steps ?? []).map((x) => clean(x)).filter(Boolean);
    if (steps.length > MAX_STEPS_PER_PHASE) return `A phase has at most ${MAX_STEPS_PER_PHASE} steps.`;
    phases.push({ id: slug(label, ids), label, steps: steps.map((text) => ({ id: stepId(), text, done: false, by: input.by })) });
  }
  const stack = clean(input.stack, 80);
  return { title, phases, phase: phases[0]!.id, approved: input.approved ?? input.by === "person", decisions: [], links: [], ...(stack ? { stack } : {}) };
}

/** A project from anywhere (disk, the page), checked and repaired; undefined when there is none. */
export function readProject(raw: unknown): Project | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const ids = new Set<string>();
  const stepIds = new Set<string>();
  const who = (v: unknown): Who => (v === "agent" || v === "person" || v === "rule" ? v : "agent");
  const phases: ProjectPhase[] = (Array.isArray(r.phases) ? r.phases : []).slice(0, MAX_PHASES).flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const q = p as Record<string, unknown>;
    const label = clean(q.label, 32);
    if (!label) return [];
    const id = typeof q.id === "string" && /^[a-z0-9-]{1,40}$/.test(q.id) && !ids.has(q.id) ? (ids.add(q.id), q.id) : slug(label, ids);
    const steps = (Array.isArray(q.steps) ? q.steps : []).slice(0, MAX_STEPS_PER_PHASE).flatMap((s) => {
      if (!s || typeof s !== "object") return [];
      const t = s as Record<string, unknown>;
      const text = clean(t.text);
      const sid = typeof t.id === "string" && /^[\w-]{1,40}$/.test(t.id) && !stepIds.has(t.id) ? t.id : stepId();
      stepIds.add(sid);
      return text ? [{ id: sid, text, done: t.done === true, by: who(t.by) }] : [];
    });
    return [{ id, label, steps }];
  });
  const title = clean(r.title, 80);
  if (!title || !phases.length) return undefined;
  const phase = typeof r.phase === "string" && phases.some((p) => p.id === r.phase) ? r.phase : phases[0]!.id;
  const decisions = (Array.isArray(r.decisions) ? r.decisions : []).slice(-MAX_DECISIONS).flatMap((d) => {
    const x = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    const text = clean(x.text);
    return text ? [{ at: typeof x.at === "number" && Number.isFinite(x.at) ? x.at : 0, text, by: who(x.by) }] : [];
  });
  const links = (Array.isArray(r.links) ? r.links : []).slice(0, MAX_LINKS).flatMap((l) => {
    const x = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    const from = clean(x.from, 40);
    const to = clean(x.to, 40);
    return from && to ? [{ from, to, why: clean(x.why) }] : [];
  });
  const stack = clean(r.stack, 80);
  return { title, phases, phase, approved: r.approved === true, decisions, links, ...(stack ? { stack } : {}) };
}

/** Which phase a name means: its id, or its label in any case. */
export function phaseFor(p: Project, name: unknown): ProjectPhase | undefined {
  const n = clean(name, 40).toLowerCase();
  return p.phases.find((x) => x.id === n || x.label.toLowerCase() === n);
}

/** Where a phase's region starts on the canvas, by its place in the order. */
export function regionX(p: Project, phase: string): number {
  return Math.max(0, p.phases.findIndex((x) => x.id === phase)) * REGION_W;
}

/** The step being worked on in a phase: its first not done. */
export function currentStep(p: Project, phase = p.phase): ProjectStep | undefined {
  return p.phases.find((x) => x.id === phase)?.steps.find((s) => !s.done);
}

/** Every step, with the phase it is in. */
export function stepById(p: Project, id: string): { phase: ProjectPhase; step: ProjectStep } | undefined {
  for (const phase of p.phases) {
    const step = phase.steps.find((s) => s.id === id);
    if (step) return { phase, step };
  }
  return undefined;
}

export function addStep(p: Project, phase: string, text: string, by: Who): Project | string {
  const ph = p.phases.find((x) => x.id === phase);
  if (!ph) return `There is no phase "${phase}".`;
  const t = clean(text);
  if (!t) return "A step needs words.";
  if (ph.steps.length >= MAX_STEPS_PER_PHASE) return `${ph.label} has ${MAX_STEPS_PER_PHASE} steps already.`;
  return { ...p, phases: p.phases.map((x) => (x.id === phase ? { ...x, steps: [...x.steps, { id: stepId(), text: t, done: false, by }] } : x)) };
}

export function setStepDone(p: Project, id: string, done: boolean): Project | string {
  if (!stepById(p, id)) return `There is no step "${id}".`;
  return { ...p, phases: p.phases.map((x) => ({ ...x, steps: x.steps.map((s) => (s.id === id ? { ...s, done } : s)) })) };
}

export function decide(p: Project, text: string, by: Who, at = Date.now()): Project | string {
  const t = clean(text);
  if (!t) return "A decision needs words.";
  return { ...p, decisions: [...p.decisions, { at, text: t, by }].slice(-MAX_DECISIONS) };
}

export function linkPieces(p: Project, from: string, to: string, why: string): Project | string {
  const a = clean(from, 40);
  const b = clean(to, 40);
  if (!a || !b || a === b) return "A link joins two different pieces, by id.";
  if (p.links.length >= MAX_LINKS) return `A project holds at most ${MAX_LINKS} links.`;
  return { ...p, links: [...p.links.filter((l) => !(l.from === a && l.to === b)), { from: a, to: b, why: clean(why) }] };
}

/** The project in words, for the agent. */
export function describeProject(p: Project): string {
  const lines = [`Project "${p.title}"${p.stack ? ` (stack: ${p.stack})` : ""}, ${p.approved ? "plan approved by the person" : "plan NOT yet approved: work only in the first phase until they approve it in the strip or say so"}; working on ${p.phases.find((x) => x.id === p.phase)?.label ?? p.phase}.`];
  for (const ph of p.phases) {
    lines.push(`- phase ${ph.id} "${ph.label}"${ph.id === p.phase ? " (now)" : ""}: ${ph.steps.length ? ph.steps.map((s) => `${s.done ? "[x]" : "[ ]"} ${s.id} ${s.text}`).join("; ") : "no steps"}`);
  }
  if (p.decisions.length) lines.push(`Decisions: ${p.decisions.slice(-12).map((d) => `${d.text} (${d.by === "person" ? "the person" : "you"})`).join("; ")}.`);
  if (p.links.length) lines.push(`Links: ${p.links.slice(0, 30).map((l) => `${l.from} -> ${l.to}${l.why ? ` (${l.why})` : ""}`).join("; ")}.`);
  return lines.join("\n");
}
