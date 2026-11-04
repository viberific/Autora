# One adaptive engine, not a bundle of editors

Status: proposal, not started. Written 2026-11-04 after the person asked whether Panacea can be one engine that adapts,
and what the right infrastructure is. Read `docs/PANACEA-ENGINE.md` first: this plan extends its M0 to M5, it does not
replace them.

## Problem

Panacea is one workspace (one board, one camera, one composer) but not one engine. Each kind of work is a separate
editor with its own model, command shape, history and agent path:

- Native canvas kinds (image, data, boards, documents) are in the surface registry (`src/lib/panacea/kinds.ts`, M0 done).
- Hosted editors are separate: GenOffice (Pages, Sheets, Slides), Spectra (PDF), OpenCut (Video), GDevelop (Games),
  PhotoCraft (Images), the music Studio and Autora 3D. Each has a server adapter of its own (`server/caddesk.ts`,
  `studio.ts`, `officedesk.ts`, `pdfdesk.ts`, `photodesk.ts`, `gamedesk.ts`; roughly 800 to 1,400 lines each) with its
  own tool family (`server/specs/*.ts`), its own change notification, its own agent "hand" for Visible work and its own
  undo. Not verified in detail: how many of them share any code for the hand protocol. Measure this first.

What the person feels: the agent and the controls behave differently per window; there is no common undo; nothing made in
one window can be referred to from another except as a file ("where work went", `lib/panacea/flows.ts`); a capability
built for one window (the 3D sculpt brush, this week) exists nowhere else.

A single literal engine for sheets, video, 3D and PDF is not the answer: their kernels (formula graph, decode and
timeline, geometry, page layout) are different hard problems and the current ones are good. The gap is the layer above them.

## Outcome wanted

One system that adapts to what is being made, with specialist kernels behind it:

1. Every kind of work exposes the same things: what is selected, what can be done to it, how a change is made, how it is
   undone, who may make it. Controls and the agent read and write through that, not through per-window code.
2. A new kind of work, or a new tool in an old one, is a registry entry plus its kernel and view, not a new adapter.
3. The agent and the person use the same commands, so Visible work is the same mechanism everywhere (CLAUDE.md: live, never a replay).
4. Work crosses windows as entities (a chart from a sheet on a slide), not only as files.
5. Creativity stays the person's: authority is in the command's schema (PANACEA-ENGINE section 4), not in a prompt.

## Who and what it touches

`src/lib/panacea/*`, `server/*desk.ts`, `server/specs/*`, `server/handbook.ts` (every window's manual), each editor's
overlay or patch, `docs/VISIBLE-WORK.md`. It touches every release-gated path in CLAUDE.md, so each step is a release.

## The shape (four shared layers, kernels stay)

1. **Entity model.** Everything made is a tree of typed entities with declared properties (document to section to block;
   sheet to range; scene to shape to mesh; timeline to track to clip). Already specified as M1. Entities carry stable ids.
2. **Command layer.** Every change is a named, typed command: arguments (JSON schema), result, inverse, and an authority
   tag (agent may apply / person only / agent proposes as a ghost). One log, written through `emitEvent()` as CLAUDE.md
   requires. Undo, replay, the history scrubber and the agent's tool list derive from it. Autora 3D's `ops.ts` (pure
   functions from a doc and arguments to a doc and a result) is the closest existing example and the proposed template.
3. **Capability registry.** Each kind declares: entity types, selection types, commands, import and export formats, and
   its view. Extends `kinds.ts` so hosted editors are registered the same way as native ones. A tool's spec and its
   manual text (`server/handbook.ts`) are generated from the same entry, so they cannot drift (the 3D spec generator
   `scripts/sync-autora-3d.mjs` already does this for one editor).
4. **Selection-bound controls** (`@sel.*`, PANACEA-ENGINE section 3): a panel written once re-binds as the selection moves.
   Touched or pinned things never move.

Kernels (formulas, geometry, decoding, page layout) and the forks stay as they are. Pins never move to follow upstream
(CLAUDE.md); anything Autora wants different is an overlay or patch.

## Constraints (CLAUDE.md)

- Every turn through `startTurn()`, every event through `emitEvent()`; new tools need schema, `runTool` case, family, test.
- Yolo default and Visible work semantics unchanged; a window that replays stays a listed gap.
- A window's UI or interface change updates its manual in `server/handbook.ts` and `tests/handbook.test.ts`.
- Tokens only for UI; per-session maps cleared in `forgetSession`.
- Creative kinds give the agent no insert or replace command (enforced by the command schema's authority tag).

## Plan

Each milestone ends with the existing tests green and a parity checklist for what it touched. Do not retire an old path
until its checklist is green (PANACEA-ENGINE M5 rule).

**P0. Measure (about a week).** Read all six desk adapters and the editors' command APIs; write a table: per editor, its
state owner, how a change arrives, its undo model, its hand protocol, what is common. Output: `docs/ENGINE-SURVEY.md`.
Decide from facts whether the command layer wraps editors (adapter) or replaces their internals. Nothing ships.

**P1. Command layer on 3D (template).** Autora 3D already has pure ops and a history. Give each op an authority tag and an
inverse, log commands through `emitEvent()`, and generate its agent spec from the registry entry. The sculpt brush becomes
a person-authority command; the agent gets none. Done when: 3D's tool list is generated, undo comes from the log, and
`tests/cad.test.ts`, `mesh-import`, `sculpt*` and the e2e 3D run unchanged.

**P2. Documents on the entity model (PANACEA-ENGINE M1).** Native documents already exist; add the operation log (steps,
not whole-document snapshots), `@sel` binds and ghost edits for suggestions. Done when: write, restructure and format in
Panacea alone, with undo from the log.

**P3. One hand protocol.** Whatever P0 finds common (claim, step, finish) becomes one shared module; each editor
implements only "perform this command by hand". Closes the gaps listed in `docs/VISIBLE-WORK.md` one window at a time.

**P4. Hosted editors register, one at a time**, in this order of value and risk: Sheets (data entities already exist
natively), Slides, PDF, Photo, Music, Video, Games. Each step: registry entry, command adapter over the existing kernel,
generated spec and manual, parity checklist.

**P5. Cross-kind entities.** Reference an entity from another window (chart from a range, image on a slide), kept in sync
through the log. This is the visible payoff and only becomes cheap after P4 reaches the editors involved.

**P6. Intent as data** (PANACEA-ENGINE M4): recipes with `when` and `next` edges, signal bus, layout regions.

## Risks

- **Adapter versus rewrite.** Wrapping editors keeps them working but leaves their internal undo; one merged stack is hard.
  Proposal: per-surface history entries linked to the common log, not one merged stack. Decide in P0.
- **Parity tail.** Word and PDF fidelity especially; the checklist decides, not a feeling.
- **Dense controls.** Panels of eight controls do not suit a mixer or timeline; docked layouts must exist before those kinds.
- **Regression across every window.** Mitigation: one editor per release, parity tests first, evals (`npm run eval -- code`)
  on any prompt or tool-list change because the tool lists will be generated.
- **Scope.** This is months. P0 and P1 are the only part worth committing to now.

## Open questions

- Does the command layer wrap each editor (adapter) or move their state into it? (P0 answers.)
- Is one shared log acceptable for large payloads (a mesh, a video edit) or do commands carry references to kernel state?
- Which window is the person's priority after 3D: Sheets (cross-kind payoff) or Documents (M1, already begun)?
- Collaboration (Yjs) is deliberately out of scope; the log is built so it can be added.

## First step

P0: a read-only survey, no code, producing `docs/ENGINE-SURVEY.md`. Then P1 on 3D.
