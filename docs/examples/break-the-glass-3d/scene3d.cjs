const fs = require('fs');
const cat = JSON.parse(fs.readFileSync(__dirname + '/../../../server/game-catalog.json', 'utf8'));
const ART = process.env.ART_DIR || (__dirname + '/../break-the-glass/art/');
const T = cat.templates;
const slots = new Map(), real = new Map(); for (const i of cat.instructions) { slots.set(i.kind + ':' + i.type, i.n); real.set(i.kind + ':' + i.type, i.params.map((p) => p.i)); }
// Values given for the real parameters (in order) go into the slot each one is numbered with (slot 0 is internal when they start at 1);
// a list already as long as the slots is taken as written.
const pad = (kind, value, parameters) => { const k = kind + ':' + value, n = slots.get(k); if (n === undefined) throw new Error('not in the catalog: ' + k); if (parameters.length === n) return parameters.slice();
  const idx = real.get(k); if (parameters.length === idx.length) { const out = Array(n).fill(''); idx.forEach((slot, j) => { out[slot] = parameters[j]; }); return out; }
  const out = parameters.slice(); while (out.length < n) out.push(''); if (out.length > n) throw new Error(value + ' takes ' + n + ' parameters, got ' + out.length); return out; };
const cond = (value, p, inverted = false) => ({ type: { inverted, value }, parameters: pad('condition', value, p), subInstructions: [] });
const act = (value, p) => ({ type: { value }, parameters: pad('action', value, p), subInstructions: [] });
const ev = (conditions, actions, events = []) => ({ type: 'BuiltinCommonInstructions::Standard', conditions, actions, events });
const repeat = (n, actions) => ({ type: 'BuiltinCommonInstructions::Repeat', repeatExpression: String(n), conditions: [], actions, events: [] });
const animation = (images) => ({ name: '', useMultipleDirections: false, directions: [{ looping: false, timeBetweenFrames: 100000, sprites: images.map((image) => ({ image, points: [], originPoint: { name: 'origine', x: 0, y: 0 }, centerPoint: { automatic: true, name: 'centre', x: 0, y: 0 }, hasCustomCollisionMask: false, customCollisionMask: [] })) }] });
const sprite = (name, images) => ({ ...JSON.parse(JSON.stringify(T.objects.Sprite)), name, animations: [animation(images)] });
const text = (name, str, size, rgb, extra = {}) => { const t = JSON.parse(JSON.stringify(T.objects['TextObject::Text'])); t.name = name; t.string = str; t.characterSize = size; t.color = { r: rgb[0], g: rgb[1], b: rgb[2] }; t.bold = !!extra.bold;
  Object.assign(t.content, { text: str, characterSize: size, color: rgb.join(';'), bold: !!extra.bold, ...(extra.outline ? { isOutlineEnabled: true, outlineColor: '0;0;0', outlineThickness: 6 } : {}) }); return t; };
const inst = (name, x, y, layer = 'UI', zOrder = 0) => ({ ...JSON.parse(JSON.stringify(T.instance)), name, x, y, layer, zOrder });
const num = (name, value) => ({ name, type: 'number', value });
const effect = (effectType, name, doubleParameters, stringParameters, booleanParameters = {}) => ({ effectType, name, doubleParameters, stringParameters, booleanParameters });

const imports = ['btn_left', 'btn_right', 'btn_fire', 'btn_again'].map((r) => ({ name: 'game_import', args: { file: ART + r + '.png', resource: r } }));
const P = 'Physics3D', O = 'Object3D';
const PHY = 'Physics3D::Physics3DBehavior::';
const onBtn = (o) => cond('IsCursorOnObject', [o, '', 'no']);
const press = [cond('MouseButtonFromTextPressed', ['', '"Left"'])];
const moveLeft = [act('SetX', ['Cannon', '-', '460*TimeDelta()'])], moveRight = [act('SetX', ['Cannon', '+', '460*TimeDelta()'])];
const spawn = [
  act('Create', ['', 'Ball', 'Cannon.CenterX()', 'Cannon.Y() - 30', '']),
  act('Scene3D::Base3DBehavior::SetZ', ['Ball', O, '=', '112']),
  act(PHY + 'SetLinearVelocityY', ['Ball', P, '=', '-1400']),
  act(PHY + 'SetLinearVelocityZ', ['Ball', P, '=', '170']),
  act('SetNumberVariable', ['Cool', '=', '0.35']),
];
const canFire = [cond('NumberVariable', ['Cool', '<=', '0']), cond('NumberVariable', ['Hits', '<', '6'])];
const swap = (from, to, stage, atHits) => ev([cond('NumberVariable', ['Hits', '>=', String(atHits)]), cond('NumberVariable', ['Stage', '=', String(stage)])],
  [act('SetNumberVariable', ['Stage', '=', String(stage + 1)]), act('Delete', [from]), act('Create', ['', to, '0', '0', '']), act('Scene3D::Base3DBehavior::SetZ', [to, O, '=', '0'])]);

const events = [
  // the camera: behind the cannon, looking at the window
  ev([cond('SceneJustBegins', [''])], [
    act('SetCameraCenterX', ['=', '0', '', '0']), act('SetCameraCenterY', ['=', '1000', '', '0']), act('Scene3D::SetCameraZ', ['=', '400', '', '0']),
    act('Scene3D::TurnCameraTowardPosition', ['0', '0', '190', '', '0', 'no'])]),
  ev([cond('KeyFromTextPressed', ['', '"Left"'])], moveLeft), ev([cond('KeyFromTextPressed', ['', '"Right"'])], moveRight),
  ev([...press, onBtn('LeftBtn')], moveLeft), ev([...press, onBtn('RightBtn')], moveRight),
  ev([cond('PosX', ['Cannon', '<', '-170'])], [act('SetX', ['Cannon', '=', '-170'])]),
  ev([cond('PosX', ['Cannon', '>', '170'])], [act('SetX', ['Cannon', '=', '170'])]),
  ev([], [act('SetNumberVariable', ['Cool', '-', 'TimeDelta()'])]),
  ev([cond('KeyFromTextPressed', ['', '"Space"']), ...canFire], spawn),
  ev([...press, onBtn('FireBtn'), ...canFire], spawn),
  // a hit: the ball is spent, the glass takes damage
  ev([cond('Physics3D::CollisionStarted', ['Ball', P, 'Panes', P])], [act('Delete', ['Ball']), act('SetNumberVariable', ['Hits', '+', '1'])]),
  ev([cond('PosY', ['Ball', '<', '-400'])], [act('Delete', ['Ball'])]),
  swap('Window', 'WindowCracked', 0, 2), swap('WindowCracked', 'WindowSmashed', 1, 4),
  // the sixth hit: it shatters into pieces that really fall
  ev([cond('NumberVariable', ['Hits', '>=', '6']), cond('NumberVariable', ['Stage', '=', '2'])],
    [act('SetNumberVariable', ['Stage', '=', '3']), act('Delete', ['WindowSmashed']),
     act('Create', ['', 'WinText', '70', '300', '"UI"']), act('Create', ['', 'AgainBtn', '120', '600', '"UI"']), act('Create', ['', 'AgainLabel', '190', '622', '"UI"'])],
    [repeat(44, [
      act('Create', ['', 'Shard', 'RandomInRange(-140,140)', 'RandomInRange(-6,6)', '']),
      act('Scene3D::Base3DBehavior::SetZ', ['Shard', O, '=', 'RandomInRange(45,390)']),
      act(PHY + 'SetLinearVelocityX', ['Shard', P, '=', 'RandomInRange(-260,260)']),
      act(PHY + 'SetLinearVelocityY', ['Shard', P, '=', 'RandomInRange(-500,-50)']),
      act(PHY + 'SetLinearVelocityZ', ['Shard', P, '=', 'RandomInRange(0,380)'])])]),
  ev([cond('NumberVariable', ['Stage', '=', '3']), ...press, onBtn('AgainBtn')], [act('Scene', ['', '"Scene"', ''])]),
];

const baseLayer = { renderingType: '3d', effects: [
  effect('Scene3D::AmbientLight', 'Ambient', { intensity: 0.9 }, { color: '255;255;255' }),
  effect('Scene3D::DirectionalLight', 'Sun', { intensity: 1.2, elevation: 55, rotation: 215 }, { color: '255;246;230', top: 'Z+' }, { isCastingShadow: false })] };
const ops = [
  { op: 'merge', path: 'properties', value: { name: 'Break the Glass 3D', description: 'A cannon, balls and a window. Smash it.', windowWidth: 540, windowHeight: 960, orientation: 'portrait', sizeOnStartupMode: '' } },
  { op: 'merge', path: 'layouts[Scene]', value: { r: 24, v: 36, b: 66 } },
  { op: 'set', path: 'layouts[Scene].variables', value: [num('Hits', 0), num('Cool', 0), num('Stage', 0)] },
  { op: 'merge', path: 'layouts[Scene].layers[0]', value: baseLayer },
  { op: 'insert', path: 'layouts[Scene].layers', value: { ...JSON.parse(JSON.stringify(T.layer)), name: 'UI', renderingType: '2d' } },
  { op: 'insert', path: 'layouts[Scene].objectsGroups', value: { name: 'Panes', objects: [{ name: 'Window' }, { name: 'WindowCracked' }, { name: 'WindowSmashed' }] } },
  ...[sprite('LeftBtn', ['btn_left']), sprite('RightBtn', ['btn_right']), sprite('FireBtn', ['btn_fire']), sprite('AgainBtn', ['btn_again']),
      text('Title', 'Break the glass!', 40, [255, 255, 255], { bold: true }), text('Hint', 'Six hits shatter it', 24, [180, 200, 235]),
      text('WinText', 'You broke it!', 64, [255, 233, 120], { bold: true, outline: true }), text('AgainLabel', 'Play again', 36, [255, 255, 255], { bold: true })]
    .map((o) => ({ op: 'insert', path: 'layouts[Scene].objects', value: o })),
  ...[inst('LeftBtn', 22, 830), inst('RightBtn', 170, 830), inst('FireBtn', 360, 800), inst('Title', 120, 28), inst('Hint', 150, 76)]
    .map((i) => ({ op: 'insert', path: 'layouts[Scene].instances', value: i })),
  ...events.map((e) => ({ op: 'insert', path: 'layouts[Scene].events', value: e })),
];
const queue = [
  { text: 'Now the game around them: a lit 3D scene with the camera behind the cannon, a second flat layer for the phone buttons, and the rules.', tools: [{ name: 'set_mode', args: { to: 'build', reason: 'the plan is on the list' } }, { name: 'todo', args: { done: [4], start: 5 } }, ...imports] },
  { text: 'Lights, camera, buttons and rules in one go.', tools: [{ name: 'game_edit', args: { ops } }] },
  { text: 'Checking for mistakes.', tools: [{ name: 'todo', args: { done: [5, 6], start: 7 } }, { name: 'game_check', args: {} }] },
  { text: 'Playing it once: a tap on FIRE, then a look.', tools: [{ name: 'game_play', args: { width: 540, height: 960, script: [{ wait: 1500 }, { shot: 'start' }, { click: [435, 870] }, { wait: 900 }, { shot: 'fired' }] } }] },
  { text: 'It is ready. The window sits at the end of a floor, the cannon slides with the arrow buttons, FIRE shoots balls with real physics, six hits crack it and then it shatters into pieces that fall and bounce. On a computer: arrow keys and Space. What would you like different: the camera, how many hits, how the glass looks?' },
];
fs.writeFileSync('queue-scene.json', JSON.stringify(queue));
console.log('ops', ops.length, 'events', events.length);
