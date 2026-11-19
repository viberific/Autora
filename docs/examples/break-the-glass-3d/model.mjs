// Builds the model-side calls for the 3D game by running each one on a local engine (to learn the ids), and returns them as tool calls.
const core = await import(new URL('../../../dist/autora-3d-engine/engine.mjs', import.meta.url).href);
await core.initManifold();
export async function modelCalls() {
  const e = new core.Engine(core.emptyDoc());
  const calls = [];
  const run = async (tool, args) => { const r = await e.execute(tool.replace(/^cad_/, ''), args); if (!r.ok) throw new Error(tool + ' failed: ' + JSON.stringify(r).slice(0, 300)); calls.push({ name: tool.startsWith('cad_') ? tool : 'cad_' + tool, args }); return r.result; };
  const v = (x, y, z) => ({ x, y, z });

  // --- the ball: a sphere
  await run('cad_sculpt_blend', { name: 'Ball', color: '#e8691c', material: 'glossy', detail: 64, parts: [{ kind: 'sphere', at: v(-900, 0, 30), radius: 30 }] });

  // --- the floor
  await run('cad_shape_add', { kind: 'box', name: 'Floor', x: 0, y: -1200, width: 1000, depth: 1800, height: 20, color: '#2d3b57', material: 'matte' });

  // --- a window in its frame, three times: whole, cracked a little, cracked a lot
  const slits = {
    1: [['H', -95, 110, 215], ['V', 0, 120, 320], ['V', 55, 215, 300], ['H', 55, 135, 300], ['V', -60, 130, 215], ['H', -140, -60, 130]],
    2: [['H', -95, 110, 215], ['V', 0, 120, 320], ['V', 55, 215, 300], ['H', 55, 135, 300], ['V', -60, 130, 215], ['H', -140, -60, 130],
        ['V', 110, 215, 345], ['H', 110, 152, 345], ['V', -110, 215, 335], ['H', -152, -110, 335], ['V', 30, 120, 215], ['H', 30, 125, 120],
        ['V', -30, 300, 385], ['H', -135, -30, 385], ['V', 85, 120, 215], ['H', 85, 150, 160], ['V', -90, 300, 345], ['H', -90, -20, 275]],
  };
  const windows = {};
  for (const stage of [0, 1, 2]) {
    const cx = 600 * stage; const parts = [];
    const bar = async (name, x, w, h, z) => parts.push((await run('cad_shape_add', { kind: 'box', name, x: cx + x, y: 0, width: w, depth: 30, height: h, elevation: z, color: '#8a5a2f', material: 'matte' })).id);
    await bar('Frame left', -175, 30, 440, 0); await bar('Frame right', 175, 30, 440, 0); await bar('Frame bottom', 0, 380, 30, 0); await bar('Frame top', 0, 380, 30, 410);
    const glass = (await run('cad_shape_add', { kind: 'box', name: 'Glass', x: cx, y: 0, width: 320, depth: 8, height: 380, elevation: 30, color: '#a9dcff', material: 'glossy' })).id;
    let pieces = [glass];
    if (stage) {
      const cutters = [];
      for (const [k, a, b, c] of slits[stage]) {
        const t = 2.6;
        const args = k === 'H' ? { x: cx + (a + b) / 2, width: b - a, height: t, elevation: c - t / 2 } : { x: cx + a, width: t, height: c - b, elevation: b };
        cutters.push((await run('cad_shape_add', { kind: 'box', name: 'Crack', y: 0, depth: 24, ...(k === 'H' ? args : args), color: '#ffffff' })).id);
      }
      const cut = await run('cad_shapes_subtract', { from: [glass], cutters });
      pieces = cut.created;
    }
    await run('cad_surface_set', { ids: pieces, color: '#a9dcff', opacity: 0.38, roughness: 0.08 });
    const name = ['Window', 'Window cracked', 'Window smashed'][stage];
    await run('cad_group_create', { ids: [...parts, ...pieces], name });
    windows[stage] = name;
  }

  // --- the cannon: a round base with a barrel lying along y, pointing toward the window
  const base = (await run('cad_shape_add', { kind: 'cylinder', name: 'Cannon base', x: -600, y: 0, width: 96, depth: 96, height: 90, color: '#4a5568', material: 'metal' })).id;
  const barrel = (await run('cad_shape_add', { kind: 'box', name: 'Cannon barrel', x: -600, y: -60, width: 44, depth: 170, height: 44, elevation: 90, color: '#a0aec0', material: 'metal' })).id;
  await run('cad_group_create', { ids: [base, barrel], name: 'Cannon' });

  // --- a shard of glass
  const shard = (await run('cad_shape_add', { kind: 'triangle', name: 'Shard', x: -1100, y: 0, width: 44, depth: 38, height: 6, color: '#cfeeff', material: 'glossy' })).id;
  await run('cad_surface_set', { ids: [shard], color: '#cfeeff', opacity: 0.6, roughness: 0.1 });
  return { calls, names: windows, doc: e.toJSON() };
}
