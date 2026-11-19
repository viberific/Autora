const fs = require('fs');
const cat = JSON.parse(fs.readFileSync(__dirname + '/../../../server/game-catalog.json', 'utf8'));
const slots = new Map(), real = new Map(); for (const i of cat.instructions) { slots.set(i.kind + ':' + i.type, i.n); real.set(i.kind + ':' + i.type, i.params.map((p) => p.i)); }
const pad = (kind, value, parameters) => { const k = kind + ':' + value, n = slots.get(k); if (parameters.length === n) return parameters.slice(); const idx = real.get(k); const out = Array(n).fill(''); idx.forEach((slot, j) => { out[slot] = parameters[j]; }); return out; };
const act = (value, p) => ({ type: { value }, parameters: pad('action', value, p), subInstructions: [] });
// every frame: put the camera behind the cannon (it follows a little), THEN look at the window
const camera = { type: 'BuiltinCommonInstructions::Standard', conditions: [], events: [], actions: [
  act('SetCameraCenterX', ['=', 'Cannon.CenterX()*0.55', '', '0']), act('SetCameraCenterY', ['=', '1330', '', '0']), act('Scene3D::SetCameraZ', ['=', '470', '', '0']),
  act('Scene3D::TurnCameraTowardPosition', ['Cannon.CenterX()*0.2', '0', '140', '', '0', 'no'])] };
const queue = [
  { text: 'A little further back and higher, so the cannon and the whole window are in view.', tools: [{ name: 'set_mode', args: { to: 'build', reason: 'fixing the camera' } }, { name: 'game_edit', args: { ops: [{ op: 'set', path: 'layouts[Scene].events[0]', value: camera }] } }, { name: 'game_check', args: {} }] },
  { text: 'Fixed: the camera is placed and aimed every frame.' },
];
fs.writeFileSync('queue-cam.json', JSON.stringify(queue));
