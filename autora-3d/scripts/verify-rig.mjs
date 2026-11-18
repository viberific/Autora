// Proves rigging end to end, headless, against the built engine bundle:
//   build shapes -> bip29 -> bind -> export a skinned GLB -> read the GLB back and check it.
// Run after `npm run build` (or build:engine):  node scripts/verify-rig.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { Engine, parseDoc, initManifold } = await import(pathToFileURL(path.join(here, '../../dist/autora-3d-engine/engine.mjs')).href);
await initManifold().catch(() => undefined);

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const run = async (m, tool, args) => {
  const r = await m.execute(tool, args);
  if (!r.ok) throw new Error(`${tool} failed: ${r.error} ${r.hint ?? ''}`);
  return r;
};

/** Reads a GLB: its JSON and binary chunks. */
function readGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen + 8;
  return { json, bin: bytes.subarray(binStart) };
}
const typed = (glb, accIndex) => {
  const a = glb.json.accessors[accIndex];
  const v = glb.json.bufferViews[a.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const Ctor = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  const start = glb.bin.byteOffset + v.byteOffset + (a.byteOffset ?? 0);
  return { a, data: new Ctor(glb.bin.buffer.slice(start, start + a.count * comps * Ctor.BYTES_PER_ELEMENT)), comps };
};
const glbOf = async (m, args) => {
  const r = await run(m, 'export', { format: 'glb', ...args });
  return readGlb(new Uint8Array(Buffer.from(r.result.data, 'base64')));
};

// ---- 1. a model: torso, arm, leg (plus a head, and the other arm and leg so the figure is symmetric: the skeleton is centred on the model) ------------------------------------------------------------------
const m = new Engine();
await run(m, 'shape_add', { kind: 'box', name: 'Leg', x: 110, y: 0, width: 100, depth: 160, height: 880 });
await run(m, 'shape_add', { kind: 'box', name: 'Torso', x: 0, y: 0, width: 380, depth: 220, height: 640, elevation: 880 });
await run(m, 'shape_add', { kind: 'box', name: 'Arm', x: 480, y: 0, width: 520, depth: 110, height: 110, elevation: 1330 });
await run(m, 'shape_add', { kind: 'box', name: 'Arm R', x: -480, y: 0, width: 520, depth: 110, height: 110, elevation: 1330 });
await run(m, 'shape_add', { kind: 'box', name: 'Leg R', x: -110, y: 0, width: 100, depth: 160, height: 880 });
await run(m, 'shape_add', { kind: 'box', name: 'Head', x: 0, y: 0, width: 200, depth: 200, height: 280, elevation: 1520 });
const before = await glbOf(m, {});
check(!before.json.skins && before.json.nodes.every((n) => !('skin' in n)), 'unrigged export has no skin (as before)');
const beforeBytes = (await run(m, 'export', { format: 'glb' })).result.data;

// ---- 2. rig, bind --------------------------------------------------------------------------------------------
const added = (await run(m, 'rig_add', { template: 'bip29' })).result;
check(added.bones === 29, `bip29 has 29 bones (got ${added.bones})`);
const rigGet = (await run(m, 'rig_get', {})).result.rig;
const names = new Set(rigGet.bones.map((b) => b.name));
check(['bip Pelvis', 'bip Spine', 'bip Spine1', 'bip Neck', 'bip Head', 'bip L Clavicle', 'bip R Toe0', 'bip L Hand', 'bip R Forearm'].every((n) => names.has(n)), 'bip names present');
check(rigGet.bones.filter((b) => b.parent === null).length === 1, 'one root bone');
const head = rigGet.bones.find((b) => b.name === 'bip Head');
const foot = rigGet.bones.find((b) => b.name === 'bip L Foot');
const topMm = 1800;
check(Math.abs(head.tail.z - topMm) < 1 && foot.head.z < 120, `fitted to model height (head tail z ${head.tail.z}, foot z ${foot.head.z})`);
const bound = (await run(m, 'rig_bind', {})).result;
console.log(`bind: ${bound.bodies} bodies, ${bound.vertices} vertices, ${bound.bones} bones`);
check(bound.bodies === 6 && bound.vertices > 0, 'every body bound');
const afterBind = (await run(m, 'rig_get', {})).result.rig;
check(Object.values(afterBind.bound).every((b) => !b.stale), 'nothing stale straight after bind');

// ---- 3. export and read back ------------------------------------------------------------------------------------
const glb = await glbOf(m, { rig: true });
const { json } = glb;
check(json.skins?.length === 1, `one skin (${json.skins?.length})`);
const skin = json.skins[0];
check(skin.joints.length === 29, `29 joints (${skin.joints.length})`);
check(skin.joints.every((j) => json.nodes[j]?.name), 'every joint is a named node');
check(json.nodes.some((n) => n.name === 'rig_CharRoot'), 'rig_CharRoot node');
const ibm = typed(glb, skin.inverseBindMatrices);
check(ibm.a.type === 'MAT4' && ibm.a.count === 29 && ibm.data.length === 29 * 16, `inverseBindMatrices: ${ibm.a.count} MAT4 (${ibm.data.length} floats)`);
let prims = 0, verts = 0, worst = 0, maxInfluence = 0, headFull = 0, headAbove = 0, armOnHead = 0;
const jointOfBone = new Map(skin.joints.map((j, i) => [json.nodes[j].name, i]));
for (const mesh of json.meshes) {
  for (const p of mesh.primitives) {
    prims++;
    const hasJ = 'JOINTS_0' in p.attributes, hasW = 'WEIGHTS_0' in p.attributes;
    check(hasJ && hasW, `primitive of "${mesh.name}" has JOINTS_0 and WEIGHTS_0`);
    if (!hasJ || !hasW) continue;
    const J = typed(glb, p.attributes.JOINTS_0), W = typed(glb, p.attributes.WEIGHTS_0), P = typed(glb, p.attributes.POSITION);
    check(J.a.componentType === 5123 && W.a.componentType === 5126 && J.a.count === P.a.count && W.a.count === P.a.count, `"${mesh.name}": ${P.a.count} vertices, joints/weights counts match`);
    for (let v = 0; v < W.a.count; v++) {
      const s = W.data[v * 4] + W.data[v * 4 + 1] + W.data[v * 4 + 2] + W.data[v * 4 + 3];
      worst = Math.max(worst, Math.abs(s - 1));
      for (let k = 0; k < 4; k++) {
        if (W.data[v * 4 + k] > 0) maxInfluence = Math.max(maxInfluence, k + 1);
        if (J.data[v * 4 + k] >= 29) throw new Error('joint index out of range');
      }
      verts++;
      if (mesh.name === 'Head' && P.data[v * 3 + 1] > 1.55) { headAbove++; if (J.data[v * 4] === jointOfBone.get('bip Head') && W.data[v * 4] === 1) headFull++; }
      if (mesh.name === 'Head') for (let k = 0; k < 4; k++) if (W.data[v * 4 + k] > 0 && /Hand|Forearm|UpperArm|Clavicle/.test(json.nodes[skin.joints[J.data[v * 4 + k]]].name)) armOnHead++;
    }
  }
}
check(worst < 1e-3, `weights sum to 1 within 1e-3 on every vertex (worst error ${worst.toExponential(2)})`);
check(headAbove > 0 && headFull === headAbove, `vertices above the neck go fully to bip Head (${headFull}/${headAbove})`);
check(armOnHead === 0, 'no arm weights on the head');
// Below the pelvis the leg bones take over, by side: the leg shape (x>0 is the character's left) must carry only L-leg weights.
{
  const legMesh = json.meshes.findIndex((x) => x.name === 'Leg');
  const p = json.meshes[legMesh].primitives[0];
  const J = typed(glb, p.attributes.JOINTS_0), W = typed(glb, p.attributes.WEIGHTS_0);
  let bad = 0;
  for (let v = 0; v < W.a.count; v++) for (let k = 0; k < 4; k++) if (W.data[v * 4 + k] > 0 && !/^bip L (Thigh|Calf|Foot|Toe0)$/.test(json.nodes[skin.joints[J.data[v * 4 + k]]].name)) bad++;
  check(bad === 0, 'the left leg shape is weighted to the left leg bones only');
}
// Scale: the model is 1.8 m tall and exports at 1.8.
{
  const ys = json.accessors.filter((a) => a.type === 'VEC3' && a.max).map((a) => a.max[1]);
  check(Math.abs(Math.max(...ys) - 1.8) < 0.01, `exports at 1.8 m (top ${Math.max(...ys).toFixed(3)})`);
}
console.log(`export: ${prims} primitives, ${verts} skinned vertices, ${skin.joints.length} joints, max influences per vertex ${maxInfluence}`);

// ---- 4. nothing else changed ------------------------------------------------------------------------------------
await run(m, 'rig_pose', { bone: rigGet.bones.find((b) => b.name === 'bip L UpperArm').id, z: 40 });
const posed = await glbOf(m, { rig: true });
check(JSON.stringify(posed.json) === JSON.stringify(json), 'pose is preview only: exports are identical in the rest pose');
const plain = (await run(m, 'export', { format: 'glb' })).result.data;
check(plain === beforeBytes, 'export without rig:true is byte-for-byte what it was before the skeleton existed');

// ---- 5. stale ---------------------------------------------------------------------------------------------------
const armId = (await run(m, 'scene_get', {})).result.shapes.find((s) => s.name === 'Arm').id;
await run(m, 'shape_set', { id: armId, height: 130 });
const stale = (await run(m, 'rig_get', {})).result.rig.bound;
check(stale[armId]?.stale === true && Object.entries(stale).filter(([, b]) => b.stale).length === 1, 'editing a bound shape marks only its bind stale');
const refused = await m.execute('export', { format: 'glb', rig: true });
check(!refused.ok, 'a stale bind is refused at export, not silently reused');
await run(m, 'rig_bind', {});
check((await m.execute('export', { format: 'glb', rig: true })).ok, 'after rig_bind again, export works');

// ---- 6. saving, loading, old documents ----------------------------------------------------------------------
const saved = JSON.parse(JSON.stringify(m.toJSON()));
const back = parseDoc(saved);
check(back?.rig?.bones.length === 29 && Object.keys(back.rig.bind).length === 6, 'rig survives save and load');
const old = {
  bodies: [{ id: 'body_1', name: 'Old block', points: [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }], extrusionHeight: 40, color: '#6f7a93', materialType: 'matte', visible: true, createdAt: '2024-01-01T00:00:00.000Z' }],
  groups: [], repeats: [], library: [],
};
const oldDoc = parseDoc(old);
check(!!oldDoc && oldDoc.rig === undefined && oldDoc.bodies.length === 1, 'an old .model.json with no rig loads unchanged');
const om = new Engine(oldDoc);
check(!('rig' in om.toJSON()), 'and saves back without a rig key');
check((await om.execute('rig_get', {})).result.rig === null, 'rig_get says null for it');
const oldGlb = await glbOf(om, { rig: false });
check(!oldGlb.json.skins, 'and exports with no skin');
check(!(await om.execute('export', { format: 'glb', rig: true })).ok, 'rig:true without a skeleton is refused plainly');

// ---- 7. the fit reads the mesh, it does not assume a T-pose ----------------------------------------------------
const spanOf = (rig) => {
  const tips = rig.bones.filter((b) => /Finger\d1$/.test(b.name)).map((b) => b.tail.x);
  return Math.max(...tips) - Math.min(...tips);
};
{
  // Arms hanging down, and the whole figure off to one side: 760 mm wide, 1800 tall.
  const narrow = new Engine();
  const ox = 125;
  await run(narrow, 'shape_add', { kind: 'box', name: 'Legs', x: ox, y: 0, width: 240, depth: 160, height: 880 });
  await run(narrow, 'shape_add', { kind: 'box', name: 'Torso', x: ox, y: 0, width: 380, depth: 220, height: 640, elevation: 880 });
  await run(narrow, 'shape_add', { kind: 'box', name: 'Arm L', x: ox + 285, y: 0, width: 95, depth: 110, height: 620, elevation: 880 });
  await run(narrow, 'shape_add', { kind: 'box', name: 'Arm R', x: ox - 285, y: 0, width: 95, depth: 110, height: 620, elevation: 880 });
  await run(narrow, 'shape_add', { kind: 'box', name: 'Head', x: ox, y: 0, width: 200, depth: 200, height: 280, elevation: 1520 });
  const r = (await run(narrow, 'rig_add', { template: 'bip29' })).result;
  const rg = (await run(narrow, 'rig_get', {})).result.rig;
  const meshWidth = 665;
  const span = spanOf(rg);
  const pelvis = rg.bones.find((b) => b.name === 'bip Pelvis');
  check(span <= meshWidth + 20, `arms-down mesh: arm span ${span} mm does not exceed the mesh width ${meshWidth} mm by more than 20 (not ${(0.5 * 1800 * 2)} from the height)`);
  check(Math.abs(pelvis.head.x - ox) < 1, `arms-down mesh: pelvis sits on the mesh's centre (x ${pelvis.head.x}, wanted ${ox})`);
  check(typeof r.warning === 'string' && /not in a T-pose/.test(r.warning), 'arms-down mesh: the reply warns it is not a T-pose');
  check(r.centre && Math.abs(r.centre.x - ox) < 1 && Math.abs(r.arm_span_mm - span) < 1, `the reply states the centre (${JSON.stringify(r.centre)}) and arm span (${r.arm_span_mm})`);
}
{
  // A true T-pose: arms out as wide as the figure is tall.
  const tp = new Engine();
  await run(tp, 'shape_add', { kind: 'box', name: 'Legs', x: 0, y: 0, width: 240, depth: 160, height: 880 });
  await run(tp, 'shape_add', { kind: 'box', name: 'Torso', x: 0, y: 0, width: 380, depth: 220, height: 640, elevation: 880 });
  await run(tp, 'shape_add', { kind: 'box', name: 'Arms', x: 0, y: 0, width: 1800, depth: 110, height: 110, elevation: 1330 });
  await run(tp, 'shape_add', { kind: 'box', name: 'Head', x: 0, y: 0, width: 200, depth: 200, height: 280, elevation: 1520 });
  const r = (await run(tp, 'rig_add', { template: 'bip29' })).result;
  const rg = (await run(tp, 'rig_get', {})).result.rig;
  const span = spanOf(rg);
  const pelvis = rg.bones.find((b) => b.name === 'bip Pelvis');
  check(Math.abs(span - 1800) < 20, `T-pose mesh: arm span ${span} mm matches the mesh's 1800`);
  check(Math.abs(pelvis.head.x) < 1 && Math.abs(pelvis.head.y) < 1, 'T-pose mesh: pelvis at x 0, y 0');
  check(r.warning === undefined, 'T-pose mesh: no warning');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
