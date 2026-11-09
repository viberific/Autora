import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Node renders the same component; only the browser's stylesheet import is skipped.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/ConversationFlow.css")) {
      return { format: "module", source: "", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { ConversationFlow } = await import("../src/components/panacea/ConversationFlow");
hooks.deregister();
const { FLOAT_GAP, FLOAT_MIN_W, FLOAT_SNAP, clampFloat, defaultFloat, magnet, nudgeFloat, previewOf, resizeFloat } = await import("../src/components/panacea/chatLayout");

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test("renders original history, actions and composer controls in their slots", () => {
  const history = h("div", { className: "thread-wrap" },
    h("div", { className: "thread" }, h("div", { className: "thread-content" },
      ...Array.from({ length: 100 }, (_, index) =>
        h("article", { className: "turn", key: index }, h("div", { className: "msg user" }, `history-${index}`))),
      h("button", { "data-action": "permission" }, "Allow"),
      h("button", { "data-action": "choice" }, "Choose"))));
  const entry = h("form", { className: "composer" },
    h("textarea", { name: "message", defaultValue: "unsent draft" }),
    ...["attach", "tools", "mode", "dictate", "talk", "send", "stop"].map((action) =>
      h("button", { key: action, "data-action": action }, action)));
  const html = renderToStaticMarkup(h(ConversationFlow, {
    conversation: history,
    entry,
    todos: h("button", { "data-slot": "todos" }, "Current task"),
    workNavigation: h("button", { "data-slot": "navigation" }, "Show all work"),
  }));
  assert.equal((html.match(/class="turn"/g) ?? []).length, 100);
  assert.ok(html.indexOf("history-0<") < html.indexOf("history-99<"));
  for (const action of ["permission", "choice", "attach", "tools", "mode", "dictate", "talk", "send", "stop"]) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  assert.match(html, /<textarea name="message">unsent draft<\/textarea>/);
  assert.ok(html.indexOf('data-slot="todos"') < html.indexOf('<form class="composer"'));
  assert.ok(html.indexOf('<form class="composer"') < html.indexOf('data-slot="navigation"'));
  assert.match(html, /aria-label="Conversation with Autora"/);
  assert.doesNotMatch(html, /role="log"|aria-live=/, "stream announcements remain owned by Thread");
});

test("optional slots are absent, and labels are escaped by React", () => {
  const html = renderToStaticMarkup(h(ConversationFlow, {
    conversation: h("div", null, "Live reply"),
    entry: h("textarea", { defaultValue: "Ask Autora" }),
    conversationLabel: 'Conversation "one" <two>',
  }));
  assert.doesNotMatch(html, /conversation-flow__todos|conversation-flow__work-navigation/);
  assert.match(html, /aria-label="Conversation &quot;one&quot; &lt;two&gt;"/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
});

test("a phone's retraction keeps history mounted and todos/composer outside the inert region; a desktop never retracts", () => {
  const conversation = h("div", { className: "thread-wrap", "data-state": "kept" }, "Old and live messages");
  const slots = {
    conversation,
    entry: h("textarea", { defaultValue: "kept draft" }),
    todos: h("button", { "data-slot": "todos" }, "Task in progress"),
    workNavigation: h("button", { "data-slot": "navigation" }, "Zoom out"),
    onToggle: () => undefined,
    phone: true,
  };
  const open = renderToStaticMarkup(h(ConversationFlow, slots));
  const closed = renderToStaticMarkup(h(ConversationFlow, { ...slots, collapsed: true }));
  for (const html of [open, closed]) {
    assert.match(html, /data-state="kept">Old and live messages/);
    assert.match(html, /<textarea>kept draft<\/textarea>/);
    assert.match(html, /data-slot="todos">Task in progress/);
    assert.ok(html.indexOf("</section>") < html.indexOf('data-slot="todos"'));
    // No speech-bubble button anywhere: the sheet's handle and preview open and close it.
    assert.doesNotMatch(html, /conversation-flow__toggle|conversation-flow__edge/);
  }
  assert.match(closed, /conversation-flow is-collapsed is-sheet/);
  assert.match(closed, /<section[^>]*aria-hidden="true"[^>]*inert=""/);
  assert.doesNotMatch(open, /<section[^>]*\s(?:aria-hidden|inert)=/);
  assert.doesNotMatch(closed, /<section[^>]*\shidden=/);
  const desktop = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: false, collapsed: true }));
  assert.match(desktop, /class="conversation-flow is-float"/);
  assert.doesNotMatch(desktop, /is-collapsed|<section[^>]*\s(?:aria-hidden|inert)=|conversation-flow__toggle|conversation-flow__edge/);
});

test("desktop gets a move grip and resize handles on every edge; a phone gets the sheet handle", () => {
  const slots = { conversation: h("div", null, "history"), entry: h("textarea"), onToggle: () => undefined };
  const desktop = renderToStaticMarkup(h(ConversationFlow, { ...slots, workNavigation: h("i", { "data-slot": "navigation" }) }));
  // Two controls in its top corners: Move at the left, the pull at the right. No bar or line along its top.
  assert.match(desktop, /<button class="conversation-flow__move" type="button" aria-label="Move conversation"/);
  assert.doesNotMatch(desktop, /conversation-flow__bar|conversation-flow__grip/);
  for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) assert.match(desktop, new RegExp(`class="conversation-flow__size" data-edge="${edge}"`));
  assert.equal((desktop.match(/role="separator"/g) ?? []).length, 1, "one keyboard resize handle, the top-right pull");
  assert.match(desktop, /data-edge="ne" role="separator" tabindex="0" aria-label="Resize conversation"[^>]*><svg/);
  assert.doesNotMatch(desktop, /role="slider"/);
  // The work rail stands on the world, not inside the window that floats over it.
  assert.ok(desktop.lastIndexOf("</div>", desktop.indexOf('data-slot="navigation"')) > desktop.indexOf("conversation-flow__entry"));
  assert.match(desktop, /<\/div><div class="conversation-flow__work-navigation"/);
  const phone = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true, sheet: "full" }));
  assert.match(phone, /conversation-flow is-sheet is-full/);
  assert.match(phone, /role="slider"[^>]*aria-label="Conversation size"[^>]*aria-valuenow="2"[^>]*aria-valuetext="Full"/);
  assert.doesNotMatch(phone, /role="separator"|conversation-flow__move|conversation-flow__size/);
  const peek = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true, collapsed: true }));
  assert.match(peek, /aria-valuenow="0"[^>]*aria-valuetext="Canvas only"/);
});

test("the window opens at the bottom left, is held inside the world, and the magnet pulls it onto a side", () => {
  const room = { w: 1400, h: 900 };
  const start = defaultFloat(room);
  assert.deepEqual(start, { x: FLOAT_GAP, y: 900 - 600 - FLOAT_GAP, w: 360, h: 600, snap: "left" });
  // A short world: as tall as it allows, still a gap from the top and the foot.
  assert.deepEqual(defaultFloat({ w: 1000, h: 500 }), { x: FLOAT_GAP, y: FLOAT_GAP, w: 360, h: 500 - FLOAT_GAP * 2, snap: "left" });
  // Free in the middle; near a side, pulled onto it; past an edge, kept a gap inside.
  assert.equal(magnet({ ...start, x: 500, snap: null }, room).snap, null);
  assert.deepEqual(magnet({ ...start, x: FLOAT_GAP + FLOAT_SNAP - 4, snap: null }, room), { ...start, x: FLOAT_GAP, snap: "left" });
  const right = magnet({ ...start, x: 1400 - 360 - FLOAT_GAP - 20, snap: null }, room);
  assert.deepEqual(right, { ...start, x: 1400 - 360 - FLOAT_GAP, snap: "right" });
  assert.deepEqual(clampFloat({ ...start, x: -300, y: 5000, snap: null }, room), { ...start, x: FLOAT_GAP, y: 900 - 600 - FLOAT_GAP, snap: null });
  // By keyboard a step is shorter than the magnet's reach: one step off a side frees it, a step back against it holds it.
  const stepped = nudgeFloat(start, 16, 0, room);
  assert.deepEqual(stepped, { ...start, x: FLOAT_GAP + 16, snap: null });
  assert.deepEqual(nudgeFloat(stepped, -16, 0, room), start);
  assert.deepEqual(nudgeFloat(start, 0, -16, room), { ...start, y: start.y - 16 }, "up and down, it stays held");
  assert.equal(nudgeFloat({ ...start, x: 1400 - 360 - FLOAT_GAP - 10, snap: null }, 16, 0, room).snap, "right");
  // Held to the right, it stays there when the world grows.
  assert.equal(clampFloat(right, { w: 1800, h: 900 }).x, 1800 - 360 - FLOAT_GAP);
});

test("resizing moves only the dragged edges and keeps the window's minimum and the world's gap", () => {
  const room = { w: 1400, h: 900 };
  const box = { x: 300, y: 200, w: 400, h: 500, snap: null };
  assert.deepEqual(resizeFloat(box, "se", 60, 40, room), { x: 300, y: 200, w: 460, h: 540, snap: null });
  assert.deepEqual(resizeFloat(box, "nw", -50, -30, room), { x: 250, y: 170, w: 450, h: 530, snap: null });
  assert.deepEqual(resizeFloat(box, "w", 400, 0, room), { x: 700 - FLOAT_MIN_W, y: 200, w: FLOAT_MIN_W, h: 500, snap: null });
  assert.deepEqual(resizeFloat(box, "n", 0, -900, room), { x: 300, y: FLOAT_GAP, w: 400, h: 700 - FLOAT_GAP, snap: null });
  assert.equal(resizeFloat(box, "s", 0, 2000, room).h, 900 - FLOAT_GAP - 200);
  // Held to the left: its right edge resizes it and it stays held; pulling its left edge away lets it go.
  const held = { x: FLOAT_GAP, y: 200, w: 400, h: 500, snap: "left" as const };
  assert.equal(resizeFloat(held, "e", 80, 0, room).snap, "left");
  assert.equal(resizeFloat(held, "w", 30, 0, room).snap, null);
  assert.equal(resizeFloat(held, "w", 30, 0, room).x, FLOAT_GAP + 30);
});

test("a retracted phone sheet previews the last two things said and opens on a tap; a desktop strip does not", () => {
  const lines = previewOf([
    { role: "user", text: "Make it **blue**" },
    { role: "agent", text: "" },
    { role: "agent", text: "Done.\n\nSee [the file](http://x) `now`." },
  ]);
  assert.deepEqual(lines, [{ who: "You", text: "Make it blue" }, { who: "Autora", text: "Done. See the file now." }]);
  const slots = { conversation: h("div", null, "history"), entry: h("textarea"), onToggle: () => undefined, preview: lines, collapsed: true };
  const phone = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true }));
  assert.match(phone, /class="conversation-flow__preview"[^>]*aria-label="Open the conversation\. You: Make it blue Autora: Done\./);
  assert.ok(phone.indexOf("</section>") < phone.indexOf("conversation-flow__preview"));
  // Drawn whenever the sheet is on a phone, so it can fade into the messages while the sheet moves; it is out of the
  // tab order and hidden by CSS unless the sheet is retracted or moving.
  const open = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true, collapsed: false }));
  assert.match(open, /class="conversation-flow__preview"[^>]*tabindex="-1"/);
  assert.match(phone, /class="conversation-flow__preview"[^>]*tabindex="0"/);
  assert.doesNotMatch(renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: false })), /conversation-flow__preview/);
  assert.match(renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true, hiddenSteps: 3 })), /3 steps and memory notes hidden/);
  assert.doesNotMatch(phone, /memory notes hidden/);
  const css = fs.readFileSync(new URL("../src/components/panacea/ConversationFlow.css", import.meta.url), "utf8");
  assert.match(css, /\.conversation-flow__preview\s*\{[^}]*min-height: 44px;/);
  // The three views run into one another: the preview by --flow-p, the steps and the list's anchor by --flow-q.
  assert.match(css, /\.conversation-flow__preview\s*\{[^}]*\n\s*\}[\s\S]*opacity: calc\(1 - var\(--flow-p, 0\) \* 1\.8\)/);
  assert.match(css, /\.flow-detail\s*\{[^}]*max-height: calc\(var\(--flow-q, 0\) \* 90px\);[^}]*opacity: var\(--flow-q, 0\)/);
  assert.match(css, /\.conversation-flow__entry \.composer textarea\s*\{[^}]*flex: 1 1 auto;[^}]*max-height: min\(18dvh, 160px\);/);
});

test("on a desktop it floats over the world as glass, keeps the history mounted, and speaks the tokens", () => {
  const css = fs.readFileSync(new URL("../src/components/panacea/ConversationFlow.css", import.meta.url), "utf8");
  // A window over the world, not a column of the layout: the canvas keeps the whole region.
  assert.match(css, /\.conversation-flow\.is-float\s*\{[^}]*position: absolute;[^}]*z-index: var\(--z-pop\);[^}]*left: 16px;[^}]*bottom: 16px;/);
  assert.match(css, /\.conversation-flow\.is-float\s*\{[^}]*border-radius: var\(--r-xl\);/);
  // As tall as what has been said, up to the height it was given: no empty glass above a short chat.
  assert.match(css, /\.conversation-flow\.is-float\s*\{[^}]*height: auto;[^}]*max-height: min\(600px, calc\(100% - 32px\)\);/);
  assert.doesNotMatch(css, /conversation-flow__bar|conversation-flow__grip/);
  assert.match(css, /\.chat-view\.pw-full-workspace > \.pw-scene-stack\s*\{[^}]*position: relative;[^}]*flex: 1 1 0;/);
  // The frost is on ::before: a filter on the window would pin a maximised card or widget in the thread inside it.
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*backdrop-filter: (?!none)[^}]*)\}/g)) {
    assert.match(rule[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), /^\.conversation-flow\.is-(?:float|sheet)::before$/, `only the window's and the sheet's ::before frost (${rule[1].trim()})`);
  }
  assert.match(css, /\.conversation-flow\.is-float:has\(\.pdf-window\.is-full, \.app-window\.is-full, \.cell\.widget\.is-expanded, \.cell\.shot\.is-max\)\s*\{\s*z-index: var\(--z-over\);/);
  // The magnet: a short glide onto the side, and the side lights while it is held there.
  assert.match(css, /\[data-moving="move"\]\[data-snap\]\s*\{\s*transition: left var\(--dur-1\)/);
  assert.match(css, /\.conversation-flow\.is-float\[data-moving\]\[data-snap\]::after\s*\{\s*opacity: 1;/);
  assert.match(css, /\.conversation-flow \.turn\s*\{[^}]*content-visibility: visible;[^}]*contain-intrinsic-size: none;/);
  assert.match(css, /\.conversation-flow__entry,[\s\S]*?pointer-events: auto;/);
  assert.match(css, /\.conversation-flow \.msg\.user\s*\{[^}]*margin-left: auto;/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // The root, the column and the history never clip or scroll their own content (the preview line's
  // ellipsis is the one place overflow is wanted).
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim());
    const guarded = selectors.some((s) => /^\.conversation-flow(?:\.[\w-]+)*(?:\s+\.conversation-flow__(?:column|conversation))?$|^\.conversation-flow__(?:column|conversation)$/.test(s));
    if (guarded) assert.doesNotMatch(rule[2], /(?:^|[\s;])(?:contain|overflow(?:-[xy])?|transform):/, `${selectors.join(", ")} must not clip, scroll or transform`);
  }
  assert.match(css, /\.conversation-flow__preview-line\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
  // Only position, transform and opacity move: no transition or animation names the window's width or height.
  for (const found of css.matchAll(/(?:^|\n)\s*(?:transition|animation):[^;]*/g)) assert.doesNotMatch(found[0], /width|height|flex/);
  assert.match(css, /\.conversation-flow \.msg\s*\{[^}]*mask-image: var\(--flow-edge-mask, none\);/);
  assert.doesNotMatch(css, /conversation-flow__conversation::before|scrim|linear-gradient/);
  assert.match(css, /\.conversation-flow\.is-collapsed \.conversation-flow__conversation\s*\{[^}]*visibility: hidden;/);
  assert.match(css, /\.conversation-flow\.is-collapsed \.conversation-flow__conversation\s*\{[^}]*height: var\(--flow-history-height/);
  assert.doesNotMatch(css, /\.conversation-flow\.is-collapsed[^}]*display: none/);
  assert.doesNotMatch(css, /conversation-flow__toggle|conversation-flow__edge|is-panel/);
  // The rail stands on the world's far edge, and steps aside for a window held to the right.
  assert.match(css, /\.conversation-flow__work-navigation\s*\{[^}]*position: absolute;[^}]*right: 16px;/);
  assert.match(css, /> \.conversation-flow__work-navigation\s*\{\s*right: calc\(16px \+ var\(--flow-held-right, 0px\)\);/);
  assert.doesNotMatch(css, /font-size:\s*[\d.]|border-radius:\s*(?!0\s*;)[\d.]|#[\da-f]{3,8}\b|rgba?\(\s*\d|(?:animation|transition):[^;]*\d(?:ms|s)\b/i);
});

console.log(`${passed} conversation flow tests passed`);
