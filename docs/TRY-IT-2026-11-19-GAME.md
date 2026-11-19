# Panacea, tried as someone who has never made a game (2026-11-19, 0.9.377)

Two parts: **part 1** the game in 2D (below), **part 2** the same game in 3D (after "Not covered").

For: usability review. The brief: act as a first-timer, open Panacea, work out where to start, and end up with a simple game
with mobile controls where you shoot balls to break a piece of glass. Evidence is in `docs/screenshots/try-2026-11-19-game/`;
the finished game's source is in `docs/examples/break-the-glass/`.

## Status (fixes made after both parts, same branch)

Fixed, with tests (`tests/overlap.test.ts`, `tests/panacea-rest.test.ts`, `tests/game.test.ts`, `tests/game-physics.test.ts`,
`tests/sculpt.test.ts`, `tests/ui-typing.test.ts`, the Games and 3D manuals in `server/handbook.ts` and `tests/handbook.test.ts`):

| Finding | What changed |
|---|---|
| F1 | With no model connected, the message box shows a "Connect a model" button that opens Settings |
| F3 (part) | `game_import` placeholders: rounded, triangle, ring, arrow (any direction), a shaded ball and a shaded button, besides rect and circle. Bundled art for a whole game is not done |
| F4 | A letter with nothing focused goes to the message box; Mind and voice are Alt+K and Alt+V |
| F8 | `game_check` flags an unquoted key, mouse button, layer or scene; the condition template shows the quoted form |
| F9 | The animation template says how to hold a frame (`timeBetweenFrames` 100000, then `ChangeSprite`) |
| F10, F18 (text) | Games manual: create what appears later instead of hiding it; the camera runs every frame |
| F12 (part) | The 3D tile says "Shape things; send them to a game". A start-a-game path from the 3D window is not done |
| F13 | `Sphere` in the Shapes menu and as `shape_add kind sphere` (a true ball) |
| F14 (part) | The Visible work switch says what watching costs; the 3D manual tells the agent the pace, the ids and to suggest turning it off for a big build. The default is unchanged (a product decision) |
| F15 | `game_from_model` reads the 3D model, so it waits for the call that makes it (`server/overlap.ts`) |
| F16 | A step the app held back reads "Not run: ..." in the thread, not "Making 35 changes" |
| F17 | `game_from_model` gives the base layer an ambient light and a sun when it has none, and says so |
| F18 | `game_template camera-3d`: a camera event that runs every frame, placed then aimed, with the right slots |
| F19 | `game_check` flags a value in an internal slot (a parameter list that starts at 1 has `""` at 0) |

Still open, and why:
- **F2** (the by-hand route is GDevelop's own vocabulary), **F5/F6** (capability and double-click menus offer nothing about games),
  **F7** (the Games card on a phone opens small), **F11** (a leave-the-page dialog): design work, not a one-line fix.
- **F14** default: Visible work stays on for a new person; asking first for a big build, or building fast and replaying it, is a decision for the person who owns that behaviour.
- **F20** (the editor's scene view does not show the 3D camera), **F21** (Play does not refresh a running game), **F22** (a mesh's
  card shows a cube): each is in the editor or the 3D list and needs its own change.
- **Not fixed here:** `tests/ui-game.test.ts` "the agent's next edit lands in the open editor" fails in this sandbox on the code as
  it was before this session as well (the dog is never listed); it is not caused by these changes.

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


---

# Part 2: the same game, in 3D

Same persona, same challenge: a first-timer wants a game where you shoot balls at a window to break it, with phone controls,
this time in 3D. Evidence: `docs/screenshots/try-2026-11-19-game-3d/`; the finished game's source:
`docs/examples/break-the-glass-3d/`. Same method and same limits as part 1 (real browser and server, a scripted stand-in model,
no model key, an iPhone 13 touch profile); IDs continue from part 1 (F12 onward).

## The result

An over-the-shoulder 3D view: a window in a wooden frame stands at the end of a floor, a cannon in front slides with the arrow
buttons, FIRE shoots balls that are real physics bodies. Two hits crack the glass, four crack it a lot, six shatter it into 44
pieces that fall and settle on the floor, then "You broke it!" and "Play again". **Played on a phone profile with real touches,
start to shatter to restart: it works** (`10-phone-playthrough.jpg`). The glass, the cracks, the cannon, the ball and the shards
were all modelled in Autora 3D with its own tools (54 calls; the cracks are thin cuts made with `cad_shapes_subtract`) and sent to
the game with `game_from_model`, which kept their colours and see-through glass and gave them physics (static window and floor,
a bouncy ball, falling shards). The buttons and text are flat pictures on a second, 2D layer over the 3D one.

## What a first-timer meets

| # | Pri | Finding | Evidence / reproduce |
|---|---|---|---|
| F12 | P1 | **There is no way to start a 3D game from the 3D tile.** "3D: A block to shape" opens a modeller with one grey block; nothing says it is not a game, or how a model becomes one. The bridge exists, but it is under **Export & file** ("Just looks / Falls / Stays put / Send to the game"), after you know to look for it, and only works once a Games window exists. | `01`, `04` |
| F13 | P1 | **No Sphere.** A ball is the first thing this game needs and Shapes offers Box, Rounded box, Cylinder, Triangle, Wedge, Pentagon, Hexagon, Octagon, Star. By hand the best a newcomer can do is a Cylinder with every edge rounded (the bevel stops at 17 of the 20 mm needed): a slightly flat-sided puck, and only if they know that trick. The agent can make a true sphere (`cad_sculpt_blend`); the person cannot. | `02`, `03` |
| F14 | P1 | **Visible work is on for a new person, and it makes the agent build at a human's pace.** With it on, the agent typed each shape's size into the window's fields with a cursor: 17 shapes took over 4 minutes, so the 54-shape model would take well over 15. The switch is the eye icon in the header, with no label. With it off the same 54 calls took seconds. By hand the window also names shapes `body_1795101618192_992`, not `body_2`, so an agent that predicts the next id fails (two calls did). | `05`; `PATCH /api/agent-cursor {"on":false}` |
| F15 | **P1** | **Two dependent calls run at the same time.** The runtime ran `cad_sculpt_blend` and `game_from_model` together ("2 calls checked for overlap and run at the same time"), so the send failed with "The 3D model has nothing visible to send". A model that makes a ball and sends it in one response, the natural thing, hits this. | Put both in one reply. `game_from_model` reads the 3D model, so it conflicts with every `cad_*` write. |
| F16 | **P1** | **A follow-up request starts in planning again, and the held edits look like work done.** Every turn starts in planning ("Every turn starts in planning"); my follow-up asked for 35 edits and the thread said **"Making 35 changes"** with a small grey "PLANNING FIRST" tag. They were all "Not run". The agent's next message said "ok". The person sees a normal-looking step and a game that did not change. | Send a second message after the game is made without `set_mode`. |
| F17 | **P1** | **A 3D game is black until it has lights, and nothing says so.** Everything `game_from_model` makes is a lit material. With no light layer effect the whole screen is black, including a floor that fills the view. The reply to `game_from_model` warns about the camera ("seen from above by the default camera") and about falling for ever, but not about lights. | `06` (a black screen, no errors in the console). Fix: add `Scene3D::AmbientLight` and `DirectionalLight` as layer effects; mention it in the reply. |
| F18 | P1 | **The camera looks the wrong way and nothing shows it.** "Look at a position" aims once, from where the camera is at that moment, and the game moves the camera on the next frame, so a single call at the start aims from the wrong place: I saw only the cannon. The view is only right if place-then-look-at runs **every frame**. The direction is a trap too: in the top-down view +y points up the screen, so a camera at positive y looking at y = 0 faces away unless it turns. | `07` (the real layout, from above), `08` (right once fixed, but too close) |
| F19 | P1 | **`game_check` still cannot see a shifted value.** Instructions whose parameters are numbered from 1 have an internal slot 0 that must be `""`. I put the operator there: every value moved up one place, the camera actions did nothing useful, and the check said "Nothing looks wrong" (it counts parameters, not which slot each is in). It did catch the unquoted layer name `UI` and said exactly how to write it. Same class as F8. | `SetCameraCenterX ["=", "0", "", "0"]` vs `["", "=", "0", "", "0"]` |
| F20 | P2 | **The editor's scene view does not show what the player sees.** With the 3D camera set, the design canvas shows an odd top-down slice (grey strips, a cannon seen from above, no window), nothing like the game. A newcomer cannot judge their scene from it. | `09` |
| F21 | P2 | **Play does not refresh a running game.** After I edited the game and pressed Play, nothing changed: while a game is "Playing" the button is Stop, so the preview I opened was the old game (twice I judged an old version). The old black screen was exactly this. | Edit while playing; press Play. |
| F22 | P3 | A 3D shape that is a mesh (the ball) shows an orange **cube** in the Shapes list: thumbnails are drawn from the footprint. | `11` |

## What works well (keep it)

- **The 3D to game handoff is the best part.** One call per piece, plain words for physics (`bouncy`), a clear reply ("made the 3D
  object Ball ... dynamic physics (sphere, density 1, friction 0.3, bounce 0.85) ... it follows the model"), and the result
  behaves: the ball bounces, the shards fall and settle, the glass is see-through.
- The modelling tools are enough for a real scene: stock shapes, a true sphere, thin cuts for cracks, groups, glass surfaces.
  The model-side cost was 54 small calls, none of which needed a mesh tool.
- Hints that earn their keep: "set a 3D camera to watch it fall from the side", "it will fall for ever: pass ground: true".
- `game_check` explained the one thing it did catch precisely (the quoted layer name), and `game_play` ran the 3D game headless
  ("played 5.6 s") and returned pictures.
- The phone controls from part 1 carried over unchanged (flat buttons on a 2D layer over the 3D one).

## 2D and 3D side by side

| | 2D (part 1) | 3D (part 2) |
|---|---|---|
| Pieces | 10 pictures drawn by a script | 7 models built with the modeller, 54 calls |
| First wall | no art (F3) | no way in from the 3D tile (F12), no sphere (F13) |
| Silent failures | keys never fire (F8) | black screen (F17), camera (F18), shifted slots (F19) |
| Game logic | 20 events | 16 events, real physics instead of hand-made motion |
| Feel | flat, fast | a cannon with a window to aim at; shards that fall and bounce |
| Cost | one `game_edit` | modelling, sending, lights, camera, then rules |

## Suggested order for part 2

1. F15, F16, F17 (calls that run together; held edits that look done; the black screen). All three are one reply away from a
   working game and need no design.
2. F18, F19 (a camera example with place-then-look-at every frame in `game_catalog` or the manual; a slot check for numbered-from-1
   instructions, which also closes F8's cousin).
3. F14 (Visible work: ask before turning a 50-step build into minutes, or build fast and replay).
4. F12, F13 (a path into a game from the 3D tile; a Sphere in Shapes).
5. F20 to F22.

## Not covered (part 2)

A real model driving these tools (whether it would hit F15 by itself, how it handles F16); shadows, a shatter sound, a score;
Visible work on the Games window; a real device and a real GPU (this was a software renderer: frame times are not meaningful).
