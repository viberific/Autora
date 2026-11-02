# Panacea, next: whole projects, a workspace that changes with the work

A plan for approval. Nothing here is built yet. It extends `docs/PANACEA-ENGINE.md` (the engine roadmap, M0 to M5) and
keeps every rule in `docs/PANACEA.md`.

## Decisions (asked 2026-11-02)

- **The first project to work end to end is an app or a website**: from the first idea to something running and handed
  over, in Panacea alone. (This is the engine plan's M2, brought forward and widened.)
- **"Morph and adapt" means all four of these**: the controls are built for whatever is being done; when no surface fits,
  the agent makes a new kind of surface; the layout changes with the phase of the work; and Panacea learns how the person
  likes each kind of work laid out.
- **Who does what follows the work**, piece by piece, not one setting. The agent does code, data and wiring in full.
  The person decides look, words and how it feels, and the agent suggests.
- **This document comes before any code.**

## Where it stands

- One scene and one camera hold the native surfaces (image, table, document, board) and every hosted engine's work
  card. There are about twenty ready-made panels per kind of work, built from small controls ("atoms"), plus panels the
  agent composes. Bespoke drafts are HTML panels running in a sandbox.
- It already learns some habits (`profile.ts`): which controls get used, which panels get waved away, which side panels go
  on, and how dense the person likes them.
- Visible work covers every native change: summoning panels, setting controls, typing documents, writing board cards,
  pasting and dropping (this branch).
- **Apps today live outside the canvas.** The app window (`AppPreview`) is a hosted card that shows the session's
  browser, with Select, Region and review comments, and a version saved per turn (`AppVersions`). Code is written with
  `edit_file` and `terminal`, and the running preview comes from `app_preview`. There is no code surface, no file tree,
  no link between a design control and the code behind it, and no database view. Dev-server output only appears in chat
  cards.

## What a complete project looks like

> "Make a booking site for my yoga studio."

1. **Plan.** A project strip appears along the top: Plan, Design, Build, Check, Ship. The agent drafts the pages and the
   data (classes, bookings) on a board in the Plan region, and asks the questions that are the person's to answer: name,
   feel, colours, the words on the home page. Those are suggestions, shown dashed, for the person to accept or change.
2. **Design.** The view moves to the Design region. The app runs live in phone and desktop frames side by side. Tapping
   the heading opens panels for its type, colour, spacing and words. Each control is bound to a design token in the
   code, so a drag changes the page at once and the code with it. The person shapes the look directly. The agent
   suggests (a ghost palette, a softer radius) and never decides.
3. **Build.** The agent writes the code in the Build region: a file tree, editors showing each change as it is made,
   and a run card with the server's log. A table surface shows the bookings database. Errors in the log link to the
   line that caused them. The person can watch, or pin the app frame and keep designing while the agent works.
4. **Check.** Comments pinned to the running page (the app window's review, now on the canvas) become the agent's
   checklist. Each fix is ticked off on the page where it was asked.
5. **Ship.** A Ship card exports the site to Artifacts and (once decided, see the questions at the end) deploys it.
   The project's notebook records what was decided, so a later chat carries on from there.

At every step the layout is the one this person had last time for this kind of project.

## The design

### 1. A project is data (the work graph)

The canvas gains a `project`: its phases, the current one, its deliverables, the decisions made, and the links between
pieces (a plan card leads to a page, the page to its component, the component to its code file). It is saved with the
canvas and summarised in the project folder's notebook (`server/projectbook.ts` already writes one).

- A new tool, `panacea_project`, plans, moves to a phase, links pieces and records a decision. Its schema goes in
  `server/specs/`, with a case in `runTool` and a test.
- On screen it is a slim strip at the top of the scene: the phase pills and the step now being worked on. It is not
  another large surface. Tapping a phase moves the view to it.
- This is the first part of the engine plan's single operation log: phase changes and decisions become entries in it.

### 2. The layout follows the phase (engine plan M4, "intent as data, layout as regions")

- The scene gets regions: Plan, Make and Check. The region for the current phase is in front, and changing phase
  glides the view there.
- Unpinned panels follow the work. Anything the person has touched or pinned never moves (the existing rule, and the
  main risk below).
- `rules.ts` stops carrying special cases per kind. A table maps (kind, phase, selection) to the panels to offer, and
  that table is what the agent and the learning both write to.
- On a phone the regions become one column with the phase strip on top, and the chat sheet stays as it is.

### 3. App surfaces (engine plan M2, widened)

New kinds in the registry (`kinds.ts`). Each is one registry entry, a view, a planner diff and a hand path (visible
work from the first day), and recipes:

| Kind | What it is | Who does it |
|---|---|---|
| `files` | The project folder as a tree. Open, rename, new file. | Both |
| `code` | One file in a CodeMirror 6 editor, as tabs. The agent's edits appear live. | The agent; the person can edit anything |
| `run` | The dev server: start and stop, a live log, errors that link to the code. | The agent |
| `app` | The running app in device frames side by side. Select, Region, comment and "try a change" come from `AppPreview`/`AppInspector`. | The person points; the agent fixes |
| `design` | Panels for the selected element (type, colour, spacing, radius, words), bound to design tokens. | **The person**; the agent only suggests, as ghosts |
| `db` | The app's SQLite database: schema, rows, a query box. Connection settings and secrets through the secret store. | The agent; the person can browse |
| `ship` | Export to Artifacts, then deployment (see the questions). | The agent, when the person says go |

The design-to-code link is a tokens file (CSS variables) that the agent writes and both read. A design control is
bound to `@app.token.<name>` and writes the token. Hot reload shows the change, and the code diff records it. This is
how "the person designs, live, beside the agent" works without anyone editing generated code by hand.

### 4. Tools for the task in hand

- **What is selected decides what appears.** An element gets design panels. A file gets Explain, Test and Format. An
  error gets Fix this, with the cause. A database table gets Filter, Add column and Sample data.
- **New atoms**, each designed once and usable on any panel: an editable table, a code snippet, a log view, a kanban
  board, a timeline, a device frame, and a colour and font picker that writes tokens.
- **Dense and docked layouts** for kinds that do not fit eight controls in a card (the engine plan's risk). They are
  needed before `run` and `db`, not after.

### 5. New kinds on demand

Today a bespoke piece is a sandboxed HTML **panel**. It becomes a sandboxed **surface** as well:

- An iframe sandbox under the existing CSP rule, with a manifest of parameters and actions, and state saved with the
  canvas.
- It talks to the canvas only by message: values in and out through the same binds that panels use.
- "Keep in library" saves it as a kind to place again on any canvas, with its own recipes.
- Sharing it with others goes through the Store's review (`docs/BACKLOG.md` §6). Until then, kept kinds are local.

Example: "track my students' attendance" makes an attendance-grid kind when nothing in the registry fits.

### 6. Learning the person's layout

`profile.ts` grows from counting controls to remembering arrangements:

- For each kind and phase, where each surface sits relative to the others, which panels were kept or put away, and how
  dense they were.
- A new project of a known kind starts from that arrangement, and a panel's "Why is this here?" says "you usually keep
  this here".
- It stays easy to correct: Reset layout, "Not like this" on any learned placement, and nothing learned from a single
  time.

### 7. Who does what follows the work

Who has the say is set per surface, the way documents and boards already do it (the agent writes, or the person
writes):

- **Code, files, run and database:** the agent does it in full.
- **Design and the words on a page:** the person decides. The agent's changes arrive as **ghost edits** (a dashed
  suggestion to take or wave away). This is the engine plan's unfinished M1 item, and it is required here.
- **The plan:** the agent drafts and the person approves.

The chat's work mode (Agent, Build, Plan) stays as it is. The split above decides how each piece is handled inside it.

### 8. Visible work stays complete

Every new kind ships with its planner diff and hand path, following this branch's pattern (`handsteps.ts`, `hand.ts`):
files opened from the tree, code shown being written, the run card's Start pressed, design controls dragged, rows
added. `docs/VISIBLE-WORK.md` gets a row for each kind as it lands.

## Milestones

Each is done when it works on a phone and a desktop, is tested, and the agent's manual (`server/handbook.ts`) describes
it.

| | What | Done when |
|---|---|---|
| **N1** | Project strip, work graph, phase regions for the kinds that exist today | A plan → make → check flow for a document project glides between regions, and nothing pinned or touched moves |
| **N2** | `files`, `code` and `run` surfaces | A static site and a Vite app are built and run in Panacea alone, with the log's errors linking to the code |
| **N3** | `app` and `design` surfaces as native kinds; tokens; ghost edits | The person restyles the running app with design controls while the agent builds; the agent's style ideas arrive as ghosts |
| **N4** | `db` surface and connections | A booking table is created, filled with sample data and browsed in the canvas |
| **N5** | Selection-driven tools and the new atoms | Element, file, error and table selections each bring the right panels |
| **N6** | Bespoke surfaces, kept as kinds | An attendance grid made on request is placed again on a new canvas |
| **N7** | Learned layouts per kind and phase | A second app project opens in the arrangement the first one ended with, and Reset layout undoes it |
| **N8** | Ship | The site is exported to Artifacts, and deployed if that is decided |

N1 comes first because every later kind lands into its regions. N2 and N3 make the first complete project possible.
N5 to N8 deepen it.

## Risks

- **A layout that moves under the person's hands is worse than none.** Touched and pinned things never move. Anything
  past the first arrangement arrives as a ghost to accept.
- **Too much on a phone screen.** Each region must work as a single column on its own; it is tested on a phone first,
  not last.
- **Hot reload and the token link are only as good as the stack.** Start with plain HTML/CSS/JS and Vite, and detect
  anything else rather than guessing.
- **Bespoke surfaces are code from the model.** They stay in a sandbox, talk only by message, and are reviewed before
  they are shared.
- **Scope.** Each milestone ships on its own, and the old app window stays until the new surfaces match it, checked
  against a written list (the engine plan's M5).

## Questions for you

1. **Code with Visible work on:** should the agent's code be *typed* into the editor at a person's pace, like documents
   now are, or should each change stream in live as a highlighted diff? Typing is truer to "watching someone at your
   PC", but slow for big files. A streamed diff is faster and still live.
2. **Ship:** is an export (a zip in Artifacts, or a folder to self-host on the Umbrel) enough for now, or should it
   deploy to a hosting provider (which needs an account and a saved key)?
3. **Default stack:** plain HTML/CSS/JS until something needs more, Vite + React from the start, or the agent's choice
   per project?
4. **The separate app window:** retire it once the `app` surface matches it (as the plan does for other windows), or
   keep both?
