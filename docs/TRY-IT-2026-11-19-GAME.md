# Panacea, tried as someone who has never made a game (2026-11-19, 0.9.377)

For: usability review. The brief: act as a first-timer, open Panacea, work out where to start, and end up with a simple game
with mobile controls where you shoot balls to break a piece of glass. Evidence is in `docs/screenshots/try-2026-11-19-game/`;
the finished game's source is in `docs/examples/break-the-glass/`.

## How this was done, and what it can and cannot tell you

- A real browser (Chromium, desktop and an iPhone 13 profile with touch), the real server, and the real Games editor
  (GDevelop, built for this: `npm --prefix gdevelop-editor ci && npm --prefix gdevelop-editor run build`).
- **No model key was available here.** So two paths were tried: (1) *by hand*, as a person with no model would, and (2) *with
  the agent*, using a small stand-in model that returns tool calls I wrote (`docs/examples/break-the-glass/fakellm.cjs`).
  Autora's agent loop, tools, thread and windows all ran for real; **what a real model would have decided was not tested**.
  Findings about the agent are about the *tools and the window*, not about how well a model drives them.
- Priority: **P1** a first-timer stops or is sent the wrong way; **P2** costs minutes or confuses; **P3** polish.

## The result

A portrait game for a phone: ◀ ▶ slide a cannon, a big FIRE button shoots (hold it to repeat), a pane in a wooden frame slides
side to side, faster after each hit. Six hits: it cracks at two, cracks more at four, shatters at six into 46 shards, then
"You broke it!" and a "Play again" button. Arrow keys and Space work on a computer. **Played on a phone profile with real
touches, start to shatter to restart: it works** (`10-phone-playthrough.jpg`). It took several rounds to get right; the two
things that went wrong are findings below (F8, F9).

## What a first-timer meets, in order

| # | Pri | Finding | Evidence / reproduce |
|---|---|---|---|
| F1 | P1 | **The first screen says "Connect a model to start..." and gives no way to.** It is a placeholder, not a link. The ✦ button beside it looks like a model picker but chooses Build / Plan / Agent. The real place (Settings → "Add an API key") is found by guessing. | `01-first-screen.jpg`, `04-sparkle-is-work-mode.jpg`. A first-run card or a placeholder that is a button to Settings. |
| F2 | P1 | **Without a model, "make a game" has no soft path.** What is left is GDevelop's own editor: *Add object → Sprite → "Edit NewSprite" → Animation #0 → Add a sprite*. A ball needs a picture, the picture needs a file, and there is none to pick (see F3). Words like animation, sprite, instance, events appear with no explanation. | `05`, `06`, `07`. I stopped here by hand. |
| F3 | P1 | **There is no art.** GDevelop's asset store is refused by design, so nothing is offered. The agent's `game_import` can only make flat "placeholder" rectangles and circles; a pane of glass, a cracked pane, a shard, a cannon had to be drawn by a script I wrote. For anyone who is not an artist this is the biggest wall. | A small bundled CC0 starter pack (balls, panes, buttons, arrows) the agent and the Add object dialog can offer, or a few more placeholder shapes (rounded rect with a frame, triangle, arrow, gradient). |
| F4 | P1 | **Typing on the canvas sends you away.** Click the empty canvas and type "make me a game": at the **k** you are on the Mind page (bare `k` toggles Mind, bare `v` toggles voice). Nothing says why. | `App.tsx` key handler (`case "k"`, `case "v"`). Typing with no field focused should focus the message box and keep the letters; keep shortcuts behind a modifier. |
| F5 | P2 | **The capability list has no Game, with no explanation, when the editor is not installed** (by design: no tile for an app that is not installed). A person who has heard "Panacea makes games" sees seven tiles and none is it. | `02-capabilities-no-game.jpg`. Fine on a full install; worth one line ("Games is not installed on this server") if the person asks for one. |
| F6 | P2 | **Double-clicking the canvas offers Photo sliders** ("Light, Colour, Looks, Crop...") under "What do you need?" Nothing about a game, a song, a model. | `03-double-click-menu.jpg` |
| F7 | P1 (phone) | **On a phone the Games card is a thumbnail.** It opens about a third of the screen wide at the top left, with the editor's toolbar over the bottom of the game (FIRE and the arrows are partly hidden), and the chat takes the rest. You must find "Maximise" to play. On a desktop it opens ~600 x 430 with tiny text. The title-bar icons are about 10 px and unlabelled: I opened "Send to 3D" instead of Maximise. | `09-panacea-on-a-phone.jpg`. A game just made for a phone should open large, or "Play full screen" should be the obvious button under it. |

## What the agent's tools do to a first game (stand-in model)

| # | Pri | Finding | Evidence / reproduce |
|---|---|---|---|
| F8 | **P1** | **`game_check` says "Nothing looks wrong" about a game whose controls cannot work.** "Key pressed (text)" and "Touch or mouse button is down (text)" take a *string expression*: `"Left"` with quotes. Written as `Left` the event is accepted, checked, saved, and **never fires**: no touch, mouse or key moved anything, though the engine saw the key (`isKeyPressed` was true). It took probing the running game to find. | Reproduce: `KeyFromTextPressed ["", "Left"]` vs `["", "\"Left\""]`. The checker should flag an unquoted keyboard-key / mouse-button parameter, and `game_catalog` / `game_template condition` should show a quoted example. (The repo's own test, `tests/game.test.ts`, writes it unquoted.) |
| F9 | P2 | **A Sprite with three pictures plays them as an animation and stops on the last**, so the pane started fully cracked. `game_template animation` defaults `timeBetweenFrames` to 0.08 and says nothing about holding a frame. It only showed in a play-test picture. | Give the template a "hold" note (a very large `timeBetweenFrames`, or pause) when frames are meant to be set by the game. |
| F10 | P2 | **Hidden-at-start UI clutters the editor.** I first placed "You broke it!" and "Play again" in the scene and hid them when it begins: the editor's design view then shows them on top of the pane. Creating them at the moment of the win is cleaner. | Agent guidance in the Games manual. |
| F11 | P3 | A leave-the-page dialog appeared when I reloaded with the Games editor open (seen once, in an automated browser). | |

## What works well (keep it)

- **The agent's work reads clearly in the thread**: a to-do list ("4 of 5 done"), "switch to build · plan is on the list",
  "Making 42 changes", "Game import 10 steps", and the window opening beside it with the game in the editor.
- **`game_check` is precise about shape.** It spelled out the slot list each instruction needs ("IsCursorOnObject takes 4
  parameters, this has 3 ... [<Object>, "", <Accurate test...>, ""]"), which let me fix every one at once. The catalog's
  slot counts made it easy to pad every instruction automatically.
- **The play-test is a real play-test**: `game_play` ran the game headless and returned pictures, and its error for a bad key
  name ("hold is 1 to 4 keys ... ArrowLeft, ...") was exactly what was needed.
- The editor is Autora-dressed, the Objects list is clean, and the game window persists across reloads.
- The finished game plays correctly under touch on a phone profile, restarts cleanly, and works from the keyboard too.

## Suggested order

1. F8 (a checker rule and a catalog example: it makes every agent-made game with keys or touch silently dead).
2. F1 + F4 (the first minute: a way to connect, and no shortcuts stealing a newcomer's typing).
3. F3 (art: the one thing a first-timer cannot make).
4. F7 (a phone-made game should open playable).
5. F9, F10 as Games-manual notes; F5, F6, F2 afterwards.

## Not covered

A real model driving the tools (its choices, its questions to the person, how it recovers from F8); sound; Visible work with
the game window; a real phone (an iPhone 13 profile with touch events was used, not a device).
