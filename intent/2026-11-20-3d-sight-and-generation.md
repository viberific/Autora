# Autora 3D: the agent sees its model, and generates one when asked

Problem:
Models without strong spatial sense (DeepSeek above all, the cheap default) make poor organic forms in Autora 3D. The
high-level tools are already there (`cad_sculpt_blend` is metaballs/SDF with smooth union, `cad_sculpt_loft`,
`cad_sculpt_smooth`, Manifold joins, `cad_mesh_import`, rigging). What was missing was sight: the agent only read
numbers (`cad_scene_get`), so a floating leg or a head half the right size went unnoticed, and `cad_sculpt_blend` told it
to "look with a view" that did not exist. And it guessed anatomy from nothing.

Decisions (stated by the person, 2026-11-20):
- Generating a model is allowed only when the person explicitly asks for one to be generated.
- No outside API and no model run on the device: everything comes from the chat's own LLM plus what Autora computes.
  (This replaces the first draft of this file, which had a vision critic and a hosted image-to-3D service.)

Built (0.9.383):
- `cad_scene_view`: the model drawn as text from several sides at one scale, with what floats, what came apart, whether
  it stands, and how even the two sides are, so a text-only model can see and fix its own work.
- `cad_sculpt_figure`: body plans (biped in head heights, quadruped, bird, fish) as named blend parts with landmarks.
- `cad_sculpt_blend` `replace`: make a form again in place, for refining in rounds.
- The generation mode: a person-only tool set (`generate3d`) and the 3D manual's procedure (block out, look, fix, detail,
  finish). The agent cannot load the set itself; the server refuses the figure tool, in a batch too, without the ask.

Still to do:
- Measure with `npm run eval -- code` on DeepSeek (cost per finished task) and add a 3D task to `evals/tasks.ts`
  that scores the findings of a final `cad_scene_view` (nothing floating, one piece, standing).
- More plans if they earn it (a serpent, a head and bust, a tree); a hand at high detail to join to a biped.
- The blend grid is not centred on the mirror plane, so a symmetric blend is a cell or so off true (98% at detail 72).
