# Engine survey (P0 of intent/2026-11-04-one-adaptive-engine.md)

Read-only. Written 2026-11-04 from the exports of each desk adapter, `docs/VISIBLE-WORK.md` and `docs/MODULES.md`. It
was not checked by running each editor, and the hosted editors' internal command APIs were not read in full; a row that
says "unread" is exactly that.

## Finding 1: there is already a convention, and no interface

Every hosted editor has a server adapter that exports the same family of functions under different names:

| Job | 3D `caddesk.ts` | Music `studio.ts` | Photo `photodesk.ts` | Games `gamedesk.ts` | PDF `pdfdesk.ts` | Office `officedesk.ts` |
|---|---|---|---|---|---|---|
| Is it installed | `cadAvailable` | (always) | `photoAvailable` | `gameAvailable` | (always) | (always) |
| State per chat | `cadState` | `studioState` | `photoState` | `gameState` | `deskState` | `officeState` |
| Change notification | `onCadChange` | `onStudioChange` | `onPhotoChange` | `onGameChange` | `onDeskChange` | `onOfficeChange` |
| Forget a chat | `dropCad` | `dropStudio` | `dropPhoto` | `dropGame` | `dropDesk` / `closeDesk` | `dropOfficeDesk` |
| Run an agent tool | `runCadTool` | `runStudioTool` | `runPhotoTool` | `runGameTool` | `deskHooks` (via `pdf_*`) | `officeHooks` |
| Say what is available | `cadBriefing` | `studioBriefing` | `photoBriefing` | `gameBriefing` | `deskBriefing` | `officeBriefing` |
| Panel control | `cadPanel` | `studioPanel` | (none) | `gamePanel` | (none) | (none) |
| Load a file | `loadModel` | `loadSong` | (editor) | `loadGame` | `deskDocument` | (editor) |
| HTTP routes | `cadRoutes` / `serveCad` | `studioRoutes` | `photoRoutes` / `servePhoto` | `gameRoutes` / `serveGame` | `deskRoutes` | `officeRoutes` / `serveOfficeEditors` |

Video (OpenCut) is the odd one: `server/opencut.ts` (`runVideoTool`) with its window logic in `components/OpenCutWindow.tsx`.

`server/tools.ts` imports each by name and calls each in its own branch (`runCadTool` at its case, `runStudioTool`,
`runGameTool`, ...) and builds the capability briefing by hand (`tools.ts` near line 4098: one `lines.push(...)` per editor).
So adding a kind today means touching `tools.ts` in at least three places, which is the cost the registry should remove.

## Finding 2: the hand protocol is the same idea implemented six times

With Visible work on, every editor does a change by hand while the call waits (`docs/VISIBLE-WORK.md`): `byHand` in
`caddesk.ts`, `runStudioHand` / `studioSteps`, `editByHand` + `pdfhand.ts`, `officehand.ts` (`handSteps` from before/after
files), `photo/overlay/autora.rs` `hand_*`, `byHand` in `OpenCutWindow.tsx`. The shared shape is: work out the result first,
ask the window to claim the call, plan steps from before/after, perform them, finish, fall back to a direct change if nobody is
watching. The per-editor part is only "how to perform a step with this editor's own controls". Games has no hand yet.

**Update (P3): the handshake is now one module.** `server/handshake.ts` holds the part that was copied seven times (3D, Photo,
PDF, Office, Music, Panacea, Video): offer a call with an id, push it again until a window claims it, the first claim wins
once, wait for the reply, a timeout, a failure or a cancel. Each editor keeps what is its own: the message, the reply's shape,
its routes (which call `claim` / `reply` / `fail`) and what a timeout means. The per-editor hand itself (what a window does with
a call, with its own controls) is not shared and cannot be: it is the editor's own interface. Games has no hand yet.

## Finding 3: undo is per editor, and so is the model

| Editor | Model owner | Undo |
|---|---|---|
| 3D | pure `ops` on a `Doc` (`autora-3d/src/core/ops.ts`), `settle()` after | `useHistory` in the page; the server model's history for the agent (`historyByHand`) |
| Music | `Project` in `studio.ts`; agent changes go onto the window's own undo stack | window |
| Office | the .docx/.pptx/.xlsx file, diffed before/after (`describeChange`) | the editor's |
| PDF | the PDF bytes plus a version list (`restoreVersion`) | versions, plus the editor's |
| Photo | PhotoCraft's own project (Rust, WASM) | its own |
| Video | OpenCut `EditorCore` command history | its own |
| Games | GDevelop project JSON | its own |
| Native canvas (image, data, boards, docs) | `src/lib/panacea/*` | the canvas history, which snapshots whole documents, not steps |

Only 3D has an operation layer that is already pure functions of (document, arguments), which is why it is the template.
A merged undo across all of these is not realistic; per-surface history entries tied to one command log is.

## Finding 4: contextual tools do not exist as a mechanism

Each window decides its own bar. The 3D bar used to show every tool at once (disabled ones greyed); it is now filtered by
`needed()` in `autora-3d/src/components/Rail.tsx`. PDF, Video, Photo, Music, Games and Office each have their own chrome
(`docs/TOOL-RAIL.md` covers the PDF bar and says the others follow). That is the place the capability registry's
`when(selection)` belongs; today it is a local function.

## Decision for P1 onward (adapter, not rewrite)

Wrap each editor behind one server interface (`Desk`: `available`, `state`, `onChange`, `drop`, `runTool`, `briefing`,
`routes`, optional `panel` and `hand`) and a registry, so `tools.ts` loops over desks instead of naming them. Keep the editors'
internals. Do not try to merge undo. This is a refactor with a behaviour-preserving test (the existing e2e suites), so it can
go one desk at a time.

## What is not known yet

- How much of the hand protocol's code is literally duplicated (needs a line-level read, not done).
- The Photo, Video and Games editors' internal command APIs.
- Whether the capability briefing text can be generated from registry entries without changing the models' behaviour
  (needs `npm run eval -- code` on each vendor).
