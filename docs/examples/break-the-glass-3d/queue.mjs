import fs from 'node:fs';
import { modelCalls } from './model.mjs';
const part = process.argv[2] || 'models';
const { calls } = await modelCalls();
const slice = (from, to) => calls.slice(from, to);
// the calls are in order: ball, floor | 3 windows | cannon, shard
const idx = (pred) => calls.findIndex(pred);
const w0 = 2, wEnd = calls.length - 5;               // windows live between the floor and the cannon
const cannonAt = idx((c) => c.args?.name === 'Cannon base');
let queue = [];
if (part === 'models') {
  queue = [
    { text: 'A 3D game! Let me plan it: model the pieces (a ball, a window, a cannon, a shard of glass), send them to the game with physics, then add a camera, lights, controls and the rules.', tools: [{ name: 'todo', args: { todos: [
      'Model the ball and the floor', 'Model the window: whole, cracked, smashed', 'Model the cannon and a shard', 'Send them all to the game with physics', 'Camera, lights and phone controls', 'The rules: fire, hit, crack, shatter', 'Check it and play it'] } }] },
    { text: 'The ball is a sphere; the floor is a flat slab.', tools: [{ name: 'set_mode', args: { to: 'build', reason: 'the plan is on the list' } }, ...slice(0, 2)] },
    { text: 'The window in its frame. The cracks are thin cuts through the glass.', tools: [{ name: 'todo', args: { done: [1], start: 2 } }, ...slice(w0, cannonAt)] },
    { text: 'The cannon and one shard of glass.', tools: [{ name: 'todo', args: { done: [2], start: 3 } }, ...slice(cannonAt, calls.length)] },
  ];
}
if (part === 'send') {
  const fm = (shapes, object, physics, place) => ({ name: 'game_from_model', args: { shapes: [shapes], object, physics, place } });
  queue = [
    { text: 'Now I open the game and send each piece across with the physics it needs.', tools: [{ name: 'todo', args: { done: [3], start: 4 } }, { name: 'game_open', args: { name: 'Break the Glass 3D' } },
      fm('Floor', 'Floor', { body: 'static', shape: 'box' }, { x: 0, y: 300, z: -20 }),
      fm('Window', 'Window', { body: 'static', shape: 'box' }, { x: 0, y: 0, z: 0 }),
      fm('Window cracked', 'WindowCracked', { body: 'static', shape: 'box' }, false),
      fm('Window smashed', 'WindowSmashed', { body: 'static', shape: 'box' }, false),
      fm('Cannon', 'Cannon', false, { x: 0, y: 650, z: 0 }),
      fm('Ball', 'Ball', { body: 'dynamic', shape: 'sphere', feel: ['bouncy'], gravity: 0.05 }, false),
      fm('Shard', 'Shard', { body: 'dynamic', shape: 'box', bounce: 0.35, friction: 0.4 }, false)] },
    { text: 'Everything is in the game. Let me look at the scene.', tools: [{ name: 'game_look', args: { what: 'scene', scene: 'Scene' } }] },
  ];
}
fs.writeFileSync('queue-' + part + '.json', JSON.stringify(queue));
console.log(part, queue.length, 'replies;', queue.reduce((n, r) => n + (r.tools?.length || 0), 0), 'calls');
