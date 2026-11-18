# Autora 3D: rigging, stage 1 — skeleton, auto-bind, pose, skinned GLB

Status: build-to spec. Target branch: `claude/autora-rig` (worktree /data/work/a2-rig).
Author: Autora. Owner of execution: Claude.

## 1. Goal and finish line

Make Autora 3D able to take the shapes a person has modelled and give them a **skeleton**, bind the
mesh to it, pose it, and export a **skinned GLB** that a game engine (and Little-Farm's loader) can
drive.

Finished when a headless script can: build a few shapes, apply the `bip29` bone template, bind, export
a GLB, and re-read that GLB showing a skin, 29 joints, JOINTS_0/WEIGHTS_0 on every primitive and
inverse bind matrices — and the exported file loads in Little-Farm's existing rig loader
(`/data/work/lf-rig`, `?rig=1`).

## 2. Where the work lives

- Engine: `autora-3d/` (its own package, built to `dist/autora-3d-engine/engine.mjs`).
- `autora-3d/src/types.ts` — `Body3D`: an extruded outline plus bevels. There is **no vertex list** in
  the document; geometry is produced on demand by `utils/bodyGeometry.ts`.
- `autora-3d/src/utils/glb.ts` — `glbBytes(bodies, options)`: a hand-written binary glTF writer,
  201 lines, one named node + material per visible shape.
- `autora-3d/src/utils/exporters.ts` — `exportGLB / exportSTL / exportOBJ / exportJSON`.
- `autora-3d/src/App.tsx` (1248 lines) — the window's UI; cards, viewport, selection.
- `server/caddesk.ts` (703 lines) — the tool surface: it loads the engine bundle and dispatches
  `cad_*` commands. New agent tools go here, not in the engine.

The important consequence: because a body is parametric, **weights belong to the generated triangle
mesh**, not to the document outline. Binding stores per-body per-vertex weights, and any later edit to
that body's outline or bevels marks the bind **stale** (show it in the UI; do not silently reuse).

## 3. Data model (add to `types.ts`, serialise in `utils/serialize.ts`)

```ts
export interface Bone {
  id: string;            // stable, e.g. "bone-1"
  name: string;          // must be a bip29 name when the template made it
  parentId: string | null;
  head: [number, number, number];  // mm, scene space
  tail: [number, number, number];  // mm; points down the bone
}
export interface Rig {
  template: 'bip29' | 'custom';
  bones: Bone[];
  /** Per visible body: 4 bone indices + 4 weights per vertex, flattened. */
  bind?: Record<string, { joints: number[]; weights: number[]; vertexCount: number; stale?: boolean }>;
}
```

Put `rig?: Rig` on the document type alongside the bodies and groups. Old documents must load unchanged
(absent rig = no rigging, current behaviour byte for byte).

`bip29` template — these names come from the six characters Little-Farm already ships, so an
Autora-made rig is interchangeable with them:

```
bip Pelvis (root)
  bip Spine -> bip Spine1 -> bip Neck -> bip Head
  Spine1 -> bip L Clavicle -> bip L UpperArm -> bip L Forearm -> bip L Hand
  Spine1 -> bip R Clavicle -> bip R UpperArm -> bip R Forearm -> bip R Hand
  Pelvis -> bip L Thigh -> bip L Calf -> bip L Foot -> bip L Toe0
  Pelvis -> bip R Thigh -> bip R Calf -> bip R Foot -> bip R Toe0
```

Default joint positions should form a ~1.8 m biped standing on the ground plane, scaled to the current
model's bounding box height (so it fits whatever the person built), with the arms out in a T-pose.

## 4. Auto-bind (the heart of stage 1)

For every visible body, generate its geometry (`buildBodyGeometry`), then for each vertex:

1. Distance `d` to each bone's segment (head->tail), in scene millimetres.
2. Raw weight `w = 1 / (d + 1)^4` — falloff exponent 4, tunable.
3. Keep the 4 largest, drop any below 2% of their sum, renormalise the rest.
4. Store as indices into `rig.bones` plus weights.

Special cases to get right, because they are what makes a rig look alive rather than broken:
- Vertices below the pelvis should prefer `bip L/R Thigh` by side, not the pelvis.
- Left/right is by sign of x; a vertex near x=0 splits between both legs.
- The head and hair go fully to `bip Head`; nothing above the neck should get arm weights.

## 5. Skinned GLB export

Extend `glbBytes` with an optional `rig` in `GlbOptions`:
- One `skin` for the whole export: `joints` = the bone nodes, `inverseBindMatrices` from each bone's rest
  world matrix.
- Every primitive gains `JOINTS_0` (UNSIGNED_SHORT) and `WEIGHTS_0` (FLOAT) matching its body's bind.
- Bone nodes are added to the scene graph under a single root node named like the rig (`rig_CharRoot`),
  with the bone local transform derived from head/parent-head.
- Scale: the existing `scale` option still converts mm to metres, so a 1.8 m model exports at 1.8.
- Bodies with no bind export exactly as now (no skin). If some bodies are bound and others not, bound
  ones get the skin and the rest stay rigid.

Do not attempt animations in stage 1 — pose is a preview only, exports go out in the rest pose.

## 6. UI (the second half; do it after the engine works)

A **Rig** card in the 3D window:
- "Add skeleton" -> `bip29`, fitted to the model's bounds.
- Bone list (tree), selecting one highlights it in the viewport.
- Dragging a joint in the viewport moves its head and its children follow.
- "Bind" button -> runs auto-bind, shows "N vertices, M bodies bound", and marks stale when a bound
  body is later edited.
- Pose: a slider per selected bone (rotation about its local x/y/z), and "Reset pose".
- Export already exists; the GLB button must pass the rig when one exists.

Keep it in the window's existing card style (read the other cards in App.tsx and match them). No new
UI framework.

## 7. Agent tools (so Autora can drive it)

In `server/caddesk.ts` add, matching the existing tool style and naming:
`rig_get` (the rig or null), `rig_add` (template, fitted), `rig_bone_set` (id, head, tail, name),
`rig_bind` (all visible bodies), `rig_pose` (bone id, x/y/z degrees, or reset), and make `export`
accept `rig: true`.

These must be listed in the tool catalogue the same way the other cad tools are, with descriptions in
the house voice, and must appear in the file's tool-name table.

## 8. Acceptance

1. `cd autora-3d && npm run build` passes (its own package build).
2. Repo typecheck (`npm run typecheck` at the root, or whatever the repo's script is) passes.
3. A new `autora-3d/scripts/verify-rig.mjs` builds three bodies (a torso box, an arm, a leg), applies
   `bip29`, binds, exports, re-reads the GLB and asserts: one skin, 29 joints, JOINTS_0 and WEIGHTS_0
   present on every primitive, weights summing to 1 within 1e-3 per vertex, inverseBindMatrices of the
   right length. Prints counts and exits non-zero on failure.
4. Root tests that already exist still pass — run the repo's test script; if it is heavy, run the tests
   touching serialisation and the 3D engine.
5. Old `.model.json` documents without a rig still load (assert in the verify script with a fixture).

## 9. Out of scope for stage 1

- Weight painting, smoothing, mirroring (stage 2).
- Animation clips, keyframes, a timeline (stage 3).
- Importing an existing rigged GLB and editing its skeleton.
- Anything that changes a model's shape, bevels or materials.
- Little-Farm: do not touch that repo in this job.

## 10. Working rules

- Read `CLAUDE.md` at the repo root first and follow it.
- Branch `claude/autora-rig` only. Do not push to main; do not touch `blofstedt-autora/umbrel-app.yml`
  or the compose file.
- Bump the app's patch version in `package.json` (release rule: any app-code change bumps it).
- If time runs out, stop at a green point and commit what works: engine + bind + export first, UI second.
  Say plainly in the commit message which units are done and which are not.
