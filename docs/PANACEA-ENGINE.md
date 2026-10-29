# Panacea's engine: the plan

`docs/PANACEA.md` is what Panacea is today (a canvas of controls around an image or a table). This page is where it goes:
**one engine that morphs to whatever is being made, and in time replaces the separate tools.** Decisions below were made
with the person who asked for it (2026-10-29); where they said "use your judgement", the reasoning is written down here
so it can be argued with.

## Decisions

- **Native, not wrapped.** Panacea grows its own engines. It does not embed OpenCut, GenOffice, Spectra or GDevelop. It
  reuses well-kept libraries for the hard, solved parts (text editing, code editing) and owns the model above them.
- **Order:** documents and code first, then images (what exists, grown into layers), data (exists), video later.
- **Who decides what** (the core principle in `CLAUDE.md`): productivity and proactivity are Autora's; creativity is the
  person's. The engine carries this in its schema (below), not in a prompt rule.
- **The layout may shift.** Floating cards stay; docked regions (side inspector, outline, bottom dock, focus mode) join.
  One absolute rule: **nothing the person is touching or has pinned ever moves.**
- **Per person**, not shared: the learned library and profile. Sharing (the Store) is revisited later.
- **Parity, then retire.** Each existing tool gets a checklist of what people actually do in it. When Panacea's surface
  covers the list, that tool's window is removed. Not before.

## What is wrong with the shape today

Panacea composes controls over a flat list of named parameters, for two hard-coded kinds (`"image" | "data"`, branched on at
about 30 places). That cannot express documents (a tree of blocks), code (files and symbols) or layers. It also cannot make
a panel follow what the person selects. Intent is six `if`s in `rules.ts`, and the learned profile measures skill only on
photo parameters, so a data-only user never gets denser panels.

## The design

### 1. Surface kinds are a registry (M0)
A kind is one entry in `src/lib/panacea/kinds.ts`: its parameters and actions, its starter panels, what it offers when a
value goes somewhere telling, how it is drawn into words for the agent, its default size and its library domain. Everything
that used to say `kind === "image"` asks the registry. Adding a kind means adding an entry; the compiler then names every
place (a view in the window, an adapter on the server) that still has to learn about it.

### 2. A work graph and one operation log (M1, built with documents)
Everything made on a surface is a tree of typed **entities** (document → section → block; workspace → file → symbol;
canvas → layer; later timeline → track → clip). Each entity type declares its properties with the same `ParamSpec`
panels already bind to. Every change is an **operation** on that tree, made by the person, the agent or a rule through the
same path. That gives undo, redo, the history scrubber, replay and (later) collaboration for free, and matches "the event
log is the product" (`README.md`).

It is designed with the document surface, not before it: a tree model drawn without a second real case is guessing.

### 3. Binds that follow the selection (M1)
`@sel.fontSize`, `@sel.parent.columns`. A panel written once re-binds as the selection moves: paragraph controls on a
paragraph, table controls on a table, gone when nothing it fits is selected. This is the morphing, and it is one mechanism
rather than a pile of special cases.

### 4. Authority in the schema, ghost edits for the creative parts (M1)
Each operation type carries who may apply it. **Autora's:** reformat, table of contents, citations, rename across files,
fix imports, wire things up. Applied directly, undoable. **The person's:** prose, design decisions, architecture. Autora
*proposes* these as **ghost edits**: dashed inline diffs with a reason, accepted or waved away (the ghost panels, extended).
Creative writing gets no insert or replace operation for the agent at all, as `CLAUDE.md` already requires.

### 5. Intent as data, layout as regions (M4)
Recipes carry `when` conditions and `next` edges instead of code in `rules.ts`; a signal bus (selection, focus, value
changes, file type, dwell) feeds a cheap local scorer; the model is for what the scorer does not know. Intent picks a
layout region. The profile becomes per kind and decays.

## Choices of parts (checked 2026-10-29)

| Job | Choice | Why |
|---|---|---|
| Document model and view | **ProseMirror** (MIT, active) | Its schema is a typed tree with attributes, and its steps are invertible operations: the work graph and the log for documents, already built. Tiptap is a convenience layer over it that Panacea does not need; Lexical is a fine editor but its model fits a shared operation log less well. |
| Code view | **CodeMirror 6** (MIT, active) | Light, modular, good on phones; Monaco is heavy. |
| Word files | Boundary only, best effort first | Autora's `.docx` fidelity lives in the pinned GenOffice fork. Panacea's own format comes first; `.docx` and PDF export follow, and "lossless Word round trip" is an explicit non-goal for v1. |
| Collaboration | **Yjs** (MIT), later | Not needed per person; the operation log is built so it can be added. |

## Code and design in one place

The wish: click *design* and see the front end and the code behind it at once. The honest version in stages:

1. A **design view** (the running page, with design tokens and component settings as panel controls) beside a **code view**
   of the same files, linked by file and symbol. Change a colour token and both move.
2. Click an element, jump to its source. This needs the build to stamp elements with where they came from; it is a build
   change, not a UI one, and comes after stage 1 proves out.
3. Two-way editing (drag in the design, the code changes) only for the parts that map cleanly.

The agent keeps the code and the back end in the background, per `CLAUDE.md`'s rule for building an app; the person edits
the design directly.

## Status

- **M0 done** (kinds registry). **M1 begun: documents** (`docs/PANACEA.md`, "Documents"): the native model, the editor, panels that
  follow the selection, the authority split enforced in `panacea_doc`, import by drop or Load, Markdown export. Not yet in M1:
  suggested edits as ghosts (a guided document can only be formatted, not rewritten, so there is no path yet for Autora to
  *suggest* a rewording), an operation log of steps (the canvas history snapshots whole documents instead), tables, DOCX.
- Found on the way: the board's two "pan into view" effects overshot when an agent added a surface and its panels together
  (they measured mid-glide); fixed, and it would have hit tables too.

## Milestones

| | What | Done when |
|---|---|---|
| **M0** | Surface registry; no behaviour change | Existing Panacea tests pass untouched; adding a kind is one entry plus a view |
| **M1** | Documents: entity tree, operation log, `@sel` binds, ghost edits, ProseMirror view, export | Write, restructure and format a document in Panacea alone |
| **M2** | Code: workspace, file tree, CodeMirror, run and preview, symbols as entities, design/code linked | Build and run a small app in Panacea alone |
| **M3** | Images: the image surface becomes layers | Layered edit and export |
| **M4** | Intent as data; layout regions | `rules.ts` holds no per-kind `if`s |
| **M5** | Parity matrix per tool, retire at parity | Each retired tool's checklist is green |

## Risks

- **Morphing that moves under the hands is worse than no morphing.** Hence the rule that touched and pinned things never
  move, and that anything beyond the first panels arrives as a ghost to accept.
- **Parity is a long tail** (Word and PDF fidelity especially). The checklist, not a feeling, decides when a tool goes.
- **Eight controls per panel** suits photo and data, not a mixer or timeline. Dense and docked layouts are needed before
  those kinds, not after.
- **Surface state is still two fields on one type** (`table`, `px`). Entities replace them in M1; M0 leaves them be.
