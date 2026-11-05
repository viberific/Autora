# A first-time maker starts a game with an idea and is playing it in minutes

Status: preliminary. Written 2026-11-05 at the end of a long session, for the next agent. Nothing here has been tried against
the real GDevelop editor: it is not built in the container this was written in (GitHub is blocked there, so none of the
upstream editors can be fetched). Read "What I could not verify" before trusting any of it.

## Problem

The Games window is GDevelop's whole editor beside the chat, with a tool bar over it. It was added the way the other
embedded editors were: wrap the fork, give the agent tools for its project file. That fits a person who already knows what a
scene, an object, a behaviour and an events sheet are. It does not fit the person this product is for. The person said:

> It needs to be intuitive and follow the same "there when you need it, gone when you don't" idea. It should be possible for
> someone who has never made a game to sit down with an idea and start making it immediately. That's what I mean by
> removing barriers.

GDevelop's central idea, the events sheet, is visual programming. A first-timer should not meet it before something plays.

## Outcome wanted: the five-minute path

Write this down as the acceptance test and try it with someone who has never made a game:

1. They say an idea in the chat ("a ship that dodges asteroids"). No game vocabulary.
2. Within about a minute there is something playable on screen: a template for the genre, placeholder art, the controls
   working. They press Play (or the agent has already started it, and they are watching).
3. The agent has played it itself first (`game_play`) and says what it saw, and asks how it feels. It does not say it is right.
4. They say what feels wrong in their own words ("too slippery", "jump higher"). The matching control appears, set by the
   agent, with every value left where they can change it by hand, and goes away when they move on.
5. The editor (GDevelop) is available on request ("open the full editor") and stays shut until then.

Success is a person finishing step 4 without being told a single GDevelop word.

## What exists today (so you do not rebuild it)

- `server/gamedesk.ts` (1.4k lines): the game as GDevelop's project JSON, kept per chat; the `game_*` tools (`game_open`,
  `game_look`, `game_edit` by path, `game_check`, `game_catalog` over the engine's own actions/conditions, `game_template`,
  `game_import`); the preview files the editor sends (kept in memory, served sandboxed); routes.
- **`game_play` (0.9.350, new): the agent can play its game.** `server/gameplay.ts` runs a copy of the preview in an isolated
  headless Chromium (`withBrowserContext`, no network) with a script of press/hold/wait/click/shot and returns pictures, the
  errors the game threw, frames drawn, and whether the screen changed. To get a fresh preview it asks the window to press its
  own Play (`gamedesk.play` ephemeral message -> `src/lib/gamedesk.ts` -> `GameWindow` -> rail `restart`), so the person
  watches it start. Tested with a real browser and a toy canvas game (`tests/gameplay.test.ts`, `tests/gameplay-tool.test.ts`).
- **The verbs-to-settings layer already exists for movement.** `src/lib/panacea/apps/game.ts`: `game.speed`, `game.jump`,
  `game.gravity`, `game.friction` act on the platformer (or top-down) behaviour of the picked object; "slippery" is the
  behaviour's deceleration. `gamePanel` in `gamedesk.ts` applies them. Panels for the rest (`game.tiles`, `enemy`, `aggro`,
  `items`, `lines`, `powers`, `win`, `limit`) hold the person's choices for the agent to build (see `docs/PANACEA-GAPS.md`).
  I wrongly proposed building this layer earlier in the session; it is there. It is untested against the real editor.
- The window: `src/components/GameWindow.tsx`, `src/components/game/GameRail.tsx` (first-game suggestions such as "Make my player
  jump", a bar that shows only what the moment needs, Play first), and the editor overlay in
  `gdevelop-editor/overlay/newIDE/app/src/Autora/rail.js` (GDevelop's tab strip, toolbar, Share and Home are hidden).
- The Panacea chooser has a "Games – A new game" entry (`PanaceaWindow`), so there is a no-chat way in.
- Manual for the agent: `GAME` in `server/handbook.ts`. Tool-family rules: `server/toolload.ts`, `server/capabilities.ts`.

## Decisions already made (do not reopen without the person)

- **No command log for Games.** The other editors got one (Sheets, Slides, Pages, PDF, Music, Video, Photo: see
  `intent/2026-11-04-one-adaptive-engine.md`). For Games it would harden the layer a beginner should not be looking at.
  The gap that mattered was that the agent built blind, which is why `game_play` came first.
- **No second engine.** GDevelop stays the runtime and exporter (`docs/BACKLOG.md` item 3). What changes is what the person sees.
- **Creativity stays theirs (CLAUDE.md, "Games and 3D").** The agent does the plumbing (input, collisions, score, camera, menus,
  export). The idea, story, characters, world, look and feel are the person's; it asks, suggests, explains. Enforce by what
  tools exist, not by prompt. A guided listing's tool set must not write the person's creative work.
- **Pins never move** (`gdevelop/PIN.json`). Anything different is an overlay or patch in `gdevelop-editor/`.

## Proposed work, in the order I would take it

1. **Try it for real first.** Build the editors somewhere with network (`npm run build`), open Games, and run the five-minute
   path yourself with a real model. Everything below is guesswork until someone has seen the real first run. Write what you
   see in `docs/improvements/` as you go.
2. **Run `game_play` against a real GDevelop game.** Unknown: whether GDevelop's runtime hears keys sent to the page without a
   click on its canvas (the toy game does; GDevelop listens on its own canvas/document and may need focus); how long the
   engine takes to start (`BOOT_MS` in `server/gameplay.ts` is 1.5 s, a guess); whether the preview's entry page is the one
   `latestPreview()` picks. Fix `gameplay.ts` from what you see. Add a test that plays a real exported GDevelop game if one can be made.
3. **Art and sound for someone with none.** I expect this to stop a beginner before the logic does. Options, not decided:
   placeholder shapes the agent can draw itself; `image_generate` for sprites (the person approves the look); a small bundled
   set of CC0 sprites and sounds (licensing must be checked and recorded); simple generated tones for sound. The look is the
   person's choice, so the agent offers and they pick.
4. **A scaffold that is playable in a minute.** `game_template` gives shapes to copy; a first-time idea should map to a genre
   template (platformer, top-down, shooter, runner) with working controls and a win/lose loop, built by the agent, then
   played with `game_play`. Decide whether this is one new tool or a skill/recipe; measure with `npm run eval -- code`
   (cost per finished task) on every vendor touched.
5. **Make the beginner surface the Panacea panels, not the GDevelop editor.** The movement controls and the first-game
   suggestions exist; extend what they cover (enemy, win/lose, items) only as the person's choices the agent builds from.
   The full editor opens on request. Today it is the first thing a user sees: change that default, and keep it easy to correct.
6. **What `game_play` could add**, once it works on the real runtime: reading simple facts out of the running game (object
   positions, score) instead of only pictures, several short runs in one call, speeding up time for a long test. The agent
   still cannot hear or feel the game: it must keep asking the person how it plays.
7. **A live hand for Games** (it has none; `docs/VISIBLE-WORK.md`, `docs/PANACEA-GAPS.md`). Not needed for the five-minute path,
   so it comes last. The server side of the hand protocol is shared (`server/handshake.ts`); the page side lives in the fork's
   overlay.

## Constraints (CLAUDE.md)

Every turn through `startTurn()`, every event through `emitEvent()`; a new tool needs schema in `server/specs/`, a `runTool`
case, a family, and a test; a window's UI change changes its manual in `server/handbook.ts` and `tests/handbook.test.ts`;
tokens only for UI (`docs/DESIGN.md`); release-gated paths need a version bump and `releaseNotes`; Yolo default, Visible
work semantics unchanged (a window that replays stays a listed gap in `docs/VISIBLE-WORK.md`).

## What I could not verify

- Anything about GDevelop itself: not built here. `game.test.ts` and `e2e-game.test.ts` fail in that container for exactly
  that reason ("the editor is not built"), before and after this work.
- `game_play` against GDevelop's real preview and runtime (see step 2); the window-side press of Play (typechecked only).
- The real first-run experience, on a desktop or a phone. On a phone the other windows were postage stamps in the corner
  (see `docs/TRY-IT-2026-11-05.md`); I have no reason to think Games differs.
- Whether a real model, given the manual and tools, builds a sensible game. A scripted model was used everywhere.

## Open questions

- Is the full GDevelop editor ever the right first screen for anyone, or always on request? (I think always on request.)
- Where does a first-timer's art come from, and who owns the licensing decision?
- One scaffold tool, or a recipe the agent follows? Which is cheaper per finished task (needs the eval)?
- Should the agent start Play itself on every change, or only when asked? Starting it for the person to watch is the intent,
  but it takes over their window; check how that feels.
- How does "gone when you don't need it" apply to the editor itself on a small screen?
