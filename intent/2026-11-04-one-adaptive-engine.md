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

## Progress

- **P0 done** (2026-11-04): `docs/ENGINE-SURVEY.md`. Decision: adapter, not rewrite.
- **Contextual tools, 3D done**: the bar shows what the moment needs (`needed()` in `autora-3d/src/components/Rail.tsx`),
  All tools lists everything. Other windows' bars still show every tool; each follows when its bar is rebuilt
  (`docs/TOOL-RAIL.md`).
- **P1, first slice done**: `server/desks.ts` registers Music, 3D, Games and Photo (state, change message, drop, briefing)
  and `server.ts` / `server/tools.ts` loop over it instead of naming each. Behaviour-preserving (e2e cad, studio, photo,
  toolload pass). Not yet: PDF, Office, Video in the registry; `runTool` cases and routes still named per desk; commands
  with inverse and authority tags; generated specs and manuals.
- **P1, command layer on 3D done**: authority per command (`person` commands are not in the agent's tool list and are refused),
  a log of every command with who/what/before/after, revert to before any command, `cad.command` events through
  `emitEvent()`, `cad_history_log` for the agent, the person's sculpt stroke as a command. Not yet: a history list in the
  window (the API exists), the log persisted across restarts (it lives with the engine), commands for the page's own edits
  beyond `person_edit` (the window still sends whole models), generated manuals.
- **P2, documents: done for what the plan named.** A step-based operation log per document with who/what and selective
  undo; ghost suggestions (rewording or removal, never new writing) accepted by the person as their own edit; the History
  and Suggestions bar in the page. Not done: tables, DOCX, the selection-bound `@sel.parent` binds beyond what `paramsFromState`
  already does, and replacing the canvas-wide Ctrl+Z snapshots with the log (they sit side by side).
  **Decision to review:** the engine plan says both "Autora proposes the person's parts as ghost edits" and "creative writing
  gets no insert or replace operation". Suggestions are limited to rewording one block (about as long as it) or removing it, so
  the agent still cannot write new prose; if you want creative documents to refuse suggestions altogether, it is one check in
  `panacea_doc`.
- **P3, shared hand protocol: done for the server side.** `server/handshake.ts` replaces seven copies of the claim/reply
  protocol (`tests/handshake.test.ts`). Not shared, by nature: what each window's hand does with a call (its own controls), and
  the page-side half of the handshake in each editor's frame (claim, run, reply), which lives inside the editors' own code
  (`autora-3d/src/agentHand.ts`, `spectra-editor/src/autora/hand.ts`, `office/shim/hand.js`, `src/components/studio/hand.ts`...).
  Games still has no hand. Next would be a shared page-side client, which means touching each fork's overlay.
- **P4, registry and parity matrix: done; per-editor command layers: not done.** `server/capabilities.ts` is one table of the
  seven hosted editors (prefix, name, engine, workspace modes, Tools page switches, formats opened and saved, Visible-work
  status). `windowOff` (tools.ts) and `manualId` / the manual headers (handbook.ts) now read it instead of a chain of prefix
  checks, and `tests/capabilities.test.ts` holds every other table to it: the tool families, `loadable()`, the manuals'
  mention of what each editor saves, `docs/VISIBLE-WORK.md`, the workspace modes and the desks. It found one real gap on its
  first run (the Video manual never said export is MP4 or WebM), fixed. What P4 as written also asks is not done: a command
  layer per editor like 3D's (authority, log, revert) for Sheets, Slides, PDF, Photo, Music, Video and Games. Each of those is
  its own piece of work against that editor's own command API, in the order the plan gives (Sheets first), and none was
  started here. The desks registry (`server/desks.ts`) still covers only Music, 3D, Games and Photo; PDF, Office and Video join it
  when their state and briefing fit the same interface.
- **Controls that follow the work and fade into the ground (the objective, after P4).** The shared rail now has `needed` on each
  tool and `useFading`: a tool the work has nothing for is off the bar, fades out in place, and fades back in when it has
  something to act on; All tools still lists it with what it needs. Music, Games and 3D use it (3D's rail is its own copy,
  `docs/autora-3d-fade.patch`); a browser test (`tests/ui-studio.test.ts`) holds Music's behaviour. Not yet: the PDF (Spectra's
  own rail), Video, Photo and the Office windows still show every tool at once; Games' behaviour is typechecked but not
  driven in a browser here (its editor is not built in this container). Beyond the bar: the native Panacea panels already
  appear with the selection and fade away; extending `needed` from "what is picked" to "what the person seems to be doing"
  (the intent bus, P6) is where proactivity goes next.
- **P5 and P6**: not started. Each is a separate piece of work with its own parity checklist; they are months, not a session.
