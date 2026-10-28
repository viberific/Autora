/**
 * The agent offering MCP servers: what an offer is made of, that nothing is
 * installed without a yes, that a no is remembered for the session, that a
 * key goes through the secret store rather than the config, and that a
 * server the agent writes itself really runs.
 *
 *   npx tsx tests/mcpoffer.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mcpoffer-"));

const { matchCatalog, fillEnvParams } = await import("../server/mcpcatalog");
const { BROWSING_GUIDE, WEB_RESEARCH_GUIDE } = await import("../server/guides");
const { planOffer } = await import("../server/mcpoffer");
const { capabilityBriefing, findTool, runTool } = await import("../server/tools");
const { setSecretLookup, callMcpTool, disconnect } = await import("../server/mcp");
const { setSecret, secretFor, state } = await import("../server/state");

setSecretLookup((name) => secretFor(name) || null);

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A tool context whose person answers every ask with `choice`, and records the asks. */
function context(choice: string) {
  const asked: any[] = [];
  const ctx = {
    session: "s-test",
    ask: async (request: any) => {
      asked.push(request);
      return { cancelled: false, choices: [choice], text: "", who: "user" };
    },
  } as any;
  return { ctx, asked };
}

console.log("mcp offers");

await test("requests are matched to the servers that fit", () => {
  assert.equal(matchCatalog("list the open issues on my github repo")[0]?.id, "github");
  assert.equal(matchCatalog("what does this postgres table hold")[0]?.id, "postgres");
  const fourget = matchCatalog("search the web for current information")[0];
  assert.equal(fourget?.id, "4get");
  assert.equal(fourget?.command, "uvx");
  assert.deepEqual(fourget?.args, ["--python", "3.13", "--from", "mcp-4get", "mcp_4get"]);
  assert.deepEqual(fourget?.params, [{ name: "FOURGET_BASE_URL", label: "4get instance base URL", fallback: "https://4get.ca" }]);
  assert.deepEqual(fillEnvParams(fourget!, {}), { FOURGET_BASE_URL: "https://4get.ca" });
  assert.deepEqual(fillEnvParams(fourget!, { FOURGET_BASE_URL: "https://search.example" }), { FOURGET_BASE_URL: "https://search.example" });
  const fetch = matchCatalog("fetch a webpage and read its content")[0];
  assert.equal(fetch?.id, "fetch");
  assert.equal(fetch?.command, "uvx");
  assert.deepEqual(fetch?.args, ["--python", "3.13", "mcp-server-fetch"]);
  assert.deepEqual(matchCatalog("tell me a joke"), []);
});

await test("web research guidance names the enforced tiers and leaves browser use to the person", async () => {
  assert.ok(WEB_RESEARCH_GUIDE.includes("it asks 4get first, then Webclaw, then the built-in keys"));
  assert.ok(WEB_RESEARCH_GUIDE.includes("Do not call the 4get or Webclaw MCP search tools directly"));
  assert.ok(WEB_RESEARCH_GUIDE.includes("If it says no tier answered, say the search failed and what was tried."));
  assert.ok(WEB_RESEARCH_GUIDE.includes("Use MCP Fetch, or Webclaw's scrape and crawl, to read a chosen page, not to search"));
  assert.ok(WEB_RESEARCH_GUIDE.includes("Use the browser for web research only when the person explicitly asks to see a live page"));
  assert.ok(BROWSING_GUIDE.includes("After each action, check the page did what you meant"));
  assert.ok(BROWSING_GUIDE.includes("Sign-ins: fill the fields yourself when you have the details"));
  assert.match(WEB_RESEARCH_GUIDE, /upstream search engines/);
  assert.ok((await capabilityBriefing()).includes(WEB_RESEARCH_GUIDE));
});

await test("an offer needs a reason and a real server", () => {
  assert.equal(typeof planOffer({ server: "github" }), "string", "no why");
  assert.match(String(planOffer({ server: "nope", why: "x" })), /no catalog server/i);
  /* Whether that key is already on this machine is the machine's business -- a
     shell may export one -- so ask the card for both answers instead of
     trusting the environment. */
  const hadEnv = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const hadSaved = state.secrets?.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (state.secrets) delete state.secrets.GITHUB_PERSONAL_ACCESS_TOKEN;

  const plan = planOffer({ server: "github", why: "Reads issues directly" });
  assert.ok(typeof plan !== "string");
  assert.equal(plan.needs[0].env, "GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.equal(plan.needs[0].set, false);
  assert.doesNotMatch(plan.runs, /secret/, "the card never shows a secret reference as a command");

  setSecret("GITHUB_PERSONAL_ACCESS_TOKEN", "example-not-a-real-key");
  const withKey = planOffer({ server: "github", why: "Reads issues directly" });
  assert.ok(typeof withKey !== "string");
  assert.equal(withKey.needs[0].set, true, "a saved key is recognised");
  assert.doesNotMatch(withKey.runs, /secret/);

  if (hadSaved === undefined) delete state.secrets.GITHUB_PERSONAL_ACCESS_TOKEN;
  else state.secrets.GITHUB_PERSONAL_ACCESS_TOKEN = hadSaved;
  if (hadEnv === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = hadEnv;
});

await test("saying not now installs nothing and is not asked again", async () => {
  const spec = findTool("mcp_offer")!;
  const { ctx, asked } = context("Not now");
  const first = await runTool(spec, { server: "context7", why: "Current docs in one call" }, ctx);
  assert.equal(first.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "offer");
  assert.equal(asked[0].offer.name, "context7");
  assert.equal(state.mcpServers.length, 0);
  const again = await runTool(spec, { server: "context7", why: "Still better" }, ctx);
  assert.equal(again.ok, false);
  assert.match(again.summary, /already said not now/);
  assert.equal(asked.length, 1, "no second card");
});

await test("a server the agent writes runs, with its key from the secret store", async () => {
  setSecret("GREETING", "hej");
  const spec = findTool("mcp_offer")!;
  const { ctx } = context("Set it up");
  const out = await runTool(spec, {
    why: "Greets people properly",
    name: "Greeter",
    summary: "Says hello",
    needs: [{ env: "GREETING", label: "Greeting word" }],
    tools: [{
      name: "greet",
      description: "Say hello to someone",
      parameters: { properties: { who: { type: "string" } }, required: ["who"] },
      code: "return `${env.GREETING}, ${args.who}!`;",
    }],
  }, ctx);
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /mcp__greeter__greet/);
  const saved = state.mcpServers.find((s) => s.name === "greeter")!;
  assert.equal(saved.origin, "agent");
  assert.equal(saved.env?.GREETING, "${secret:GREETING}", "the config holds a reference, not the key");
  assert.deepEqual(await callMcpTool("mcp__greeter__greet", { who: "Ada" }), { ok: true, text: "hej, Ada!" });
  await disconnect(saved.id);
});

await test("code that does not parse is refused before anything is offered", async () => {
  const spec = findTool("mcp_offer")!;
  const { ctx, asked } = context("Set it up");
  const out = await runTool(spec, {
    why: "x", name: "broken",
    tools: [{ name: "oops", description: "d", code: "return (" }],
  }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.summary, /does not parse/);
  assert.equal(asked.length, 0);
});

await test("the overview names what is set up and what can be offered", async () => {
  const out = await runTool(findTool("mcp_servers")!, { topic: "slack channel" }, {} as any);
  assert.match(out.summary, /greeter/);
  assert.match(out.summary, /slack/);
});

console.log(`\nmcp offers: ${passed} passed`);
process.exit(0);
