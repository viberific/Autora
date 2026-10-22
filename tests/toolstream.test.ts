/**
 * Tool calls streamed by vendors that bend the OpenAI wire format (GLM among
 * them) must still come out as whole calls with their arguments intact.
 *
 *   npx tsx tests/toolstream.test.ts
 */
import assert from "node:assert/strict";
import { addToolDelta, capTools, OPENAI_MAX_TOOLS, openAiCallId, openAiSchema, openAiTools, parseArgs, type BuildingCall } from "../server/llm";

const fold = (parts: any[]) => {
  const m = new Map<number, BuildingCall>();
  for (const p of parts) addToolDelta(m, p);
  return [...m.values()];
};
const fn = (name: string | undefined, args: string | undefined) => ({ function: { name, arguments: args } });

// standard: id+name once, then fragments
let r = fold([{ index: 0, id: "a", ...fn("agents", "") }, { index: 0, ...fn(undefined, '{"action":') }, { index: 0, ...fn(undefined, '"list"}') }]);
assert.deepEqual(r, [{ id: "a", name: "agents", args: '{"action":"list"}' }]);

// name repeated in every chunk
r = fold([{ index: 0, id: "a", ...fn("notebook", '{"action"') }, { index: 0, ...fn("notebook", ':"list"}') }]);
assert.equal(r[0].name, "notebook");
assert.equal(r[0].args, '{"action":"list"}');

// cumulative arguments
r = fold([{ index: 0, id: "a", ...fn("agents", '{"act') }, { index: 0, ...fn("agents", '{"action":"list"}') }]);
assert.equal(r[0].args, '{"action":"list"}');

// two parallel calls on the same index, told apart by id
r = fold([{ index: 0, id: "a", ...fn("agents", '{"action":"list"}') }, { index: 0, id: "b", ...fn("notebook", '{"action":"list"}') }]);
assert.equal(r.length, 2);
assert.deepEqual(r.map((c) => c.name), ["agents", "notebook"]);

// arguments as an object
r = fold([{ index: 0, id: "a", function: { name: "agents", arguments: { action: "list" } } }]);
assert.equal(r[0].args, '{"action":"list"}');

// double-encoded and fenced arguments
assert.deepEqual(parseArgs(JSON.stringify('{"action":"list"}')), { action: "list" });
assert.deepEqual(parseArgs('```json\n{"action":"list"}\n```'), { action: "list" });
assert.deepEqual(parseArgs("{broken"), {});

// OpenAI refuses more than 128 tools; other vendors are sent the whole list.
const named = (names: string[]) => names.map((name) => ({ name }));
const many = named([
  ...Array.from({ length: 100 }, (_, i) => `t${i}`),
  ...Array.from({ length: 50 }, (_, i) => `mcp__s__m${i}`),
]);
const capped = capTools(many, true);
assert.equal(capped.length, OPENAI_MAX_TOOLS);
assert.ok(capped.slice(0, 100).every((t, i) => t.name === `t${i}`), "built-ins all kept, in order");
// An MCP tool the chat already called outranks built-ins that were not.
const heavy = named([...Array.from({ length: 128 }, (_, i) => `t${i}`), "mcp__s__used"]);
const kept = capTools(heavy, true, new Set(["mcp__s__used"])).map((t) => t.name);
assert.equal(kept.length, OPENAI_MAX_TOOLS);
assert.ok(kept.includes("mcp__s__used") && !kept.includes("t127"));
assert.equal(capTools(many, false).length, 150);
assert.equal(capTools(named(["a", "b"]), true).length, 2);

assert.deepEqual(openAiSchema({ type: "object", properties: { a: { type: "array" } } }).properties.a, { type: "array", items: {} });
assert.deepEqual(openAiSchema({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } }).properties.a.items, { type: "string" });
assert.deepEqual(openAiSchema(undefined), { type: "object", properties: {} });
assert.deepEqual(openAiSchema({ type: "object", properties: { type: { type: "string", enum: ["array"] } }, required: ["type"] }).required, ["type"]);
assert.deepEqual(openAiTools([{ name: "a" }, { name: "a" }, { name: "b" }] as any).map((t) => t.name), ["a", "b"]);
const long = "toolu_" + "x".repeat(60);
assert.ok(openAiCallId(long).length <= 40 && openAiCallId(long) === openAiCallId(long) && openAiCallId("call_1") === "call_1");

console.log("toolstream: ok");
