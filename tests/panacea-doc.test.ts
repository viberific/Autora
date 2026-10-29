/**
 * Panacea's document engine: a document made from text, read back from disk, its parameters read off the selection and
 * applied to it, and the agent's block-level hands (replace, insert, delete, format).
 *
 *   npx tsx tests/panacea-doc.test.ts
 */
import assert from "node:assert/strict";
import { TextSelection } from "prosemirror-state";
import {
  applyParam, blocksOf, createDoc, deleteBlock, docStateOf, formatBlock, insertBlocks, listing, outlineOf, paramsFromState,
  plainText, readDocState, replaceBlockText, stateOf, toMarkdown, wordCount,
} from "../src/lib/panacea/document";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const MD = "# Plan\n\nWe **start** small and *grow*.\n\n## Steps\n\n- one\n- two\n\n1. first\n2. second\n\n> a quote\n\n```\ncode here\n```\n";

/** The state with the caret (or a range) in the first block whose text contains `needle`. */
function at(state: ReturnType<typeof stateOf>, needle: string, to?: string) {
  let found = -1;
  state.doc.descendants((node, pos) => { if (found < 0 && node.isTextblock && node.textContent.includes(needle)) found = pos + 1 + node.textContent.indexOf(needle); });
  assert.ok(found >= 0, `no block with "${needle}"`);
  const end = to === undefined ? found : found + to.length;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, found, end)));
}

test("text becomes blocks: headings, marks, bullets, numbers, a quote, code, each with its own id", () => {
  const s = stateOf(createDoc(MD));
  assert.deepEqual(blocksOf(s.doc).map((b) => b.kind), ["h1", "p", "h2", "bullet", "bullet", "number", "number", "quote", "code"]);
  const ids = blocksOf(s.doc).map((b) => b.id);
  assert.ok(ids.every(Boolean) && new Set(ids).size === ids.length, "every block has a unique id");
  assert.deepEqual(outlineOf(s.doc).map((h) => `${h.level} ${h.text}`), ["1 Plan", "2 Steps"]);
  assert.equal(blocksOf(s.doc)[1]!.text, "We start small and grow.");
  assert.equal(stateOf(createDoc("")).doc.childCount, 1, "blank is one empty paragraph");
});

test("a document reads back from its JSON, and what is not one is refused", () => {
  const d = createDoc(MD, "agent");
  const back = readDocState(JSON.parse(JSON.stringify(d)))!;
  assert.equal(back.mode, "agent");
  assert.equal(plainText(stateOf(back).doc), plainText(stateOf(d).doc));
  assert.equal(readDocState({ json: { type: "nonsense" } }), null);
  assert.equal(readDocState(null), null);
  assert.equal(readDocState({ json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(1_600_000) }] }] } }), null, "too large");
  assert.equal(readDocState({ ...d, mode: "bogus" })!.mode, "guide", "an unknown mode is the safe one");
  // A selection outside the document is brought inside rather than refused.
  const far = readDocState({ ...d, sel: { anchor: 99999, head: -4 } })!;
  assert.ok(far.sel!.anchor <= stateOf(d).doc.content.size);
});

test("the parameters follow the selection", () => {
  const s = stateOf(createDoc(MD));
  assert.equal(paramsFromState(at(s, "Plan")).block, "h1");
  assert.equal(paramsFromState(at(s, "Steps")).block, "h2");
  assert.equal(paramsFromState(at(s, "start", "start")).bold, true, "bold text selected");
  assert.equal(paramsFromState(at(s, "small")).bold, false);
  assert.equal(paramsFromState(at(s, "grow", "grow")).italic, true);
  assert.equal(paramsFromState(at(s, "one")).list, "bullets");
  assert.equal(paramsFromState(at(s, "second")).list, "numbers");
  assert.equal(paramsFromState(at(s, "a quote")).block, "quote");
  assert.equal(paramsFromState(at(s, "code here")).block, "code");
  const p = paramsFromState(s);
  assert.equal(p.words, wordCount(s.doc));
  assert.equal(p.font, "Inter");
  assert.equal(p.size, 11);
});

test("setting a parameter applies it to the selection", () => {
  const s = stateOf(createDoc(MD));
  const bold = applyParam(at(s, "small", "small"), "bold", true)!;
  assert.ok(toMarkdown(bold.doc).includes("**small**"));
  assert.equal(paramsFromState(bold).bold, true);
  assert.equal(applyParam(bold, "bold", true), null, "already so: nothing to do");
  assert.ok(!toMarkdown(applyParam(bold, "bold", false)!.doc).includes("**small**"));

  const heading = applyParam(at(s, "We **start**".replace(/\*/g, "")), "block", "h3")!;
  assert.equal(blocksOf(heading.doc)[1]!.kind, "h3");
  const centred = applyParam(at(s, "Plan"), "align", "center")!;
  assert.equal(paramsFromState(centred).align, "center");

  const ink = applyParam(at(s, "small", "small"), "ink", "#c2410c")!;
  assert.equal(paramsFromState(ink).ink, "#c2410c");
  assert.equal(paramsFromState(applyParam(ink, "ink", "#1c1c1f")!).ink, "#1c1c1f", "the default colour removes it");
});

test("lists: a paragraph becomes a list, a list changes kind, an item leaves", () => {
  const s = stateOf(createDoc("alpha\n\nbeta\n"));
  const bullets = applyParam(at(s, "alpha"), "list", "bullets")!;
  assert.equal(blocksOf(bullets.doc)[0]!.kind, "bullet");
  const numbers = applyParam(at(bullets, "alpha"), "list", "numbers")!;
  assert.equal(blocksOf(numbers.doc)[0]!.kind, "number");
  assert.equal(numbers.doc.child(0).type.name, "ordered_list");
  const out = applyParam(at(numbers, "alpha"), "list", "none")!;
  assert.equal(blocksOf(out.doc)[0]!.kind, "p");
  assert.equal(applyParam(at(s, "alpha"), "list", "none"), null, "not in a list: nothing to do");
});

test("a quote is entered and left; a heading from inside a quote leaves it first", () => {
  const s = stateOf(createDoc("plain\n"));
  const quoted = applyParam(at(s, "plain"), "block", "quote")!;
  assert.equal(paramsFromState(at(quoted, "plain")).block, "quote");
  const heading = applyParam(at(quoted, "plain"), "block", "h2")!;
  assert.equal(blocksOf(heading.doc)[0]!.kind, "h2", "no longer a quote");
  const back = applyParam(at(quoted, "plain"), "block", "paragraph")!;
  assert.equal(blocksOf(back.doc)[0]!.kind, "p");
});

test("the document's own font, size and line height are checked and clamped; derived and unknown ones are refused", () => {
  const s = stateOf(createDoc("x"));
  assert.equal(paramsFromState(applyParam(s, "font", "Georgia")!).font, "Georgia");
  assert.equal(applyParam(s, "font", "Comic Sans"), null);
  assert.equal(paramsFromState(applyParam(s, "size", 500)!).size, 32, "clamped to the top");
  assert.equal(paramsFromState(applyParam(s, "leading", 0.1)!).leading, 1, "clamped to the bottom");
  assert.equal(applyParam(s, "size", "big" as never), null);
  assert.equal(applyParam(s, "words", 9), null, "worked out, not set");
  assert.equal(applyParam(s, "nonsense", 1), null);
  assert.equal(applyParam(s, "block", "h9"), null);
});

test("the agent's hands: replace a block's words, insert Markdown after one, delete one", () => {
  const s = stateOf(createDoc(MD));
  const id = (needle: string) => blocksOf(s.doc).find((b) => b.text.includes(needle))!.id;

  const replaced = replaceBlockText(s, id("small"), "We begin with **care**.");
  assert.ok(typeof replaced !== "string");
  if (typeof replaced !== "string") assert.ok(toMarkdown(replaced.doc).includes("We begin with **care**."));

  const inserted = insertBlocks(s, id("Plan"), "Intro line.\n\n- a\n- b");
  assert.ok(typeof inserted !== "string");
  if (typeof inserted !== "string") {
    assert.deepEqual(blocksOf(inserted.doc).slice(0, 4).map((b) => b.kind), ["h1", "p", "bullet", "bullet"]);
    assert.equal(blocksOf(inserted.doc)[1]!.text, "Intro line.");
    assert.ok(blocksOf(inserted.doc).every((b) => b.id), "inserted blocks get ids");
  }
  const atStart = insertBlocks(s, null, "First.");
  assert.ok(typeof atStart !== "string");
  if (typeof atStart !== "string") assert.equal(blocksOf(atStart.doc)[0]!.text, "First.");

  const gone = deleteBlock(s, id("one"));
  assert.ok(typeof gone !== "string");
  if (typeof gone !== "string") assert.deepEqual(blocksOf(gone.doc).filter((b) => b.kind === "bullet").map((b) => b.text), ["two"]);

  assert.match(String(replaceBlockText(s, "nope", "x")), /no block nope/);
  assert.match(String(insertBlocks(s, "nope", "x")), /no block nope/);
  assert.match(String(deleteBlock(s, "nope")), /no block nope/);
  assert.match(String(insertBlocks(s, null, "   ")), /nothing to insert/);
});

test("deleting the last block leaves an empty paragraph; deleting the last item takes its list", () => {
  const one = stateOf(createDoc("only"));
  const left = deleteBlock(one, blocksOf(one.doc)[0]!.id);
  assert.ok(typeof left !== "string");
  if (typeof left !== "string") assert.deepEqual(blocksOf(left.doc).map((b) => b.text), [""]);
  const list = stateOf(createDoc("- solo\n\nafter"));
  const gone = deleteBlock(list, blocksOf(list.doc)[0]!.id);
  assert.ok(typeof gone !== "string");
  if (typeof gone !== "string") assert.deepEqual(blocksOf(gone.doc).map((b) => b.kind), ["p"], "no empty list left behind");
});

test("formatting a block by id leaves the person's selection where it was", () => {
  const s = at(stateOf(createDoc(MD)), "grow", "grow");
  const before = [s.selection.anchor, s.selection.head];
  const target = blocksOf(s.doc).find((b) => b.text.includes("Steps"))!.id;
  const out = formatBlock(s, target, "align", "right");
  assert.ok(typeof out !== "string");
  if (typeof out !== "string") {
    assert.deepEqual([out.selection.anchor, out.selection.head], before);
    assert.equal(paramsFromState(at(out, "Steps")).align, "right");
  }
  assert.match(String(formatBlock(s, "nope", "bold", true)), /no block nope/);
  assert.match(String(formatBlock(s, target, "words", 5)), /cannot be set/);
});

test("Markdown round-trips: what is written is what is read, and the agent's listing names every block", () => {
  const md = "# Title\n\nSome **bold** and *slanted* and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```\nlet z\n```\n\n---";
  assert.equal(toMarkdown(stateOf(createDoc(md)).doc), md);
  const list = listing(stateOf(createDoc(md)).doc).split("\n");
  assert.equal(list.length, 8, "eight blocks of text; the rule holds none");
  assert.match(list[0]!, /^\[b[0-9a-z]+\] h1 "Title"$/);
  const long = listing(stateOf(createDoc("y".repeat(300))).doc);
  assert.ok(long.includes("…") && long.length < 200, "long blocks are shortened");
  assert.ok(listing(stateOf(createDoc("y".repeat(300))).doc, true).length > 300, "unless asked in full");
});

test("a state survives the trip through its JSON with the caret", () => {
  const s = at(stateOf(createDoc(MD)), "second");
  const back = stateOf(JSON.parse(JSON.stringify(docStateOf(s, "guide"))));
  assert.equal(back.selection.anchor, s.selection.anchor);
  assert.equal(paramsFromState(back).list, "numbers");
});

console.log(`\n${passed} passed`);
