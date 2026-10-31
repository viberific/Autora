/** Unified workspace and command cards, without a browser or editor build. */
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanaceaWorkspace } from "../src/components/PanaceaWorkspace";
import { Stage } from "../src/components/Stage";
import { TerminalCell } from "../src/components/TerminalCell";
import { WORKSPACE_MODES, workspaceMode, workspaceSurface } from "../src/lib/workspace";
import { conversationCells, isWorkspaceCell, workspaceCells } from "../src/lib/workspaceThread";
import { latestWorkspaceChange, workspaceToolKey, type WorkspaceSnapshot } from "../src/lib/workspaceFocus";
import type { Bucket, Cell } from "../src/lib/derive";
import { fitWorkView, revealWorkView, type WorkBox } from "../src/lib/workspaceViewport";
import { hostedWork } from "../src/lib/workspaceScene";
import { scaledFramePoint, workRectVisible } from "../src/lib/frameCoordinates";

let passed = 0;
function test(name: string, run: () => void) {
  run(); passed += 1; console.log(`  ok  ${name}`);
}
const noop = () => undefined;

test("every retained creative/productivity engine and live-work capability has a mode, with no terminal window", () => {
  assert.deepEqual(Object.keys(WORKSPACE_MODES).sort(), [
    "panacea", "pages", "sheets", "slides", "pdf", "photo", "video", "studio", "cad", "game", "app", "browser", "widget",
  ].sort());
  for (const mode of Object.values(WORKSPACE_MODES)) assert.ok(mode.context.length > 20);
  assert.equal(workspaceMode("term"), null);
  assert.equal(workspaceMode("terminal"), null);
});

test("phone file kinds map to work modes and back without merging Office documents", () => {
  for (const [surface, mode] of [["docx", "pages"], ["xlsx", "sheets"], ["pptx", "slides"]] as const) {
    assert.equal(workspaceMode(surface), mode);
    assert.equal(workspaceSurface(mode), surface);
  }
  assert.equal(workspaceMode("panacea"), "panacea");
  assert.equal(workspaceSurface("browser"), "browser");
});

test("Panacea owns one scene, with no exclusive mode selector", () => {
  const html = renderToStaticMarkup(h(PanaceaWorkspace, {
    sessionId: "s", modes: ["pages", "panacea"], active: "pages", following: false, onPick: noop, onFollow: noop,
    children: [h("div", { key: "pages", "data-engine": "pages" }, "unsaved words"),
      h("div", { key: "panacea", hidden: true, "data-engine": "canvas" }, "kept canvas")],
  }));
  assert.match(html, /aria-label="Panacea workspace"/);
  assert.match(html, /Capabilities/);
  assert.match(html, /Opening the workspace/);
  assert.doesNotMatch(html, /role="tablist"|Autora Terminal|Panacea work mode|<select/);
});

test("phone Stage uses the same spatial shell without tabs or a combobox", () => {
  const html = renderToStaticMarkup(h(Stage, {
    sessionId: "s", surfaces: [
      { kind: "panacea", cell: { kind: "panacea", seq: 1 }, key: "canvas" },
      { kind: "docx", cell: { kind: "docx", seq: 2 }, key: "document" },
    ], active: "docx", collapsed: true, expanded: false, following: false,
    onPick: noop, onFollow: noop, onToggle: noop, onExpand: noop,
    render: (surface) => h("div", null, `engine-${surface.kind}`),
  }));
  assert.match(html, /Pinned Panacea workspace/);
  assert.doesNotMatch(html, /Panacea work mode|<select|role="tablist"/);
});

test("hosted engines are never hidden and keep stable identities when other work opens", () => {
  const music = h("aside", { "data-pane": "studio", hidden: true }, "unsaved song");
  const first = hostedWork([music]);
  const next = hostedWork([h("aside", { "data-pane": "pdf" }, "PDF"), music]);
  assert.equal(first[0].id, "engine:studio");
  assert.equal((first[0].content as { props: { hidden: boolean }; key: string }).props.hidden, false);
  assert.equal((first[0].content as { key: string }).key, (next[1].content as { key: string }).key);
  assert.equal(hostedWork(h("aside", { "data-pane": "panacea" }, "nested canvas")).length, 0, "native work must not become a nested canvas application");
});

const command: Extract<Cell, { kind: "terminal" }> = {
  kind: "terminal", seq: 2, span: "run", command: "echo hello", output: "hello\n",
  status: "ok", exitCode: 0, durationMs: 150,
};
test("completed short and empty commands have a collapsible output, status, duration and copy", () => {
  for (const output of ["hello\n", ""]) {
    const html = renderToStaticMarkup(h(TerminalCell, { ...command, output, live: false }));
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /Show output/);
    assert.match(html, /hidden=""/);
    assert.match(html, /150ms/);
    assert.match(html, /Copy output/);
    assert.match(html, /done/);
  }
});

test("running, failed and interrupted commands keep their status visible but output contracted", () => {
  const running = renderToStaticMarkup(h(TerminalCell, { ...command, status: "running", exitCode: null, live: true }));
  assert.match(running, /aria-expanded="false"/);
  assert.match(running, /Show output/);
  assert.match(running, /running/);
  const failed = renderToStaticMarkup(h(TerminalCell, { ...command, status: "error", exitCode: 3, live: false }));
  assert.match(failed, /aria-expanded="false"/);
  assert.match(failed, /exit 3/);
  const stopped = renderToStaticMarkup(h(TerminalCell, { ...command, status: "running", exitCode: null, live: false }));
  assert.match(stopped, /no result/);
});

test("long command output still has an independent earlier-lines fold", () => {
  const html = renderToStaticMarkup(h(TerminalCell, {
    ...command, status: "running", live: true, output: Array.from({ length: 30 }, (_, n) => `line-${n}`).join("\n"),
  }));
  assert.match(html, /6 earlier lines/);
  assert.match(html, /line-29/);
  assert.doesNotMatch(html, />line-0</);
});

const screen: Extract<Cell, { kind: "screen" }> = {
  kind: "screen", seq: 3, source: "browser", url: "https://example.com", shots: [], actions: [], log: [command], live: false,
};
test("desktop commands remain in chat even when nested under browser work, without a duplicate Activity command", () => {
  assert.equal(isWorkspaceCell(command), false);
  assert.deepEqual(conversationCells([command]), [command]);
  assert.deepEqual(conversationCells([screen]), [command]);
  assert.deepEqual(workspaceCells([command]), []);
  const work = workspaceCells([screen])[0];
  assert.equal(work.kind, "screen");
  assert.deepEqual(work.kind === "screen" && work.log, []);
  assert.equal(screen.log.length, 1, "never mutate the derived log");
});

test("engine openings and revisions override a dispatching Panacea tool's nominal canvas mode", () => {
  const before: WorkspaceSnapshot[] = [
    { mode: "panacea", open: true, since: 1, revision: 2 },
    { mode: "pages", open: false },
  ];
  assert.equal(latestWorkspaceChange(before, [before[0], { mode: "pages", open: true, since: 9, revision: 1 }]), "pages");
  assert.equal(latestWorkspaceChange(before, before), null);
  assert.equal(latestWorkspaceChange(before, [{ ...before[0], revision: 3 }, before[1]]), "panacea");
  assert.equal(latestWorkspaceChange(before, [{ ...before[0], open: false }, before[1]]), null);
});

test("new tool keys release earlier dispatcher focus while commands retain their own sequence", () => {
  const bucket = { cells: [command] } as Bucket;
  assert.equal(workspaceToolKey([bucket]), 2);
  assert.equal(workspaceToolKey([]), -1);
});

test("hidden and undersized work modes cannot commit an offscreen initial canvas view", () => {
  assert.equal(fitWorkView([{ x: 0, y: 0, w: 640, h: 592 }], { width: 0, height: 0 }), null);
  assert.equal(fitWorkView([{ x: 0, y: 0, w: 640, h: 592 }], { width: 32, height: 700 }), null);
});

test("a phone-to-desktop fit keeps the table, board and document inside the visible work area", () => {
  const boxes: WorkBox[] = [
    { x: 0, y: 0, w: 576, h: 352 },
    { x: 1824, y: 0, w: 832, h: 560 },
    { x: 2688, y: 352, w: 640, h: 592 },
    { x: 3360, y: 352, w: 320, h: 500 },
  ];
  for (const viewport of [{ width: 390, height: 650 }, { width: 1009, height: 861 }]) {
    const view = fitWorkView(boxes, viewport);
    assert.ok(view);
    for (const box of boxes) {
      assert.ok((box.x - view.x) * view.zoom >= 0);
      assert.ok((box.y - view.y) * view.zoom >= 0);
      assert.ok((box.x + box.w - view.x) * view.zoom <= viewport.width);
      assert.ok((box.y + box.h - view.y) * view.zoom <= viewport.height - 76);
    }
  }
  assert.equal(boxes[1].x, 1824, "fitting changes the view, never the world's positions");
});

test("queued panel reveals settle once instead of multiplying an in-flight glide offset", () => {
  const panels = [{ x: 3360, y: 352, w: 320, h: 500 }];
  const viewport = { width: 1009, height: 861 };
  const first = revealWorkView({ x: 0, y: 0, zoom: 0.3 }, panels, viewport);
  assert.equal(revealWorkView(first, panels, viewport), first, "revealing the same world bounds is idempotent");
  assert.equal(revealWorkView(first, panels, { width: 0, height: 0 }), first);
});

test("engine-local input/cursor coordinates include the shared camera's scale and translation", () => {
  for (const zoom of [0.1, 0.3, 1, 2]) {
    const point = scaledFramePoint({ left: -2700, top: 125, width: 960 * zoom, height: 720 * zoom },
      { width: 960, height: 720 }, { x: 300, y: 200 });
    assert.equal(point.x, -2700 + 300 * zoom);
    assert.equal(point.y, 125 + 200 * zoom);
  }
  assert.throws(() => scaledFramePoint({ left: 0, top: 0, width: 0, height: 1 }, { width: 10, height: 10 }, { x: 1, y: 1 }), RangeError);
});

test("off-camera mounted work cannot qualify for Visible hand work", () => {
  const viewport = { left: 430, top: 120, width: 1010, height: 800 };
  assert.equal(workRectVisible({ left: -2700, top: 150, width: 300, height: 200 }, viewport), false);
  assert.equal(workRectVisible({ left: 900, top: 150, width: 800, height: 200 }, viewport), false);
  assert.equal(workRectVisible({ left: 500, top: 150, width: 800, height: 600 }, viewport), true);
});

console.log(`\n${passed} passed`);
