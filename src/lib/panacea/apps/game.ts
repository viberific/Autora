/**
 * The Game panels' adapter (docs/PANACEA-GAPS.md, G1): what a `game.*` control shows is read off the game in Autora
 * Games (the GDevelop project the server keeps), and moving it changes that project: the settings of the movement
 * behaviour on the object picked in the panel. Nothing about the game is kept on the canvas: the project is the one
 * source. The one value kept on the canvas is `game.object`, which object a control acts on.
 *
 * "Slippery" is the person's word for the behaviour's deceleration: a body that stops slowly slides. The rest of what a
 * game does is events the agent writes; the panels left for it (the level, enemies, win and lose, inventory, dialogue,
 * power-ups) hold the person's own choices and words for the agent to build, so the creative part stays theirs.
 *
 * Pure: shared by the server (which changes the project) and the page (which shows it).
 */
import type { Value } from "../atoms";

export const GAME_OBJECT = "game.object";

const GAME_BINDS = [GAME_OBJECT, "game.speed", "game.jump", "game.gravity", "game.friction"] as const;

/** Every `game.*` value something acts on: the adapter's, and what the panels that hold the person's choices keep. */
export const GAME_WIRED: readonly string[] = [
  ...GAME_BINDS, "game.tiles", "game.enemy", "game.aggro", "game.items", "game.lines", "game.powers", "game.win", "game.limit",
];

export const isGameBind = (bind: string): boolean => (GAME_BINDS as readonly string[]).includes(bind);

type Json = any;

/** The behaviours that move an object, with what each setting is called in them. */
const MOVERS = ["PlatformBehavior::PlatformerObjectBehavior", "TopDownMovementBehavior::TopDownMovementBehavior"];
const PLATFORMER = MOVERS[0]!;

/** How fast a body that stops quickest stops: the "grip" end of the Slippery slider. Slippery 0 is this; 100 is no braking. */
const GRIP = 2000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: Value): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

/** Every object the game has, scene objects and global ones, that moves by a behaviour. */
function movers(project: Json): Array<{ object: Json; behavior: Json }> {
  const all = [...list(project?.layouts).flatMap((l) => list(l?.objects)), ...list(project?.objects)];
  const seen = new Set<string>();
  const out: Array<{ object: Json; behavior: Json }> = [];
  for (const object of all) {
    if (!object || typeof object.name !== "string" || seen.has(object.name)) continue;
    const behavior = list(object.behaviors).find((b) => MOVERS.includes(b?.type));
    if (behavior) { seen.add(object.name); out.push({ object, behavior }); }
  }
  return out;
}

/** The objects a person can pick: those that move. */
export function gameOptions(project: Json): Array<{ value: string; label: string }> {
  return movers(project).map(({ object }) => ({ value: object.name, label: object.name }));
}

/** The object a control acts on: the one picked, else the first that moves. */
function mover(project: Json, picked: unknown): { object: Json; behavior: Json } | null {
  const all = movers(project);
  return all.find((m) => m.object.name === picked) ?? all[0] ?? null;
}

/** What a control shows, read off the game; undefined when it has nothing for it (no moving object, or no such setting). */
export function readGame(project: Json, bind: string, picked?: unknown): Value | undefined {
  if (bind === GAME_OBJECT) return mover(project, picked)?.object.name ?? "";
  const m = mover(project, picked);
  if (!m) return undefined;
  const b = m.behavior;
  switch (bind) {
    case "game.speed": return typeof b.maxSpeed === "number" ? Math.round(b.maxSpeed) : undefined;
    case "game.jump": return b.type === PLATFORMER && typeof b.jumpSpeed === "number" ? Math.round(b.jumpSpeed) : undefined;
    case "game.gravity": return b.type === PLATFORMER && typeof b.gravity === "number" ? Math.round(b.gravity) : undefined;
    case "game.friction": return typeof b.deceleration === "number" ? Math.round(clamp((1 - b.deceleration / GRIP) * 100, 0, 100)) : undefined;
  }
  return undefined;
}

/**
 * Changes the project, in place, to what a control was set to. Returns what was done, in a person's words, or an error
 * (a setting the object's behaviour does not have, like a jump on a top-down mover). `game.object` is not the game's.
 */
export function writeGame(project: Json, bind: string, v: Value, picked?: unknown): { did: string } | { error: string } {
  if (!isGameBind(bind) || bind === GAME_OBJECT) return { error: `nothing in the game answers to ${bind}` };
  const m = mover(project, picked);
  if (!m) return { error: "no object in the game moves by a behaviour yet: add a player with a Platformer or Top-down movement behaviour" };
  const n = num(v);
  if (n === null) return { error: "that is a number" };
  const b = m.behavior;
  const who = m.object.name;
  const platformer = b.type === PLATFORMER;
  switch (bind) {
    case "game.speed": b.maxSpeed = clamp(Math.round(n), 0, 1000); return { did: `${who} runs at ${b.maxSpeed}` };
    case "game.jump":
      if (!platformer) return { error: `${who} moves top-down and does not jump` };
      b.jumpSpeed = clamp(Math.round(n), 0, 1500); return { did: `${who} jumps at ${b.jumpSpeed}` };
    case "game.gravity":
      if (!platformer) return { error: `${who} moves top-down and has no gravity` };
      b.gravity = clamp(Math.round(n), 0, 3000); return { did: `${who} has gravity ${b.gravity}` };
    case "game.friction": b.deceleration = Math.round(GRIP * (1 - clamp(n, 0, 100) / 100)); return { did: `${who} is ${Math.round(clamp(n, 0, 100))}% slippery` };
  }
  return { error: `nothing in the game answers to ${bind}` };
}
