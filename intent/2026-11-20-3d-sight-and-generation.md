# Autora 3D: the agent sees its model, and generates one when asked

Problem:
Models without strong spatial sense (DeepSeek above all, the cheap default) make poor organic forms in Autora 3D. The
high-level tools are already there (`cad_sculpt_blend` is metaballs/SDF with smooth union, `cad_sculpt_loft`,
`cad_sculpt_smooth`, Manifold joins, `cad_mesh_import` of CC0 base meshes, rigging). What is missing is sight: the agent
only ever reads numbers (`cad_scene_get`), so a floating leg or a head half the right size goes unnoticed.
`cad_sculpt_blend`'s description tells it to "look with cad_scene_get / a view", and no view tool exists. DeepSeek's API
takes no images, so a picture alone would not help it either. There is also no way to get a mesh that rivals a
generator like Meshy.

Outcome wanted:
1. **Sight.** A `cad_view` tool renders the model (or picked shapes) from a few fixed angles (front, side, top, three
   quarter) as PNGs from the headless engine, no window needed. A model that takes images gets them. A model that does
   not (`modelprofile.ts` says so) gets a critique instead: a cheap vision model the person has a key for looks at the
   pictures and replies with concrete, numbered faults (what floats, what is out of proportion, what is missing, which
   shape), which the agent turns into number changes. The blend description points at it truthfully.
2. **Generation, only when the person asks for it.** A tool that sends a prompt or a picture to a hosted
   image-to-3D / text-to-3D model (TRELLIS, Hunyuan3D, InstantMesh on fal.ai or Replicate), fetches the GLB and brings it
   in through the `cad_mesh_import` path. The agent can then clean up, colour, rig and place it.

Decisions (stated by the person, 2026-11-20):
- Generating a model is allowed only when the person explicitly asks for one to be generated. Otherwise the agent builds
  with the modelling tools and guides as the core principle says. It never suggests or reaches for generation itself.

Who / what it touches:
- `autora-3d/` (a render path in the headless engine), applied as a patch in `docs/` like the others, then
  `scripts/sync-autora-3d.mjs --specs` for `server/specs/cad.ts`.
- `server/caddesk.ts` (run the tools, read the GLB bytes, never through the conversation), `server/modelprofile.ts`
  (which models see images; which critic model to use), `server/toolload.ts` (a separate family for generation).
- `server/state.ts` `secretTable()` / env keys for the fal.ai or Replicate key; the request goes only to that host
  (parsed hostname comparison).
- `server/handbook.ts` 3D manual and `tests/handbook.test.ts`; tests for the render, the critic and the gate.
- Release bump and `releaseNotes`.

Constraints (check CLAUDE.md's product decisions):
- The explicit-ask rule is enforced by tool availability, not a prompt rule (as Writers Block does): generation is its
  own family whose `words` match only the person's own request ("generate a 3D model", "make it with AI", "image to 3D",
  a picture they hand over with "turn this into 3D"), it cannot be loaded by the agent's `tools_enable`, and `runTool`
  refuses it unless the turn's person message is such a request.
- Grooming, sculpting by hand and the look stay the person's. A generated model is a starting point they shape.
- The critic's pictures and replies are not kept in the chat (one look, as with `browser_screenshot`).
- Measure with `npm run eval -- code` on DeepSeek and one image-capable vendor before merging: cost per finished task.

Open questions:
- Which host first: fal.ai or Replicate (price per generation, which models, GLB with textures)?
- Default critic model: whichever image-capable key the person already has, or a set cheap default?
- Does the critique run automatically after every few sculpt calls, or only when the agent calls `cad_view`?
- Should the window get a visible "Generate" control as well (shown only once the person has asked once)?
