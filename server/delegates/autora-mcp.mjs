#!/usr/bin/env node
/**
 * Autora's own tools, as an MCP server, for a subscription CLI answering a chat.
 *
 * Claude Code or Gemini starts this (claude-call.mjs / gemini-call.mjs register it) and talks MCP to it over standard input and
 * output, one JSON-RPC message a line. It does no work itself: the tool list and every call are passed to the Autora server that
 * started the turn (AUTORA_BRIDGE_URL), with the turn's token (AUTORA_BRIDGE_TOKEN), and the server runs each call exactly as it
 * runs the agent's own (server/clibridge.ts) -- the same checks, the same windows, the same cells in the chat. The token is good
 * for that one turn only.
 *
 * Plain Node, no dependencies, so it runs from the image as it is.
 */
const url = process.env.AUTORA_BRIDGE_URL || "";
const token = process.env.AUTORA_BRIDGE_TOKEN || "";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const answer = (id, result) => send({ jsonrpc: "2.0", id, result });
const refuse = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function ask(body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* said below */ }
  if (!res.ok || !parsed) throw new Error(parsed?.detail || `Autora answered ${res.status}: ${text.slice(0, 200)}`);
  return parsed;
}

async function handle(message) {
  const { id, method, params } = message;
  // A notification (no id) needs no answer: initialized, cancelled, and the rest.
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      answer(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "autora", version: "1" },
        instructions: "Autora's own tools: its windows (documents, sheets, slides, PDF, photos, music, 3D, games), the board, the browser, the app preview and the rest. Use them for anything the person should see in Autora.",
      });
    } else if (method === "ping") {
      answer(id, {});
    } else if (method === "tools/list") {
      const { tools } = await ask({ op: "list" });
      answer(id, { tools });
    } else if (method === "tools/call") {
      const out = await ask({ op: "call", name: String(params?.name ?? ""), arguments: params?.arguments ?? {} });
      answer(id, { content: out.content, isError: out.isError === true });
    } else if (method === "resources/list" || method === "prompts/list") {
      answer(id, method === "resources/list" ? { resources: [] } : { prompts: [] });
    } else {
      refuse(id, -32601, `Autora's bridge does not do ${method}.`);
    }
  } catch (err) {
    if (method === "tools/call") answer(id, { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
    else refuse(id, -32603, String(err?.message ?? err));
  }
}

let held = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  held += chunk;
  let at;
  while ((at = held.indexOf("\n")) >= 0) {
    const line = held.slice(0, at).trim();
    held = held.slice(at + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
