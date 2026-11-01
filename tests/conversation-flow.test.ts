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
const { previewOf } = await import("../src/components/panacea/chatLayout");

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

test("retraction keeps history mounted and todos/composer outside the inert region", () => {
  const conversation = h("div", { className: "thread-wrap", "data-state": "kept" }, "Old and live messages");
  const slots = {
    conversation,
    entry: h("textarea", { defaultValue: "kept draft" }),
    todos: h("button", { "data-slot": "todos" }, "Task in progress"),
    workNavigation: h("button", { "data-slot": "navigation" }, "Zoom out"),
    onToggle: () => undefined,
  };
  const open = renderToStaticMarkup(h(ConversationFlow, slots));
  const closed = renderToStaticMarkup(h(ConversationFlow, { ...slots, collapsed: true }));
  for (const html of [open, closed]) {
    assert.match(html, /data-state="kept">Old and live messages/);
    assert.match(html, /<textarea>kept draft<\/textarea>/);
    assert.match(html, /data-slot="todos">Task in progress/);
    assert.ok(html.indexOf("</section>") < html.indexOf('data-slot="todos"'));
    assert.ok(html.indexOf("</section>") < html.indexOf('class="conversation-flow__toggle"'));
    assert.match(html, /aria-controls="[^"]+"/);
  }
  assert.match(closed, /conversation-flow is-collapsed/);
  assert.match(closed, /<section[^>]*aria-hidden="true"[^>]*inert=""/);
  assert.match(closed, /aria-expanded="false"[^>]*aria-label="Show conversation"/);
  assert.match(open, /aria-expanded="true"[^>]*aria-label="Retract conversation"/);
  // One icon, no words: the control's glyph is the same open or retracted, and it shows no text.
  const toggleOf = (html: string) => /<button[^>]*conversation-flow__toggle[^>]*>(.*?)<\/button>/.exec(html)?.[1] ?? "";
  assert.match(toggleOf(open), /^<svg[^>]*aria-hidden="true"[^>]*>.*<\/svg>$/);
  assert.equal(toggleOf(open), toggleOf(closed));
  assert.doesNotMatch(open, /<section[^>]*\s(?:aria-hidden|inert)=/);
  assert.doesNotMatch(closed, /<section[^>]*\shidden=/);
});

test("desktop gets a resize separator and edge tab; a phone gets the sheet handle", () => {
  const slots = { conversation: h("div", null, "history"), entry: h("textarea"), onToggle: () => undefined };
  const desktop = renderToStaticMarkup(h(ConversationFlow, { ...slots, width: 420 }));
  assert.match(desktop, /role="separator"[^>]*aria-label="Resize conversation panel"[^>]*aria-valuenow="420"/);
  assert.match(desktop, /class="conversation-flow__edge"/);
  assert.doesNotMatch(desktop, /role="slider"/);
  const closed = renderToStaticMarkup(h(ConversationFlow, { ...slots, collapsed: true }));
  assert.doesNotMatch(closed, /role="separator"/, "a retracted panel has no edge to drag");
  const phone = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true, sheet: "full" }));
  assert.match(phone, /conversation-flow is-sheet is-full/);
  assert.match(phone, /role="slider"[^>]*aria-label="Conversation size"[^>]*aria-valuenow="2"[^>]*aria-valuetext="Full"/);
  assert.doesNotMatch(phone, /role="separator"|conversation-flow__edge/);
  const peek = renderToStaticMarkup(h(ConversationFlow, { ...slots, phone: true, collapsed: true }));
  assert.match(peek, /aria-valuenow="0"[^>]*aria-valuetext="Canvas only"/);
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

test("layout docks beside the canvas, keeps the history mounted, and speaks the tokens", () => {
  const css = fs.readFileSync(new URL("../src/components/panacea/ConversationFlow.css", import.meta.url), "utf8");
  // A region of the layout, not an overlay: the canvas is a sibling that gives way.
  assert.doesNotMatch(css, /\.conversation-flow\s*\{[^}]*(?:position: absolute|inset: 0)/);
  assert.match(css, /\.conversation-flow\s*\{[^}]*flex: 0 0 clamp\(/);
  assert.match(css, /\.pw-scene-stack\s*\{[^}]*position: relative;/);
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
    if (guarded) assert.doesNotMatch(rule[2], /(?:^|[\s;])(?:contain|overflow(?:-[xy])?):/, `${selectors.join(", ")} must not clip or scroll`);
  }
  assert.match(css, /\.conversation-flow__preview-line\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
  // Only transform and opacity move: no transition or animation names the panel's width or height.
  for (const found of css.matchAll(/(?:^|\n)\s*(?:transition|animation):[^;]*/g)) assert.doesNotMatch(found[0], /width|height|flex/);
  assert.match(css, /\.conversation-flow \.msg\s*\{[^}]*mask-image: var\(--flow-edge-mask, none\);/);
  assert.doesNotMatch(css, /conversation-flow__conversation::before|scrim|linear-gradient/);
  for (const rule of css.matchAll(/backdrop-filter:\s*([^;]+)/g)) assert.equal(rule[1], "none");
  assert.match(css, /\.conversation-flow\.is-collapsed \.conversation-flow__conversation\s*\{[^}]*visibility: hidden;/);
  assert.match(css, /\.conversation-flow\.is-collapsed \.conversation-flow__conversation\s*\{[^}]*height: var\(--flow-history-height/);
  assert.doesNotMatch(css, /\.conversation-flow\.is-collapsed[^}]*display: none/);
  assert.match(css, /\.conversation-flow__work-navigation\s*\{[^}]*position: absolute;[^}]*right: calc\(100% \+/);
  assert.doesNotMatch(css, /font-size:\s*[\d.]|border-radius:\s*(?!0\s*;)[\d.]|#[\da-f]{3,8}\b|rgba?\(\s*\d|(?:animation|transition):[^;]*\d(?:ms|s)\b/i);
});

console.log(`${passed} conversation flow tests passed`);
