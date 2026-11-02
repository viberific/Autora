# Panacea G1: handoff (start here)

Where G1 of `docs/PANACEA-GAPS.md` stands, and exactly how to finish it. G0 is done; G1 is next. Written so a fresh
session can pick it up without the conversation that produced it.

## Status of the whole plan (2026-11-02)

| Step | Status | What remains |
|---|---|---|
| G0 Make it honest | **Done** (0.9.321, 0.9.322) | — |
| G1 Engine panels drive the engines | **Music (0.9.323) and 3D (0.9.324) done** | Video, Game, each its own release |
| G2 Windows the agent can lay out | Not started | see the plan |
| G7 Verified where it runs | Not started | needs CI or the Docker image |
| G3 Full native surfaces (full spreadsheet first) | Not started | see the plan |
| G5 Projects finished | Not started | see the plan |
| G4 Visible work, complete | Not started | Games first |
| G6 Whole apps and sites (N2–N8) | Not started | `docs/PANACEA-NEXT.md` |

The order and the "done when" of every step are in `docs/PANACEA-GAPS.md`, "The plan". Decisions the person made:

- Panels whose controls change nothing are **hidden** until wired (G0 did this: `src/lib/panacea/wiring.ts`).
- The native table becomes a **full spreadsheet**, with the same design: a control is there when it is needed, gone when
  not, and offered before it is asked for.
- **Everything** in the plan is to be done, polished, with nothing broken.

## How G0 left things

- `src/lib/panacea/wiring.ts`: a bind named for an app (`music.`, `video.`, `model.`, `game.`, `ui.`, `doc.`) is live
  only when listed in `WIRED`. `treeLive(tree)` filters the picker (`PanaceaWindow`), the rules (`rules.ts`, `LIVE`) and
  the agent (`allRecipes()` and `panacea_place` in `server/panacea.ts`). A panel already on a canvas that is not live
  shows a note and an inert body (`PanelCard.tsx`); `describeCanvas` flags it.
- So wiring an app = an adapter that acts on its binds, then adding them to `WIRED`. `tests/panacea.test.ts` already
  fails if an offered recipe has an unwired bind.

## Music: done (0.9.323), and the shape to repeat

The code is in the tree, not here any more: `src/lib/panacea/apps/music.ts` (the pure adapter, shared by server and
page), `src/components/panacea/useAppValues.ts` (the page reads the song and sends changes 120 ms apart), `studioPanel`
and `studioSong` in `server/studio.ts` with `POST /api/studio/:session/panel`, `setChecked` in `server/panacea.ts` (the
agent's `panacea_set` and `panacea_place` values go to the song), `appValue` in `describeCanvas`, and the Music recipes in
`src/lib/panacea/library.ts` (each wired or removed). Tests: `tests/panacea-music.test.ts` and
`tests/ui-panacea-music.test.ts`. Things found on the way, for the next engine:

- A recipe option source (`"tracks"`) must be added to `readOptions` in `src/lib/panacea/recipe.ts` or the rulebook
  refuses the whole panel; the page bundle has its own copy, so rebuild before a browser test.
- A person's change goes in as `commit(..., "agent")` with `e.quiet = e.rev + 1` set first, so the window reloads
  without lighting up and Follow does not jump the camera.
- The Music window opens partly off the board's screen (window layout is G2), so the browser test presses its controls
  with `dispatchEvent("click")`.

## After Music

- **3D: done (0.9.324)**, the same shape as Music: `src/lib/panacea/apps/model.ts` (pure: reads the model's bodies, and
  turns a value into the modeller's own `shape_*` / `edge_bevel` / `repeat_set` calls on the part picked in the panel's
  Part list), `cadPanel` / `cadModel` in `server/caddesk.ts`, `POST /api/cad/:session/panel`, `applyModelValues` in
  `server/panacea.ts` (async, so it runs before the sync `edit`). The modeller has no absolute rotation, light, camera,
  environment, render quality or printer path, so those panels are deleted. Tests: `tests/panacea-model.test.ts`,
  `tests/ui-panacea-model.test.ts`. A browser test needs `npm --prefix autora-3d ci` and a build of it.
- **Video** (OpenCut commands, `src/components/OpenCutWindow.tsx`): speed, volume, fades, title, aspect, grade, export.
- **Game** (the GDevelop bridge): needs the game editor built to test; movement, physics, health, camera.
- Each engine: wired or deleted, read back from the engine, and set by hand in the engine's own window with Visible
  work on. Each one its own release.

## Things learned in this session that will save time

- Browser tests need `AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` here; without it they
  print "skip" and look green.
- `npx vite build` empties `dist/`, which drops the 3D modeller: run `npm --prefix autora-3d run build` after it, or the
  `ui-cad-*` tests skip.
- The e2e harness runs `server.ts` from source: do not edit `server/` while a browser suite is running.
- With Visible work on, making a document by hand also places three panels by hand; such a turn takes about 25 s, so a
  test needs `app.turn(..., 90_000)`.
- The agent's briefing budget (`tests/toolbudget.test.ts`, 28,000 chars) grows with each built editor; it is about
  27,000 with the modeller built.
