const fs = require('fs');
const cat = JSON.parse(fs.readFileSync(__dirname + '/../../../server/game-catalog.json', 'utf8'));
const ART = process.env.ART_DIR || (__dirname + '/art/');
const T = cat.templates;

const slots = new Map(); for (const i of cat.instructions) slots.set(i.kind + ':' + i.type, i.n);
const padTo = (kind, value, parameters) => { const n = slots.get(kind + ':' + value); if (n === undefined) throw new Error('not in the catalog: ' + kind + ' ' + value); const out = parameters.slice(); while (out.length < n) out.push(''); if (out.length > n) throw new Error(value + ' takes ' + n + ' parameters, got ' + out.length); return out; };
const cond = (value, parameters, inverted = false) => ({ type: { inverted, value }, parameters: padTo('condition', value, parameters), subInstructions: [] });
const act = (value, parameters) => ({ type: { value }, parameters: padTo('action', value, parameters), subInstructions: [] });
const ev = (conditions, actions, events = []) => ({ type: 'BuiltinCommonInstructions::Standard', conditions, actions, events });
const repeat = (n, actions) => ({ type: 'BuiltinCommonInstructions::Repeat', repeatExpression: String(n), conditions: [], actions, events: [] });

const animation = (images, hold) => ({ name: '', useMultipleDirections: false, directions: [{ looping: false, timeBetweenFrames: hold ? 100000 : 0.08,
  sprites: images.map((image) => ({ image, points: [], originPoint: { name: 'origine', x: 0, y: 0 }, centerPoint: { automatic: true, name: 'centre', x: 0, y: 0 }, hasCustomCollisionMask: false, customCollisionMask: [] })) }] });
const sprite = (name, images, variables = [], hold = false) => ({ ...JSON.parse(JSON.stringify(T.objects.Sprite)), name, variables, animations: [animation(images, hold)] });
const text = (name, str, size, rgb, extra = {}) => { const t = JSON.parse(JSON.stringify(T.objects['TextObject::Text']));
  t.name = name; t.string = str; t.characterSize = size; t.color = { r: rgb[0], g: rgb[1], b: rgb[2] }; t.bold = !!extra.bold;
  Object.assign(t.content, { text: str, characterSize: size, color: rgb.join(';'), bold: !!extra.bold, ...(extra.outline ? { isOutlineEnabled: true, outlineColor: '0;0;0', outlineThickness: 6 } : {}) }); return t; };
const inst = (name, x, y, zOrder = 0) => ({ ...JSON.parse(JSON.stringify(T.instance)), name, x, y, zOrder });
const num = (name, value) => ({ name, type: 'number', value });

const resources = ['ball', 'glass0', 'glass1', 'glass2', 'shard', 'cannon', 'btn_left', 'btn_right', 'btn_fire', 'btn_again'];
const imports = resources.map((r) => ({ name: 'game_import', args: { file: ART + r.replace('btn_', 'btn_') + '.png', resource: r } }));

const objects = [
  sprite('Glass', ['glass0', 'glass1', 'glass2'], [num('dir', 1)], true),
  sprite('Ball', ['ball']),
  sprite('Shard', ['shard'], [num('vx', 0), num('vy', 0)]),
  sprite('Cannon', ['cannon']),
  sprite('LeftBtn', ['btn_left']), sprite('RightBtn', ['btn_right']), sprite('FireBtn', ['btn_fire']), sprite('AgainBtn', ['btn_again']),
  text('Title', 'Break the glass!', 40, [255, 255, 255], { bold: true }),
  text('Hint', 'Time your shots: it takes 6 hits to smash it', 22, [170, 190, 225]),
  text('WinText', 'You broke it!', 64, [255, 233, 120], { bold: true, outline: true }),
  text('AgainLabel', 'Play again', 36, [255, 255, 255], { bold: true }),
];
const instances = [
  inst('Glass', 80, 105, 1), inst('Cannon', 222, 700, 2),
  inst('LeftBtn', 22, 830, 4), inst('RightBtn', 170, 830, 4), inst('FireBtn', 360, 800, 4),
  inst('Title', 120, 28, 10), inst('Hint', 60, 70, 10),
];

const X = 'Cannon.X() + Cannon.Width()/2 - 22';
const spawn = [act('Create', ['', 'Ball', X, 'Cannon.Y() - 34', '']), act('SetNumberVariable', ['Cool', '=', '0.35'])];
const canFire = [cond('NumberVariable', ['Cool', '<=', '0']), cond('NumberVariable', ['Hits', '<', '6'])];
const moveLeft = [act('SetX', ['Cannon', '-', '520*TimeDelta()'])], moveRight = [act('SetX', ['Cannon', '+', '520*TimeDelta()'])];
const press = [cond('MouseButtonFromTextPressed', ['', '"Left"'])];
const onBtn = (o) => cond('IsCursorOnObject', [o, '', 'no']);

const events = [
  ev([cond('KeyFromTextPressed', ['', '"Left"'])], moveLeft),
  ev([cond('KeyFromTextPressed', ['', '"Right"'])], moveRight),
  ev([...press, onBtn('LeftBtn')], moveLeft),
  ev([...press, onBtn('RightBtn')], moveRight),
  ev([cond('PosX', ['Cannon', '<', '10'])], [act('SetX', ['Cannon', '=', '10'])]),
  ev([cond('PosX', ['Cannon', '>', '434'])], [act('SetX', ['Cannon', '=', '434'])]),
  ev([], [act('SetNumberVariable', ['Cool', '-', 'TimeDelta()'])]),
  ev([cond('KeyFromTextPressed', ['', '"Space"']), ...canFire], spawn),
  ev([...press, onBtn('FireBtn'), ...canFire], spawn),
  ev([], [act('SetY', ['Ball', '-', '720*TimeDelta()'])]),
  ev([cond('PosY', ['Ball', '<', '-60'])], [act('Delete', ['Ball'])]),
  // the pane slides side to side, faster with every hit
  ev([cond('NumberVariable', ['Hits', '<', '6'])], [act('SetX', ['Glass', '+', 'Glass.Variable(dir)*(110+60*Hits)*TimeDelta()'])]),
  ev([cond('PosX', ['Glass', '>', '150'])], [act('SetX', ['Glass', '=', '150']), act('SetNumberObjectVariable', ['Glass', 'dir', '=', '-1'])]),
  ev([cond('PosX', ['Glass', '<', '10'])], [act('SetX', ['Glass', '=', '10']), act('SetNumberObjectVariable', ['Glass', 'dir', '=', '1'])]),
  // a hit: the ball goes, the pane cracks a little more
  ev([cond('CollisionNP', ['Ball', 'Glass', '', '', 'no']), cond('NumberVariable', ['Hits', '<', '6'])],
     [act('Delete', ['Ball']), act('SetNumberVariable', ['Hits', '+', '1']), act('ChangeSprite', ['Glass', '=', 'min(floor(Hits/2),2)'])]),
  // the third hit: it shatters
  ev([cond('NumberVariable', ['Hits', '>=', '6']), cond('NumberVariable', ['ShardsMade', '=', '0'])],
     [act('SetNumberVariable', ['ShardsMade', '=', '1']), act('Create', ['', 'WinText', '90', '300', '']), act('Create', ['', 'AgainBtn', '120', '600', '']), act('Create', ['', 'AgainLabel', '190', '622', '']),
      act('SetZOrder', ['WinText', '=', '30']), act('SetZOrder', ['AgainBtn', '=', '20']), act('SetZOrder', ['AgainLabel', '=', '31'])],
     [repeat(46, [
       act('Create', ['', 'Shard', 'Glass.X() + Random(Glass.Width()-34)', 'Glass.Y() + Random(Glass.Height()-34)', '']),
       act('SetNumberObjectVariable', ['Shard', 'vx', '=', 'RandomInRange(-280,280)']),
       act('SetNumberObjectVariable', ['Shard', 'vy', '=', 'RandomInRange(-520,60)']),
     ])]),
  ev([cond('NumberVariable', ['ShardsMade', '=', '1'])], [act('Delete', ['Glass'])]),
  // falling shards
  ev([], [act('SetNumberObjectVariable', ['Shard', 'vy', '+', '1500*TimeDelta()']), act('SetX', ['Shard', '+', 'Shard.Variable(vx)*TimeDelta()']),
          act('SetY', ['Shard', '+', 'Shard.Variable(vy)*TimeDelta()']), act('SetAngle', ['Shard', '+', 'Shard.Variable(vx)*TimeDelta()*3'])]),
  ev([cond('PosY', ['Shard', '>', '1020'])], [act('Delete', ['Shard'])]),
  // play again
  ev([cond('NumberVariable', ['ShardsMade', '=', '1']), ...press, onBtn('AgainBtn')], [act('Scene', ['', '"Scene"', ''])]),
];

const ops = [
  { op: 'merge', path: 'properties', value: { name: 'Break the Glass', description: 'Slide the cannon, fire balls, and smash the window.', windowWidth: 540, windowHeight: 960, orientation: 'portrait', sizeOnStartupMode: '' } },
  { op: 'merge', path: 'layouts[Scene]', value: { r: 14, v: 20, b: 46 } },
  { op: 'set', path: 'layouts[Scene].variables', value: [num('Hits', 0), num('Cool', 0), num('ShardsMade', 0)] },
  ...objects.map((o) => ({ op: 'insert', path: 'layouts[Scene].objects', value: o })),
  ...instances.map((i) => ({ op: 'insert', path: 'layouts[Scene].instances', value: i })),
  ...events.map((e) => ({ op: 'insert', path: 'layouts[Scene].events', value: e })),
];

const playScript = [{ wait: 600 }, { shot: 'start' }, { click: [435, 883] }, { wait: 300 }, { shot: 'firing' },
  { hold: ['ArrowLeft'], ms: 500 }, { press: 'Space' }, { wait: 900 }, { shot: 'hit' }];
const queue = [
  { text: "Fun idea. I'll plan it first: a window pane to smash, a cannon to shoot balls, and controls that work with a thumb.", tools: [{ name: 'todo', args: { todos: [
      'Open a new game (portrait, for a phone)', 'Add the pictures: pane, ball, shards, cannon, buttons', 'Build the game: sliding pane, cannon, fire button, shatter',
      'Check for mistakes', 'Play it once to see it start and a shot fly'] } }] },
  { text: 'The plan is small and clear, so I am starting to build.', tools: [{ name: 'set_mode', args: { to: 'build', reason: 'plan is on the list' } }, { name: 'game_open', args: { name: 'Break the Glass' } }] },
  { text: 'Adding the pictures: the pane (whole, then cracked twice), a ball, glass shards, the cannon and the buttons.', tools: imports },
  { text: 'Now the game itself: the pane slides, the cannon moves with the arrow buttons, FIRE shoots, three hits shatter it.', tools: [{ name: 'todo', args: { done: [1, 2], start: 3 } }, { name: 'game_edit', args: { ops } }] },
  { text: 'Checking nothing is wrong.', tools: [{ name: 'todo', args: { done: [3], start: 4 } }, { name: 'game_check', args: {} }] },
  { text: 'Playing it once to see that it starts and that a shot happens.', tools: [{ name: 'todo', args: { done: [4], start: 5 } }, { name: 'game_play', args: { script: playScript, width: 540, height: 960 } }] },
  { text: 'It is ready: the pane slides side to side. Use the left and right arrow buttons to move the cannon and FIRE to shoot (on a computer: arrow keys and Space). Six hits crack it more and more, then it shatters. What would you like different: how fast the pane slides, how many hits, or the colours?' },
];
fs.writeFileSync('queue.json', JSON.stringify(queue));
console.log('ops', ops.length, 'events', events.length, 'bytes', JSON.stringify(ops).length);
