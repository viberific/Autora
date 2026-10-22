/**
 * OpenAI's Responses API, for the models that take tools with reasoning on only there (GPT-6, e.g. gpt-6-luna, which
 * answers chat completions with "Function tools with reasoning_effort are not supported ... use /v1/responses").
 * Every other model keeps chat completions. Bodies are read off a real HTTP server, as in thinking-off.test.ts.
 *
 *   npx tsx tests/responses-api.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-responses-"));
const { streamChat, responsesInput } = await import("../server/llm");
const { forgetRefusals } = await import("../server/modelprofile");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const hits: { url: string; body: any }[] = [];
/** Models that refuse tools on chat completions, as gpt-6-luna does. */
const chatRefuses = new Set<string>();
const vendor = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    hits.push({ url: req.url ?? "", body });
    if (req.url?.endsWith("/chat/completions")) {
      if (chatRefuses.has(body.model) && body.tools) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: `Function tools with reasoning_effort are not supported for ${body.model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.` } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "chat" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return void res.end();
    }
    // /v1/responses: a reasoning item, some words, one function call, then the usage.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (o: any) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: "response.created", response: {} });
    ev({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] } });
    ev({ type: "response.output_text.delta", output_index: 1, delta: "Looking" });
    ev({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_A", name: "read_file", arguments: "" } });
    ev({ type: "response.function_call_arguments.delta", output_index: 2, delta: "{\"path\":" });
    ev({ type: "response.function_call_arguments.delta", output_index: 2, delta: "\"a.ts\"}" });
    ev({ type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_A", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } });
    ev({ type: "response.completed", response: { usage: { input_tokens: 50, output_tokens: 7, input_tokens_details: { cached_tokens: 20 } } } });
    res.end();
  });
});
vendor.listen(0);
await new Promise((r) => vendor.once("listening", r));
const base = `http://127.0.0.1:${(vendor.address() as { port: number }).port}/v1`;
const TOOLS = [{ name: "read_file", description: "Read a file.", parameters: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } }];

const ask = (model: string, messages: any[] = [{ role: "user", text: "hi" }], provider = "openai") => streamChat({
  provider, model, key: "k", baseUrl: base, system: "Be brief.", messages, tools: TOOLS, temperature: 0.7, effort: "low",
}, () => undefined);

console.log("responses api");

await test("gpt-6-luna goes to /v1/responses, with tools, reasoning effort, nothing stored and no temperature", async () => {
  hits.length = 0;
  const turn = await ask("gpt-6-luna");
  assert.equal(hits.length, 1);
  assert.match(hits[0].url, /\/v1\/responses$/);
  const b = hits[0].body;
  assert.equal(b.instructions, "Be brief.");
  assert.deepEqual(b.input, [{ role: "user", content: "hi" }]);
  assert.deepEqual(b.tools[0], { type: "function", name: "read_file", description: "Read a file.", parameters: TOOLS[0].parameters });
  assert.deepEqual(b.reasoning, { effort: "low" });
  assert.equal(b.store, false);
  assert.deepEqual(b.include, ["reasoning.encrypted_content"]);
  assert.equal(b.temperature, undefined);
  assert.equal(turn.text, "Looking");
  assert.deepEqual(turn.calls, [{ id: "call_A", name: "read_file", args: { path: "a.ts" } }]);
  assert.deepEqual(turn.usage, { input: 50, output: 7, cached: 20, estimated: false });
  assert.deepEqual(turn.carry, { model: "gpt-6-luna", items: [{ type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] }] });
});

await test("the next round sends the reasoning back before its call, then the call's result", async () => {
  hits.length = 0;
  const first = await ask("gpt-6-luna");
  await ask("gpt-6-luna", [
    { role: "user", text: "hi" },
    { role: "assistant", text: first.text, calls: first.calls, carry: first.carry },
    { role: "tool", replies: [{ id: "call_A", name: "read_file", ok: true, result: "export {}" }] },
  ]);
  assert.deepEqual(hits[1].body.input, [
    { role: "user", content: "hi" },
    { type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] },
    { role: "assistant", content: "Looking" },
    { type: "function_call", call_id: "call_A", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
    { type: "function_call_output", call_id: "call_A", output: "export {}" },
  ]);
});

await test("reasoning made by another model is not sent back", () => {
  const { input } = responsesInput({
    provider: "openai", model: "gpt-6-luna", key: "", baseUrl: base, system: "",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", calls: [{ id: "c1", name: "read_file", args: {} }], carry: { model: "gpt-6", items: [{ type: "reasoning", id: "x" }] } },
      { role: "tool", replies: [{ id: "c1", name: "read_file", ok: true, result: "r" }] },
    ],
  });
  assert.ok(!input.some((i) => i.type === "reasoning"));
});

await test("pictures go as input_image parts", () => {
  const { input } = responsesInput({
    provider: "openai", model: "gpt-6-luna", key: "", baseUrl: base, system: "",
    messages: [{ role: "user", text: "look", images: [{ mime: "image/png", data: "AAA" }] }],
  });
  assert.deepEqual(input[0], { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] });
});

await test("another OpenAI model that answers chat completions the same way is switched, once, and remembered", async () => {
  forgetRefusals();
  chatRefuses.add("gpt-5.9-test");
  hits.length = 0;
  const turn = await ask("gpt-5.9-test");
  assert.deepEqual(hits.map((h) => h.url.replace(/^.*\/v1/, "")), ["/chat/completions", "/responses"]);
  assert.equal(turn.calls[0].name, "read_file");
  hits.length = 0;
  await ask("gpt-5.9-test");
  assert.deepEqual(hits.map((h) => h.url.replace(/^.*\/v1/, "")), ["/responses"]);
});

await test("GPT-5 and other vendors keep chat completions, as before", async () => {
  hits.length = 0;
  assert.equal((await ask("gpt-5-mini")).text, "chat");
  assert.equal((await ask("deepseek-flash", undefined, "deepseek")).text, "chat");
  assert.equal((await ask("openai/gpt-6-luna", undefined, "openrouter")).text, "chat", "a gateway is not assumed to serve /responses");
  assert.ok(hits.every((h) => h.url.endsWith("/chat/completions")));
});

vendor.close();
console.log(`${passed} passed`);
