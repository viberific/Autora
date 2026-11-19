# Break the Glass: the game made in the 2026-11-19 usability trial

A portrait game for a phone: slide the cannon (◀ ▶), fire balls (FIRE), and smash a window pane. It takes six hits; the
pane cracks more every two, slides faster each time, then shatters into 46 shards with a "Play again" button. Keyboard
works too (arrows, Space). Findings from making it: `docs/TRY-IT-2026-11-19-GAME.md`.

- `art.cjs` draws every picture with no dependencies (`node art.cjs` writes `art/*.png`: the pane whole and cracked twice, the
  ball, a shard, the cannon, the buttons).
- `game.cjs` writes `queue.json`: the replies the stand-in model gave in the trial (a plan on the to-do list, `set_mode`
  build, `game_open`, ten `game_import`s, one `game_edit` of 42 ops, `game_check`, `game_play`). The ops are the game: the
  objects, where they sit, and the 20 events. Every instruction is padded to the slot count the catalog gives it.
- `fakellm.cjs` is the stand-in model: an OpenAI-style server that answers with what is queued
  (`curl -XPOST localhost:4100/ctl/queue -d @queue.json`). Point Autora at it with
  `PATCH /api/settings {"provider":"local","models":{"local":"scripted-1"},"base_urls":{"local":"http://127.0.0.1:4100/v1"}}`,
  then say "make me a game where I shoot balls at a window" in a new chat. Needs the Games editor built
  (`npm --prefix gdevelop-editor ci && npm --prefix gdevelop-editor run build`).
