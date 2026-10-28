/**
 * Web search runs in tiers and cannot skip one: 4get, then Webclaw, then the
 * built-in keys, and the browser is never one of them.
 *
 *   npx tsx tests/websearch.test.ts
 */
import assert from "node:assert/strict";
import { SEARCH_TIERS, resultsUnusable, searchInTiers } from "../server/websearch";

const tool = (server: string, remote = "search") => ({ name: `mcp__${server}__${remote}`, server, remote });
const GOOD = "### [Node.js 22 release notes](https://nodejs.org/en/blog)\nThe current LTS line and what changed in it.";

function harness(opts: {
  tools: { name: string; server: string; remote: string }[];
  answers: Record<string, { ok: boolean; text: string }>;
  builtin?: { ok: boolean; text: string };
}) {
  const calls: string[] = [];
  const deps = {
    tools: () => opts.tools,
    call: async (name: string) => {
      calls.push(name);
      return opts.answers[name] ?? { ok: false, text: "not stubbed" };
    },
    builtin: async (q: string) => {
      calls.push(`builtin:${q}`);
      return opts.builtin?.text ?? "";
    },
  };
  return { calls, deps };
}

console.log("web search tiers");

// 1. 4get answers first: Webclaw is not touched.
{
  const h = harness({
    tools: [tool("4get"), tool("webclaw")],
    answers: { "mcp__4get__search": { ok: true, text: GOOD }, "mcp__webclaw__search": { ok: true, text: GOOD } },
  });
  const out = await searchInTiers("node lts", h.deps);
  assert.equal(out.ok, true);
  assert.equal(out.tier, "4get");
  assert.deepEqual(h.calls, ["mcp__4get__search"], "Webclaw must not be asked when 4get answered");
}

// 2. 4get blocked by a CAPTCHA wall: Webclaw is asked next.
{
  const h = harness({
    tools: [tool("4get"), tool("webclaw")],
    answers: {
      "mcp__4get__search": { ok: true, text: "Just a moment... verify you are human" },
      "mcp__webclaw__search": { ok: true, text: GOOD },
    },
  });
  const out = await searchInTiers("node lts", h.deps);
  assert.equal(out.tier, "webclaw");
  assert.deepEqual(h.calls, ["mcp__4get__search", "mcp__webclaw__search"]);
  assert.match(out.tried.join(" "), /4get: no usable results/);
}

// 3. 4get errors: Webclaw next.
{
  const h = harness({
    tools: [tool("4get"), tool("webclaw")],
    answers: { "mcp__4get__search": { ok: false, text: "boom" }, "mcp__webclaw__search": { ok: true, text: GOOD } },
  });
  const out = await searchInTiers("node lts", h.deps);
  assert.equal(out.tier, "webclaw");
  assert.match(out.tried.join(" "), /4get: errored/);
}

// 4. 4get returns nothing at all: Webclaw next.
{
  const h = harness({
    tools: [tool("4get"), tool("webclaw")],
    answers: { "mcp__4get__search": { ok: true, text: "   " }, "mcp__webclaw__search": { ok: true, text: GOOD } },
  });
  assert.equal((await searchInTiers("node lts", h.deps)).tier, "webclaw");
}

// 5. Neither MCP server connected: the built-in search answers, as before.
{
  const h = harness({ tools: [], answers: {}, builtin: { ok: true, text: GOOD } });
  const out = await searchInTiers("node lts", h.deps);
  assert.equal(out.tier, "built-in");
  assert.deepEqual(out.tried, ["4get: not connected", "webclaw: not connected"]);
}

// 6. Everything fails: it says so, and asks for nothing else -- no Browser.
{
  const h = harness({
    tools: [tool("4get"), tool("webclaw")],
    answers: {
      "mcp__4get__search": { ok: false, text: "blocked" },
      "mcp__webclaw__search": { ok: true, text: "rate limit exceeded" },
    },
    builtin: { ok: false, text: "" },
  });
  const out = await searchInTiers("node lts", h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.tier, "");
  assert.deepEqual(h.calls, ["mcp__4get__search", "mcp__webclaw__search", "builtin:node lts"]);
  assert.deepEqual(out.tried, ["4get: errored", "webclaw: no usable results", "built-in: no usable results"]);
}

// 7. The browser is not a tier at all.
assert.equal((SEARCH_TIERS as readonly string[]).includes("browser"), false);
assert.equal((SEARCH_TIERS as readonly string[]).includes("browser_open"), false);

// 8. A real page about CAPTCHAs is a result, not a wall.
assert.equal(resultsUnusable("x".repeat(40) + " captcha documentation " + "y".repeat(2000)), false);
assert.equal(resultsUnusable("Please verify you are human"), true);
assert.equal(resultsUnusable("(no output)"), true);

console.log("  ok  web search tiers");
