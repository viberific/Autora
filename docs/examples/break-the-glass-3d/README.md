# Break the Glass, in 3D: the second game of the 2026-11-19 usability trial

The same game as `../break-the-glass/` (a cannon, balls, a pane to smash, phone controls), made the 3D way: the pieces are
modelled in Autora 3D and sent to the game with physics. Findings: `docs/TRY-IT-2026-11-19-GAME.md`, part 2.

What it is: an over-the-shoulder view. A window (frame and glass) stands at the end of a floor; a cannon in front slides with
the arrow buttons (or the arrow keys); FIRE shoots a ball that is a real physics body. Two hits crack the glass, four crack it a
lot, six shatter it into 44 pieces that fall and settle on the floor. "Play again" starts over.

- `model.mjs` builds the 3D model with the real modeller tools, 54 calls: a sphere ball (`cad_sculpt_blend`), a floor, a window
  three times (frame bars + a glass slab; the cracked ones have the cracks cut out of the glass with `cad_shapes_subtract`),
  a cannon (cylinder + barrel) and a glass shard. Each call is run on a local copy of the engine to learn the ids.
- `queue.mjs models|send` turns that into the replies a stand-in model would give: plan, `set_mode`, the modelling calls, then
  `game_open` and one `game_from_model` per piece (static floor and window, dynamic bouncy ball, dynamic shards, a plain cannon).
- `scene3d.cjs` is the game around them (`game_edit`, 35 ops): lights as layer effects, a 2D "UI" layer for the buttons, the
  window variants as one object group, and 16 events (move, fire with a velocity, collision, swap the window, shatter).
- `fixcam.cjs` is the camera event the agent had to rewrite: it must run every frame, in order (place, then look at).
- Needs the Games editor (`npm --prefix gdevelop-editor ci && npm --prefix gdevelop-editor run build`), the 3D engine
  (`npm --prefix autora-3d run build`), and the pictures from `../break-the-glass/art.cjs` (the buttons).
  The stand-in model is `../break-the-glass/fakellm.cjs`; turn Visible work off first (`PATCH /api/agent-cursor {"on":false}`).
