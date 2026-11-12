/**
 * Autora Games: the game window. The game lives on the server (server/gamedesk.ts) as the project file GDevelop saves, and
 * in the editor beside the chat; these tools are the agent's hands on the same game, so the person watches it change and can
 * change anything by hand. The engine's own list of what exists is in server/game-catalog.json.
 */

import type { ToolSpec } from "../tools";

export const gameSPECS: ToolSpec[] = [
  {
    name: "game_open",
    group: "files",
    description:
      "Open Autora Games (GDevelop's editor) beside the chat, on this chat's game, and say what is in it: its scenes, objects, " +
      "variables and resources. A chat has one game; the first call starts an empty one with a single scene. Pass `name` to " +
      "name the game. The other game tools open the window themselves.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A name for the game (its title in the project)." },
      },
    },
  },
  {
    name: "game_look",
    group: "files",
    description:
      "Read the game. `what`: overview (the whole game, the default), scene (one scene: objects with their behaviors and how many " +
      "instances, groups, layers, variables), object (one object in full, from `scene` or the global objects), events (a scene's " +
      "events as lines, each with the path that finds it: layouts[Scene].events[2].events[0]; `path` narrows it to one event and what " +
      "is under it, `depth` says how deep), instances (where an object is placed), resources, or json (any part of the project file, " +
      "by `path`). The person edits the same game: look again before relying on what you saw earlier.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["overview", "scene", "object", "events", "instances", "resources", "json"] },
        scene: { type: "string", description: "A scene's name. Optional when the game has one scene." },
        object: { type: "string", description: "An object's name (for object, or to narrow instances)." },
        path: { type: "string", description: "For events: a path inside the scene such as events[2]. For json: from the project, such as layouts[Scene].objects[Player].behaviors." },
        depth: { type: "number", description: "For events: how many levels of nested events to show. Default 4." },
      },
    },
  },
  {
    name: "game_edit",
    group: "files",
    risky: true,
    description:
      "Change the game: a list of ops, applied together or not at all. Each is { op, path, value }. `set` puts value at path; " +
      "`insert` adds value to the list at path (at `index`, or at the end); `remove` takes out what path names; `merge` adds the " +
      "keys of value to the object at path. A path is dots and [selectors] from the project file: layouts[Scene].objects[Player]" +
      ".behaviors, layouts[Scene].events, layouts[Scene].instances[0], properties, resources.resources. A selector is a position " +
      "(0, -1), a name (Player), or property=value (type=Sprite). The shapes of things are the editor's: copy them from game_template " +
      "and find instructions with game_catalog, never from memory. After it, the reply lists what looks wrong (an instruction the " +
      "engine does not have, the wrong number of parameters, a picture that is not in the resources); fix those before going on. " +
      "The person watches the editor change. Their creative choices stay theirs: ask before deciding the story, the look or the feel.",
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "The changes, in order.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set", "insert", "remove", "merge"] },
              path: { type: "string", description: "Where, from the project file: layouts[Scene].objects[Player]." },
              value: { description: "The new value (any JSON) for set, insert and merge." },
              index: { type: "number", description: "For insert: the position in the list. Default: the end." },
            },
            required: ["op", "path"],
          },
        },
      },
      required: ["ops"],
    },
  },
  {
    name: "game_play",
    group: "files",
    description:
      "Play the game and see it: it is started in the game window (the person watches it start), then run in a headless browser of its own with the keys, clicks and waits you give, and " +
      "you get pictures of the screen, the errors the game threw, how many frames it drew, and whether the screen changed. Use it after you build or change something, before you say it works: " +
      "does it start, does it throw, does anything move when the keys are pressed. You cannot hear it, and a still does not show how it feels to play: ask the person how it plays. " +
      "`script` is a list of steps, played in order: {press: key, ms?} taps a key (held ms, default 120); {hold: [keys], ms} holds up to four keys together; {wait: ms}; {click: [x, y]} on the " +
      "game's screen in pixels; {shot: label} takes a picture. Keys are a letter or digit, or ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Space, Enter, Escape, Tab, Shift, Control, Alt, Backspace. " +
      "With no shot in the script you get one after it starts and one at the end. At most 60 steps, 8 pictures, and 30 seconds of waiting and holding together. " +
      "`fresh` (the default) starts the game from the current project, which needs the window open with its editor running; fresh false plays the last preview the editor made, " +
      "which may be an earlier version (it says so).",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "array",
          description: "What the player does, in order. Leave out for a look at how it starts.",
          items: {
            type: "object",
            properties: {
              press: { type: "string", description: "A key to tap." },
              hold: { type: "array", items: { type: "string" }, description: "Keys to hold together (up to four)." },
              ms: { type: "number", description: "For press and hold: how long the key is down, in milliseconds." },
              wait: { type: "number", description: "Milliseconds to let the game run." },
              click: { type: "array", items: { type: "number" }, description: "[x, y] in pixels on the game's screen." },
              shot: { type: "string", description: "Take a picture, with this label." },
            },
          },
        },
        fresh: { type: "boolean", description: "Start the game from the current project first (default true)." },
        width: { type: "number", description: "The game screen's width in pixels. Default 800." },
        height: { type: "number", description: "The game screen's height in pixels. Default 600." },
      },
    },
  },
  {
    name: "game_check",
    group: "files",
    description:
      "Check the whole game for what would stop it working: instructions the engine does not have or with the wrong number of " +
      "parameters, instances of objects that do not exist, pictures missing from the resources, unknown object and behavior types, " +
      "duplicate names. Run it before you tell the person a game is ready.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "game_catalog",
    group: "files",
    description:
      "Look up what GDevelop's engine has: the actions, conditions and expressions (each with its exact `type` and the order of its " +
      "parameters), and the objects and behaviors. `query` is words (\"x position\", \"jump\", \"play sound\"); narrow with `kind` " +
      "(action, condition, expression, strExpression), `extension` (like PlatformBehavior) or `for` (an object type like Sprite, or " +
      "a behavior type); `list` is extensions, objects or behaviors. With no arguments it lists the extensions. Instructions on " +
      "'any object' work on every object. Use the `type` exactly as given as instruction.type.value in an event.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find, like \"set x position\"." },
        kind: { type: "string", enum: ["action", "condition", "expression", "strExpression"] },
        extension: { type: "string", description: "An extension's name, from list: extensions." },
        for: { type: "string", description: "An object type (Sprite, TextObject::Text) or a behavior type (PlatformBehavior::PlatformerObjectBehavior)." },
        list: { type: "string", enum: ["extensions", "objects", "behaviors"] },
        limit: { type: "number", description: "How many matches to show, up to 40. Default 12." },
      },
    },
  },
  {
    name: "game_template",
    group: "files",
    description:
      "The shape of a new thing as the editor saves it, to copy and fill in: kind is scene, layer, instance, object (with `type`, " +
      "like Sprite or TextObject::Text), behavior (with `type`), resource (with `type`: image, audio, font...), event, comment, group, " +
      "repeat, while, foreach, condition, action, variable, variable-structure or object-group. Put it into the game with game_edit insert.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string" },
        type: { type: "string", description: "For object, behavior and resource: which one." },
      },
      required: ["kind"],
    },
  },
  {
    name: "game_from_model",
    group: "files",
    risky: true,
    description:
      "Bring part of this chat's Autora 3D model into the game as a 3D object (it keeps its look: colours, materials, textures), " +
      "optionally with real 3D physics (rigid bodies on GDevelop's Jolt engine: it falls, collides, rolls, bounces, is pushed). " +
      "`shapes` are 3D shape or group names or ids (none: everything visible). The object follows the model from then on: when " +
      "the person changes those shapes in Autora 3D, the game's object is updated (its physics and placements stay). Call again with " +
      "`object` to change its physics, size or shapes. `physics` describes how it should behave: `feel` is words (heavy, light, " +
      "bouncy, dead, slippery, grippy, floaty, rolling, fixed, moved, upright) and numbers win over words: body (dynamic: falls and " +
      "is pushed; static: never moves, like a floor or a wall; kinematic: moved by events), shape (box, sphere, capsule, cylinder, " +
      "or mesh: the exact model, for a static body only), density, friction (0 to 1), bounce (0 to 1), gravity (times the world's), " +
      "damping, upright (never tips). `physics: false` takes it off. `place` puts one in the scene (true: the middle of the screen; " +
      "or {x, y, z} in pixels, z up); a dynamic body starts a little above the floor. `ground: true` adds a floor that stays put. " +
      "`scale` is pixels per mm (default 1; GDevelop's physics counts 100 pixels as a metre). How it feels is the person's: suggest, " +
      "and set what they ask; every number stays theirs to change in Panacea's 3D physics panel or the editor.",
    parameters: {
      type: "object",
      properties: {
        shapes: { type: "array", items: { type: "string" }, description: "3D shape or group names or ids. Default: everything visible." },
        object: { type: "string", description: "The game object's name: a new one, or one made from the model before, to update it." },
        scene: { type: "string", description: "The scene. Default: the first." },
        physics: {
          description: "How it behaves: words and numbers, or false to take physics off.",
          oneOf: [
            { type: "boolean", enum: [false] },
            {
              type: "object",
              properties: {
                feel: { type: "array", items: { type: "string", enum: ["heavy", "light", "bouncy", "dead", "slippery", "grippy", "floaty", "rolling", "fixed", "moved", "upright"] } },
                body: { type: "string", enum: ["dynamic", "static", "kinematic"] },
                shape: { type: "string", enum: ["box", "sphere", "capsule", "cylinder", "mesh"] },
                density: { type: "number", minimum: 0.01, maximum: 100 },
                friction: { type: "number", minimum: 0, maximum: 1 },
                bounce: { type: "number", minimum: 0, maximum: 1 },
                gravity: { type: "number", minimum: -5, maximum: 5 },
                damping: { type: "number", minimum: 0, maximum: 10 },
                upright: { type: "boolean" },
              },
            },
          ],
        },
        place: { description: "Put one in the scene: true (the middle of the screen) or {x, y, z} in pixels. Default: true for a new object.", oneOf: [{ type: "boolean" }, { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } }] },
        ground: { type: "boolean", description: "Add a floor that stays put (once), so falling things land." },
        scale: { type: "number", description: "Pixels per mm. Default 1." },
        follow: { type: "boolean", description: "Keep following the 3D model (default true). false: the object stays as it is now." },
      },
    },
  },
  {
    name: "game_import",
    group: "files",
    description:
      "Add a file to the game's resources: a picture, sound, font, video, 3D model or json, from an artifact id (file_...) or a path on " +
      "this host. It is kept with the game and added to resources.resources under `resource` (default: the file's name); then use that " +
      "name in objects and instructions.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "An artifact id (file_...) or a path." },
        name: { type: "string", description: "The file's name, with its extension, if it has none worth keeping." },
        resource: { type: "string", description: "The name objects will use for it. Default: the file's name." },
      },
      required: ["file"],
    },
  },
];
