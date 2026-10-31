import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addCard, applyBoardParam, boardBounds, boardListing, boardMarkdown, boardParams, boardPoint, boardSvg,
  cardHeight, connectorPoints, createBoard, editCard, editLink, linkCards, readBoardState, removeCard, shapePath, tidy, unlink,
  type BoardState,
} from "../src/lib/panacea/board";
import { newCanvas, normalizeCanvas, setValue } from "../src/lib/panacea/canvas";
import { KINDS } from "../src/lib/panacea/kinds";
import { BUILTINS } from "../src/lib/panacea/library";
import { addSurfaceTo } from "../src/lib/panacea/rules";

const dir = path.join(process.cwd(), `.flowchart-test-${process.pid}`);
fs.mkdirSync(dir);
process.env.AUTORA_STATE_DIR = dir;
const { runPanaceaTool, dropPanacea } = await import("../server/panacea");
const { panaceaSPECS } = await import("../server/specs/panacea");
const { getArtifact, readArtifact } = await import("../server/artifacts");
let passed = 0;
const ok = <T,>(result: T | string): T => { if (typeof result === "string") throw new Error(result); return result; };
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const sample = (): BoardState => ({
  mode: "agent", diagram: "flowchart",
  cards: [
    { id: "a", x: -176, y: -80, w: 176, text: "Begin", shape: "start", tone: "green", by: "person" },
    { id: "b", x: 240, y: -80, w: 176, text: "Ready?", shape: "decision", tone: "yellow", by: "person" },
    { id: "c", x: 240, y: 160, w: 176, text: "Work", shape: "process", tone: "blue", by: "agent" },
    { id: "d", x: 640, y: 160, w: 176, text: "Done", shape: "end", tone: "plain", by: "person" },
  ],
  links: [
    { id: "ab", from: "a", to: "b", label: "", direction: "forward" },
    { id: "bc", from: "b", to: "c", label: "Yes", direction: "forward" },
    { id: "cb", from: "c", to: "b", label: "Retry", direction: "forward" },
    { id: "cd", from: "c", to: "d", label: "", direction: "forward" },
  ],
});
const session = "flowcharttest";
const run = (name: string, args: Record<string, unknown>) => runPanaceaTool(session, name, args, { cwd: dir });

try {
  await test("legacy mindmaps keep implicit cards, undirected links and identical defaults", () => {
    let b = createBoard();
    const a = ok(addCard(b, { text: "Idea", by: "person" }));
    b = a.board;
    const z = ok(addCard(b, { text: "Other", by: "person" }));
    b = ok(linkCards(z.board, a.card.id, z.card.id)).board;
    assert.equal(b.diagram, undefined);
    assert.equal(b.cards[0]!.shape, undefined);
    assert.equal(b.links[0]!.direction, undefined);
    assert.deepEqual(readBoardState(JSON.parse(JSON.stringify(b))), b);
    assert.equal(typeof linkCards(b, z.card.id, a.card.id), "string");
    assert.deepEqual(boardParams({ ...b, sel: a.card.id }, {}), { tone: "yellow", cards: 2, links: 1, questions: 0 });
    assert.match(boardMarkdown(b, "Ideas"), /## Idea/);
  });

  await test("flowchart creation defaults to native process and forward connector, with negative coordinates", () => {
    const a = ok(addCard(createBoard("agent", "flowchart"), { text: "Check", x: -176, y: -80, by: "agent" }));
    const b = ok(addCard(a.board, { text: "Ready?", shape: "decision", by: "agent" }));
    const linked = ok(linkCards(b.board, a.card.id, b.card.id));
    assert.equal(a.card.shape, "process");
    assert.equal(a.card.x, -176);
    assert.equal(linked.link.direction, "forward");
    assert.equal(b.card.shape, "decision");
    assert.deepEqual(readBoardState(JSON.parse(JSON.stringify(linked.board))), linked.board);
  });

  await test("registry, recipe atoms and Canvas normalization preserve semantic diagram state", () => {
    const canvas = newCanvas();
    const result = addSurfaceTo(canvas, { kind: "board", name: "Process", board: sample() }, (id) => BUILTINS.find((r) => r.id === id));
    assert.ok(!("error" in result));
    if ("error" in result) throw new Error(String(result.error));
    assert.deepEqual(result.panels.map((p) => p.recipe), ["general.flowchart"]);
    assert.match(KINDS.board.describe(result.surface), /flowchart.*directed connectors/);
    const back = normalizeCanvas(JSON.parse(JSON.stringify(canvas)))!;
    assert.deepEqual(back.surfaces[0]!.board, sample());
    const surface = back.surfaces[0]!;
    surface.board!.sel = "b";
    KINDS.board.settle?.(surface);
    assert.equal(surface.params.shape, "decision");
    setValue(back, `@${surface.id}.shape`, "end");
    assert.equal(surface.board!.cards[1]!.shape, "end");
    delete surface.board!.sel;
    surface.board!.selLink = "bc";
    KINDS.board.settle?.(surface);
    assert.equal(surface.params.direction, "forward");
    setValue(back, `@${surface.id}.direction`, "both");
    assert.equal(surface.board!.links[1]!.direction, "both");
    const retained = applyBoardParam(surface.board!, "diagram", "mindmap");
    assert.equal(retained.cards[1]!.text, "Ready?");
    assert.equal(retained.links[1]!.direction, "both", "switching mode does not destroy explicit connector settings");
  });

  await test("structural edits preserve words and labels; direction errors are explicit", () => {
    const b = sample();
    const shape = ok(editCard(b, "b", { shape: "process" }));
    assert.equal(shape.cards[1]!.text, "Ready?");
    assert.deepEqual(shape.links, b.links);
    const directed = ok(editLink(b, "bc", { direction: "both" }));
    assert.equal(directed.links[1]!.label, "Yes");
    for (const value of ["bogus", null, 1]) {
      assert.equal(typeof editCard(b, "a", { shape: value }), "string");
      assert.equal(typeof editLink(b, "ab", { direction: value }), "string");
      assert.equal(typeof linkCards(b, "a", "d", "", value), "string");
    }
    assert.equal(typeof editLink(b, "missing", { direction: "forward" }), "string");
    assert.equal(typeof editCard(b, "missing", { shape: "process" }), "string");
    assert.equal(typeof editLink(b, "ab", { label: null }), "string");
    assert.equal(typeof addCard(b, { text: "Bad", x: Infinity, y: 4, by: "person" }), "string");
  });

  await test("opposite directed edges and cycles persist, while self/dangling/duplicate links are rejected or repaired", () => {
    const b = sample();
    assert.deepEqual(readBoardState(b), b);
    assert.equal(typeof linkCards(b, "a", "a"), "string");
    assert.equal(typeof linkCards(b, "a", "missing"), "string");
    assert.equal(typeof linkCards(b, "b", "c"), "string");
    assert.equal(typeof editLink(b, "bc", { direction: "backward" }), "string", "would duplicate cb");
    assert.equal(readBoardState({ ...b, diagram: "fake" }), null);
    assert.equal(readBoardState({ ...b, cards: [{ ...b.cards[0], shape: "fake" }] }), null);
    assert.equal(readBoardState({ ...b, links: [{ ...b.links[0], direction: "fake" }] }), null);
    const repaired = readBoardState({ ...b, links: [...b.links, { id: "bad", from: "a", to: "missing" }, { id: "self", from: "a", to: "a" }, { ...b.links[0], id: "dupe" }] })!;
    assert.deepEqual(repaired.links, b.links);
    const gone = ok(removeCard({ ...b, selLink: "bc" }, "b"));
    assert.equal(gone.selLink, undefined);
    assert.deepEqual(gone.links.map((l) => l.id), ["cd"]);
    assert.equal(ok(unlink({ ...b, selLink: "bc" }, "bc")).selLink, undefined);
    assert.deepEqual(tidy(b).cards.map((c) => [c.text, c.shape]), b.cards.map((c) => [c.text, c.shape]));
    assert.deepEqual(tidy(b).links, b.links);
  });

  await test("listing and Markdown retain node types, arrow semantics, ids and labels", () => {
    assert.match(boardListing(sample()), /\[b\] decision.*→ c .*"Yes" \[bc; forward\]/);
    assert.match(boardListing(sample()), /← a/);
    assert.match(boardMarkdown(sample(), "Workflow"), /\[b\] decision: Ready\?/);
    assert.match(boardMarkdown(sample(), "Workflow"), /b → c: Yes/);
  });

  await test("shape geometry and connectors terminate on real boundaries, including diamonds and rounded terminals", () => {
    const b = sample();
    assert.equal(shapePath("decision", 176, 112), "M 88 0 L 176 56 L 88 112 L 0 56 Z");
    assert.match(shapePath("start", 176, 80), /A 40 40/);
    const { p, q } = connectorPoints(b, b.cards[1]!, b.cards[2]!);
    assert.deepEqual(p, { x: 328, y: 32 });
    assert.deepEqual(q, { x: 328, y: 160 });
    const points = connectorPoints(b, b.cards[0]!, { ...b.cards[3]!, y: -80 });
    assert.deepEqual(points, { p: { x: 0, y: -40 }, q: { x: 640, y: -40 } });
    const coincident = connectorPoints(b, b.cards[0]!, { ...b.cards[0]!, id: "overlap" });
    assert.ok(Object.values(coincident).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  });

  await test("standalone SVG has exact safe shapes, arrows, escaping and finite bounds for negatives/cycles", () => {
    const b = sample();
    b.cards[0]!.text = '<script>&"\'';
    b.links[0]!.label = '<img onload="bad">&';
    const svg = boardSvg(b, '<Workflow & "title">');
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(svg, /<title id="title">&lt;Workflow &amp; &quot;title&quot;&gt;<\/title>/);
    assert.match(svg, /&lt;script&gt;&amp;&quot;&apos;/);
    assert.match(svg, /&lt;img onload=&quot;bad&quot;&gt;&amp;/);
    assert.match(svg, /data-shape="decision"><path d="M 88 0 L 176 56 L 88 112 L 0 56 Z"/);
    assert.equal((svg.match(/marker-end="url\(#arrow-end\)"/g) ?? []).length, 4);
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|href=|NaN|Infinity/);
    const bounds = boardBounds(b);
    assert.match(svg, new RegExp(`viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}"`));
    for (const card of b.cards) {
      assert.ok(card.x > bounds.x && card.y > bounds.y);
      assert.ok(card.x + card.w < bounds.x + bounds.w && card.y + cardHeight(b, card) < bounds.y + bounds.h);
    }
    const variants = b.links.map((l, i) => ({ ...l, ...(i === 2 ? { to: "a" } : {}), direction: ["none", "forward", "backward", "both"][i] as "none" | "forward" | "backward" | "both" }));
    const other = boardSvg({ ...b, links: variants }, "Directions");
    assert.equal((other.match(/marker-start="url/g) ?? []).length, 2);
    assert.equal((other.match(/marker-end="url/g) ?? []).length, 2);
    assert.equal(boardSvg(createBoard("agent", "flowchart"), "Empty"), boardSvg(createBoard("agent", "flowchart"), "Empty"), "deterministic empty SVG");
  });

  await test("CTM inversion accounts for world zoom, translation, rotation and board viewBox, without logical pixel deltas", () => {
    for (const scale of [0.1, 0.25, 1, 2.5, 8]) {
      const matrix = { a: scale, b: 0, c: 0, d: scale, e: 103, f: -80 };
      const point = boardPoint(matrix, { x: 103 - 176 * scale, y: -80 + 240 * scale })!;
      assert.ok(Math.abs(point.x + 176) < 1e-8 && Math.abs(point.y - 240) < 1e-8);
    }
    assert.deepEqual(boardPoint({ a: 0, b: 2, c: -2, d: 0, e: 10, f: 20 }, { x: -30, y: 40 }), { x: 10, y: 20 });
    assert.equal(boardPoint({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, { x: 1, y: 1 }), null);
  });

  await test("server tools create true flowcharts, enforce word ownership and reject malformed structural operations atomically", async () => {
    const created = await run("panacea_surface", { flowchart: "Release process", mode: "agent" });
    assert.ok(created.ok, created.summary);
    const added = await run("panacea_board", { ops: [{ op: "add", text: "Begin", shape: "start", x: -176, y: -80 }, { op: "add", text: "Ready?", shape: "decision" }] });
    assert.ok(added.ok, added.summary);
    const [a, b] = [...added.summary.matchAll(/added (c\w+)/g)].map((match) => match[1]!);
    const linked = await run("panacea_board", { ops: [{ op: "link", from: a, to: b, label: "Proceed" }] });
    assert.ok(linked.ok, linked.summary);
    const link = /\[(l\w+); forward\]/.exec(linked.summary)![1]!;
    assert.ok((await run("panacea_board", { ops: [{ op: "mode", mode: "guide" }] })).ok);
    const before = await run("panacea_look", { board: "" });
    for (const op of [{ op: "edit", id: a, text: "Overwrite" }, { op: "remove", id: a }, { op: "label", link, label: "" }, { op: "add", text: "Overwrite" }]) {
      const refused = await run("panacea_board", { ops: [op] });
      assert.equal(refused.ok, false, JSON.stringify(op));
      assert.match(refused.summary, /the person's words/);
    }
    assert.ok((await run("panacea_board", { ops: [{ op: "shape", id: b, shape: "process" }, { op: "direction", link, direction: "backward" }] })).ok);
    const arranged = await run("panacea_look", { board: "" });
    assert.match(arranged.summary, /Begin/);
    assert.match(arranged.summary, /Proceed/);
    assert.notEqual(arranged.summary, before.summary);
    for (const op of [{ op: "shape", id: a, shape: "bogus" }, { op: "direction", link, direction: "bogus" }, { op: "direction", link: "missing", direction: "forward" }, { op: "move", id: a, x: "bogus", y: 0 }, { op: "link", from: a, to: a }]) {
      assert.equal((await run("panacea_board", { ops: [{ op: "move", id: a, x: 100, y: 200 }, op] })).ok, false);
      assert.equal((await run("panacea_look", { board: "" })).summary, arranged.summary, "failed ops don't partially move nodes");
    }
    assert.equal((await run("panacea_surface", { board: "Bad", diagram: "fake" })).ok, false);
    assert.equal((await run("panacea_surface", { flowchart: 2 })).ok, false);
  });

  await test("server exports a real standalone SVG artifact without changing the editable graph, and Markdown remains available", async () => {
    const before = await run("panacea_look", { board: "" });
    const surface = /Flowchart (brd\w+)/.exec(before.summary)![1]!;
    const exported = await run("panacea_export", { surface });
    assert.ok(exported.ok, exported.summary);
    const artifact = /artifact ([\w-]+)/.exec(exported.summary)![1]!;
    assert.equal(getArtifact(artifact)!.mime, "image/svg+xml");
    assert.match(readArtifact(artifact)!.toString("utf8"), /data-shape="start"/);
    assert.equal((await run("panacea_look", { board: "" })).summary, before.summary);
    const markdown = await run("panacea_export", { surface, format: "markdown" });
    assert.ok(markdown.ok, markdown.summary);
    assert.match(markdown.summary, /\.md/);
    assert.equal((await run("panacea_export", { surface, format: "png" })).ok, false);
    assert.ok(panaceaSPECS.find((spec) => spec.name === "panacea_surface")!.parameters.properties!.flowchart);
    assert.match(JSON.stringify(panaceaSPECS.find((spec) => spec.name === "panacea_board")), /"shape".*"direction"/);
  });

  console.log(`\n${passed} flowchart tests passed`);
} finally {
  dropPanacea(session);
  fs.rmSync(dir, { recursive: true, force: true });
}
