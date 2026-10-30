/**
 * Panacea's board: cards, links and questions, read back from JSON and repaired, tidied into clusters, written out as
 * Markdown; the kind in the registry, its parameters following the selected card; and the agent's panacea_board, which
 * arranges and asks freely but writes only when the board is given to it.
 *
 *   npx tsx tests/panacea-board.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BoardState } from "../src/lib/panacea/board";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-board-"));
process.env.AUTORA_STATE_DIR = dir;

const {
  addCard, applyBoardParam, boardListing, boardMarkdown, boardParams, clusters, createBoard, editCard, freeSpot, linkCards, moveCard,
  readBoardState, removeCard, tidy, unlink, MAX_CARD_TEXT,
} = await import("../src/lib/panacea/board");
const { KINDS } = await import("../src/lib/panacea/kinds");
const { newCanvas, normalizeCanvas, setValue } = await import("../src/lib/panacea/canvas");
const { addSurfaceTo } = await import("../src/lib/panacea/rules");
const { BUILTINS } = await import("../src/lib/panacea/library");
const panacea = await import("../server/panacea");
const { panaceaSPECS } = await import("../server/specs/panacea");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const ok = <T,>(r: T | string): T => { if (typeof r === "string") throw new Error(r); return r; };

/** A board with three cards, two of them linked. */
function sample(): { b: BoardState; ids: string[] } {
  let b = createBoard();
  const ids: string[] = [];
  for (const text of ["Mara", "The vault", "1920s Lisbon"]) {
    const made = ok(addCard(b, { text, by: "person" }));
    b = made.board;
    ids.push(made.card.id);
  }
  b = ok(linkCards(b, ids[0]!, ids[1]!, "wants")).board;
  return { b, ids };
}

console.log("board");

await test("cards land in free places, never on top of one another, and words are capped", () => {
  const { b } = sample();
  for (let i = 0; i < b.cards.length; i++) {
    for (let j = i + 1; j < b.cards.length; j++) {
      const p = b.cards[i]!;
      const q = b.cards[j]!;
      assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + 80 <= q.y || q.y + 80 <= p.y, `${p.text} and ${q.text} overlap`);
    }
  }
  const spot = freeSpot(b);
  assert.ok(!b.cards.some((c) => c.x === spot.x && c.y === spot.y));
  const long = ok(addCard(b, { text: "x".repeat(900), by: "person" }));
  assert.equal(long.card.text.length, MAX_CARD_TEXT);
  assert.equal(typeof addCard(b, { text: "", by: "agent" }), "string", "the agent's card needs words");
  assert.equal(typeof addCard(b, { text: "a", tone: "chartreuse", by: "person" }), "string");
});

await test("links join two different cards once; removing a card takes its links with it", () => {
  const { b, ids } = sample();
  assert.equal(typeof linkCards(b, ids[1]!, ids[0]!), "string", "already linked, either way round");
  assert.equal(typeof linkCards(b, ids[0]!, ids[0]!), "string");
  assert.equal(typeof linkCards(b, ids[0]!, "nope"), "string");
  const gone = ok(removeCard({ ...b, sel: ids[0]! }, ids[0]!));
  assert.equal(gone.links.length, 0);
  assert.equal(gone.sel, undefined, "the selection goes with the card");
  assert.equal(ok(unlink(b, null, { from: ids[1]!, to: ids[0]! })).links.length, 0);
});

await test("a board reads back from JSON, repaired: unknown tones, dangling links, duplicates and a bad mode", () => {
  const { b, ids } = sample();
  const raw = JSON.parse(JSON.stringify(b));
  raw.mode = "bogus";
  raw.cards.push({ ...raw.cards[0], text: "dupe" }, { id: "c-x", x: -50, y: 99999, text: 5, tone: "chartreuse" });
  raw.links.push({ id: "l-x", from: ids[0], to: "nowhere" }, { id: "l-y", from: ids[1], to: ids[0] });
  const back = readBoardState(raw)!;
  assert.equal(back.mode, "guide", "an unknown mode is the safe one");
  assert.equal(back.cards.length, 4);
  const x = back.cards.find((c) => c.id === "c-x")!;
  assert.deepEqual([x.x, x.text, x.tone], [0, "", "yellow"]);
  assert.ok(x.y <= 4000);
  assert.equal(back.links.length, 1, "the dangling link and the second link of a pair are dropped");
  assert.equal(readBoardState({ cards: "no" }), null);
  assert.equal(readBoardState(null), null);
});

await test("moving, recolouring and editing change only what they say", () => {
  const { b, ids } = sample();
  const moved = ok(moveCard(b, ids[2]!, 333, -10));
  const card = moved.cards.find((c) => c.id === ids[2])!;
  assert.deepEqual([card.x % 8, card.y], [0, 0], "snapped, and kept on the board");
  const edited = ok(editCard(b, ids[2]!, { text: "Porto", tone: "blue" }));
  assert.deepEqual([edited.cards[2]!.text, edited.cards[2]!.tone], ["Porto", "blue"]);
  assert.equal(edited.cards[0]!.text, "Mara");
});

await test("clusters are linked cards; tidy lays each out as a column, questions apart, and keeps every word and link", () => {
  const { b, ids } = sample();
  const asked = ok(addCard(b, { text: "Who else wants in?", ask: true, by: "agent" })).board;
  assert.deepEqual(clusters(asked).map((g) => g.length), [2, 1, 1]);
  const t = tidy(asked);
  const at = (id: string) => t.cards.find((c) => c.id === id)!;
  assert.equal(at(ids[0]!).x, at(ids[1]!).x, "a cluster shares a column");
  assert.notEqual(at(ids[0]!).x, at(ids[2]!).x);
  const q = t.cards.find((c) => c.ask)!;
  assert.ok(t.cards.filter((c) => !c.ask).every((c) => c.x < q.x), "the questions come last");
  assert.deepEqual(t.cards.map((c) => c.text), asked.cards.map((c) => c.text));
  assert.deepEqual(t.links, asked.links);
});

await test("in words for the agent and as Markdown for the person", () => {
  const { b, ids } = sample();
  const asked = ok(addCard(b, { text: "What does Mara fear?", ask: true, by: "agent" })).board;
  const words = boardListing(asked);
  assert.match(words, new RegExp(`\\[${ids[0]}\\] card at \\d+,\\d+ yellow: Mara -- linked to ${ids[1]} \\(The vault\\) "wants"`));
  assert.match(words, /question at .*What does Mara fear\?/);
  assert.equal(boardListing(createBoard()), "(no cards yet)");
  const md = boardMarkdown(asked, "Heist");
  assert.match(md, /^# Heist\n/);
  assert.match(md, /## Mara\n\n- The vault \(wants\)/);
  assert.match(md, /- 1920s Lisbon/);
  assert.match(md, /## Open questions\n\n- What does Mara fear\?\n$/);
});

await test("the kind: its parameters follow the selected card, and a colour set goes onto it", () => {
  const { b, ids } = sample();
  assert.equal(KINDS.board.prefix, "brd");
  const sel = { ...b, sel: ids[1]! };
  assert.deepEqual(boardParams(sel, {}), { tone: "yellow", cards: 3, links: 1, questions: 0 });
  assert.equal(applyBoardParam(sel, "tone", "pink").cards[1]!.tone, "pink");
  assert.equal(applyBoardParam(b, "tone", "pink"), b, "nothing selected: only the next card's colour");
  const c = newCanvas();
  const made = addSurfaceTo(c, { kind: "board", name: "Plot", board: sel }, (id) => BUILTINS.find((r) => r.id === id));
  assert.ok(!("error" in made));
  const s = made.surface;
  assert.deepEqual(made.panels.map((p) => p.recipe), ["general.board"], "the Board panel comes with it");
  setValue(c, `@${s.id}.tone`, "green");
  assert.equal(c.surfaces[0]!.board!.cards[1]!.tone, "green");
  assert.equal(c.surfaces[0]!.params.tone, "green");
  const back = normalizeCanvas(JSON.parse(JSON.stringify(c)))!;
  assert.equal(back.surfaces[0]!.board!.cards.length, 3, "a board survives the trip through the page and the disk");
  assert.equal(KINDS.board.describe(back.surfaces[0]!).includes("its words are the person's"), true);
});

// --------------------------------------------------------------- the tools --

const S = "boardtest";
const run = (name: string, args: Record<string, unknown>) => panacea.runPanaceaTool(S, name, args, { cwd: dir });
const boardOf = async () => {
  const look = await run("panacea_look", { board: "" });
  assert.ok(look.ok, look.summary);
  return look.summary;
};

await test("panacea_board is a tool, and panacea_surface makes a board the person writes", async () => {
  assert.ok(panaceaSPECS.some((s) => s.name === "panacea_board"));
  const out = await run("panacea_surface", { board: "Heist" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /Added board brd\w+ "Heist"; its words are the person's/);
  assert.match(out.summary, /Board/);
  assert.match(await boardOf(), /0 cards, 0 links, 0 questions/);
});

await test("in guide the agent asks, arranges and links, but may not write, rewrite or remove the person's cards", async () => {
  const asked = await run("panacea_board", { ops: [{ op: "ask", text: "Who is the story about?" }, { op: "ask", text: "Where does it happen?" }] });
  assert.ok(asked.ok, asked.summary);
  const qs = [...asked.summary.matchAll(/asked (c\w+)/g)].map((m) => m[1]!);
  assert.equal(qs.length, 2);
  const notAQuestion = await run("panacea_board", { ops: [{ op: "ask", text: "Mara is a safecracker." }] });
  assert.equal(notAQuestion.ok, false);
  assert.match(notAQuestion.summary, /ending with "\?"/);
  for (const op of [{ op: "add", text: "Mara" }, { op: "edit", id: qs[0], text: "x" }]) {
    const refused = await run("panacea_board", { ops: [op] });
    assert.equal(refused.ok, false, JSON.stringify(op));
    assert.match(refused.summary, /the person's words.*\{"op": "mode", "mode": "agent"\}/);
  }
  const before = await boardOf();
  const half = await run("panacea_board", { ops: [{ op: "link", from: qs[0], to: qs[1] }, { op: "add", text: "sneaked in" }] });
  assert.equal(half.ok, false);
  assert.equal(await boardOf(), before, "all or none: the allowed link in a refused call is not kept");
  const arranged = await run("panacea_board", { ops: [{ op: "link", from: qs[0], to: qs[1] }, { op: "move", id: qs[1], x: 400, y: 200 }, { op: "tidy" }, { op: "remove", id: qs[1] }] });
  assert.ok(arranged.ok, arranged.summary);
  assert.match(arranged.summary, /Cards now \(1\)/, "its own question it may take away");
  const labelled = await run("panacea_board", { ops: [{ op: "ask", text: "When?" }, { op: "link", from: qs[0], to: "c", label: "because" }] });
  assert.equal(labelled.ok, false, "a link's label is words");
  assert.match(labelled.summary, /the person's words/);
});

await test("given the board, the agent writes; given back, it is refused again; it exports as Markdown", async () => {
  const given = await run("panacea_board", { ops: [{ op: "mode", mode: "agent" }, { op: "add", text: "Mara" }, { op: "add", text: "The vault" }] });
  assert.ok(given.ok, given.summary);
  assert.match(given.summary, /switched the board to Autora writing/);
  const [mara, vault] = [...given.summary.matchAll(/added (c\w+)/g)].map((m) => m[1]!);
  assert.ok((await run("panacea_board", { ops: [{ op: "link", from: mara, to: vault, label: "wants" }, { op: "edit", id: vault, text: "The Lisbon vault" }] })).ok);
  assert.match(await boardOf(), /Autora may write cards on it/);
  assert.ok((await run("panacea_board", { ops: [{ op: "mode", mode: "guide" }] })).ok);
  assert.equal((await run("panacea_board", { ops: [{ op: "remove", id: mara }] })).ok, false);
  const out = await run("panacea_export", { surface: (/Board (brd\w+)/.exec(await boardOf()))![1] });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /Heist\.md \(2 cards, as a Markdown outline\)/);
});

await test("panacea_board without a board says how to make one", async () => {
  panacea.dropPanacea(S);
  const none = await run("panacea_board", { ops: [{ op: "tidy" }] });
  assert.equal(none.ok, false);
  assert.match(none.summary, /panacea_surface `board`/);
});

console.log(`\n${passed} passed`);
fs.rmSync(dir, { recursive: true, force: true });
