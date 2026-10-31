import assert from "node:assert/strict";
import { newCanvas } from "../src/lib/panacea/canvas";
import { readCanvasResponse } from "../src/lib/panacea/canvasResponse";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const saved = newCanvas("Existing work");
const valid = await readCanvasResponse(json({ doc: saved, rev: 12, engines: [{ kind: "studio", open: true }] }));
assert.deepEqual(valid.doc, saved, "valid native work is not rejected because hosted engine metadata exists");
assert.equal(valid.rev, 12);
const legacy = await readCanvasResponse(json({ doc: { version: 1, name: "Legacy", panels: [], surfaces: [] }, rev: 0 }));
assert.equal(legacy.doc.name, "Legacy", "normalizer's compatible legacy defaults remain accepted");
await assert.rejects(readCanvasResponse(json({ ok: true, engine: "studio" })), /does not contain a valid native canvas/);
await assert.rejects(readCanvasResponse(json({ doc: { panels: {}, surfaces: [] }, rev: 0 })), /panels and surfaces arrays/);
await assert.rejects(readCanvasResponse(new Response("<html>wrong route</html>", { status: 200 })), /invalid JSON/);
await assert.rejects(readCanvasResponse(json({ doc: saved, rev: -1 })), /invalid canvas revision/);
await assert.rejects(readCanvasResponse(json({ error: "Workspace disabled" }, 403)), /Workspace disabled/);
console.log("7 canvas response cases passed");
