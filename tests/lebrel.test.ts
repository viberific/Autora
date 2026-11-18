/**
 * Lebrel as a first-class provider: the entry itself, the prices it quotes,
 * the one model it does not price, and the hours that change the bill.
 *
 * The prices and the peak schedule below are what GET
 * https://attested.lebrel.ai/v1/models answered on 2026-11-18 (lebrel.pricing,
 * microUSD per million tokens) and what lebrel.ai/docs says about the edition's
 * window. That endpoint is public -- no key is needed and none is used here.
 *
 *   npx tsx tests/lebrel.test.ts
 */
import assert from "node:assert/strict";
import { AUTO_ROUTERS, PROVIDERS, autoPriceOf, cheaperSibling, contextWindow, costOf, costParts, isPriced, modelsFor, providerSpec, rememberModels } from "../server/providers";
import { listModels } from "../server/llm";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL ${name}`);
      throw err;
    });
}

/** The listing as the vendor served it: ten ids, nine priced in microUSD per
    million tokens under `lebrel.pricing`, the edition carrying none at all. */
const LISTING = {
  object: "list",
  data: [
    { id: "deepseek/deepseek-v4-pro", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 792000, cached_input_microusd_per_million_tokens: 26400, output_microusd_per_million_tokens: 2376000, peak: { multiplier_percent: 200, weekdays: [1, 2, 3, 4, 5], windows_utc: [["01:00", "04:00"], ["06:00", "10:00"]] } } } },
    { id: "deepseek/deepseek-v4.1-flash", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 150000, cached_input_microusd_per_million_tokens: 6000, output_microusd_per_million_tokens: 600000 } } },
    { id: "lebrel/deepseek-v4.1-flash-uncensored", object: "model", owned_by: "lebrel", lebrel: { kind: "edition", base_model: "DeepSeek V4.1 Flash" } },
    { id: "moonshotai/kimi-k3", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 3300000, cached_input_microusd_per_million_tokens: 330000, output_microusd_per_million_tokens: 16500000 } } },
    { id: "moonshotai/kimi-k3.1-pro", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 1950000, cached_input_microusd_per_million_tokens: 195000, output_microusd_per_million_tokens: 9750000 } } },
    { id: "qwen/qwen3.8-flash", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 150000, cached_input_microusd_per_million_tokens: 16000, output_microusd_per_million_tokens: 490000 } } },
    { id: "qwen/qwen3.8-max", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 2000000, cached_input_microusd_per_million_tokens: 250000, output_microusd_per_million_tokens: 6000000 } } },
    { id: "qwen/qwen4-max", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 1400000, cached_input_microusd_per_million_tokens: 70000, output_microusd_per_million_tokens: 4200000 } } },
    { id: "z-ai/glm-5.3", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 1260000, cached_input_microusd_per_million_tokens: 234000, output_microusd_per_million_tokens: 3960000 } } },
    { id: "z-ai/glm-5.3-flash", object: "model", owned_by: "lebrel", lebrel: { pricing: { input_microusd_per_million_tokens: 170000, cached_input_microusd_per_million_tokens: 34000, output_microusd_per_million_tokens: 560000 } } },
  ],
};

console.log("lebrel");

const EDITION = "lebrel/deepseek-v4.1-flash-uncensored";

async function withListing<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(LISTING), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const run = async () => {
  await test("the entry is complete enough to be offered, keyed and listed", () => {
    const spec = providerSpec("lebrel");
    assert.ok(spec, "lebrel is in the table");
    assert.equal(spec!.label, "Lebrel");
    assert.equal(spec!.kind, "openai", "it speaks the OpenAI wire format, which is the only one wired");
    assert.equal(spec!.baseUrl, "https://attested.lebrel.ai/v1");
    assert.deepEqual(spec!.envKeys, ["LEBREL_API_KEY"]);
    assert.equal(spec!.keyHint, "leb_live_...");
    assert.equal(spec!.keysUrl, "https://lebrel.ai/dashboard#keys");
    assert.equal(spec!.listable, true, "GET /v1/models is public and mergeable");
    assert.equal(spec!.openEnded, true, "a model id may be typed");
    assert.equal(spec!.defaultModel, EDITION);
    assert.ok(spec!.models.some((m) => m.id === spec!.defaultModel), "the default is in the list");
    assert.ok(spec!.note.length > 40, "the row explains what the vendor is");
    assert.match(spec!.note, /attested|receipt/i);
    assert.match(spec!.note, /one key|every model/i);
  });

  await test("it is not a router, and it claims no balance endpoint", () => {
    assert.ok(!AUTO_ROUTERS.includes("lebrel"), "Lebrel serves models it names; it does not route");
    assert.equal(providerSpec("lebrel")!.balance, undefined, "no balance endpoint is published, so none is claimed");
  });

  await test("every id the vendor lists is in the shipped table", () => {
    const shipped = providerSpec("lebrel")!.models.map((m) => m.id);
    const live = LISTING.data.map((m) => m.id);
    assert.equal(live.length, 10);
    for (const id of live) assert.ok(shipped.includes(id), `${id} is offered offline too`);
    assert.equal(shipped[0], EDITION, "the edition is the first thing offered");
  });

  await test("the shipped prices are the ones the vendor quotes, in dollars per million", () => {
    const want: Record<string, [number, number, number]> = {
      "deepseek/deepseek-v4-pro": [0.792, 2.376, 0.0264],
      "deepseek/deepseek-v4.1-flash": [0.15, 0.6, 0.006],
      "moonshotai/kimi-k3": [3.3, 16.5, 0.33],
      "moonshotai/kimi-k3.1-pro": [1.95, 9.75, 0.195],
      "qwen/qwen3.8-flash": [0.15, 0.49, 0.016],
      "qwen/qwen3.8-max": [2, 6, 0.25],
      "qwen/qwen4-max": [1.4, 4.2, 0.07],
      "z-ai/glm-5.3": [1.26, 3.96, 0.234],
      "z-ai/glm-5.3-flash": [0.17, 0.56, 0.034],
    };
    for (const [id, [input, output, cached]] of Object.entries(want)) {
      const m = modelsFor("lebrel").find((x) => x.id === id);
      assert.ok(m, `${id} is listed`);
      assert.equal(m!.input, input, `${id} input`);
      assert.equal(m!.output, output, `${id} output`);
      assert.equal(m!.cachedInput, cached, `${id} cached input`);
      assert.notEqual(m!.priced, false, `${id} is priced`);
    }
  });

  await test("a live listing prices in dollars per million, not micro dollars", async () => {
    const models = await withListing(() => listModels("lebrel", "", "https://attested.lebrel.ai/v1"));
    const pro = models.find((m) => m.id === "deepseek/deepseek-v4-pro")!;
    assert.equal(pro.input, 0.792);
    assert.equal(pro.output, 2.376);
    assert.equal(pro.cachedInput, 0.0264);
    assert.equal(pro.priced, true);
    assert.equal(pro.peak, 2, "the peak schedule comes back with the price");
    const flash = models.find((m) => m.id === "deepseek/deepseek-v4.1-flash")!;
    assert.equal(flash.peak, undefined, "a model without a peak schedule has none");
  });

  await test("the edition comes back unpriced from the list, never free", async () => {
    const models = await withListing(() => listModels("lebrel", "", "https://attested.lebrel.ai/v1"));
    const edition = models.find((m) => m.id === EDITION)!;
    assert.equal(edition.priced, false);
    assert.equal(edition.input, 0);
    assert.equal(edition.output, 0);
    assert.equal(costOf("lebrel", EDITION, 10_000, 2_000), 0, "a turn is counted at nothing, not billed");
  });

  await test("refreshing the catalogue cannot strip the edition of its shipped entry", async () => {
    const models = await withListing(() => listModels("lebrel", "", "https://attested.lebrel.ai/v1"));
    rememberModels("lebrel", models);
    const edition = modelsFor("lebrel").filter((m) => m.id === EDITION);
    assert.equal(edition.length, 1, "one row for it, not two");
    assert.equal(contextWindow("lebrel", EDITION)?.tokens, 1_048_544, "its window survives the refresh");
  });

  await test("the edition's window is the one its docs give, and routed models have none", () => {
    assert.deepEqual(contextWindow("lebrel", EDITION), { tokens: 1_048_544, source: "model" });
    const routed = contextWindow("lebrel", "deepseek/deepseek-v4-pro");
    assert.equal(routed, null, "no window is published for routed models, so none is invented");
    assert.equal(contextWindow("lebrel", "qwen/qwen4-max"), null);
  });

  await test("an unpriced default is not priced as free", () => {
    assert.equal(isPriced("lebrel", EDITION), false);
    assert.equal(autoPriceOf("lebrel"), null, "Automatic has no list price to race with");
    assert.equal(cheaperSibling("lebrel", "qwen/qwen4-max"), null, "and never picks it for background work");
    assert.notEqual(autoPriceOf("lebrel", "qwen/qwen4-max"), 0);
  });

  await test("a priced turn costs what the rate says", () => {
    // Monday 12:00 UTC: the middle of the day, outside Lebrel's peak windows.
    const noon = new Date(Date.UTC(2026, 10, 16, 12, 0, 0));
    assert.equal(noon.getUTCDay(), 1);
    assert.equal(costOf("lebrel", "qwen/qwen4-max", 1_000_000, 0, noon), 1.4);
    assert.equal(costOf("lebrel", "qwen/qwen4-max", 0, 1_000_000, noon), 4.2);
    assert.equal(costOf("lebrel", "deepseek/deepseek-v4.1-flash", 1_000_000, 0, noon), 0.15);
  });

  await test("DeepSeek V4 Pro doubles inside Lebrel's peak hours, and only then", () => {
    const mondayPeak = new Date(Date.UTC(2026, 10, 16, 2, 0, 0));
    const mondayNoon = new Date(Date.UTC(2026, 10, 16, 12, 0, 0));
    const saturdayPeak = new Date(Date.UTC(2026, 10, 21, 2, 0, 0));
    assert.equal(costOf("lebrel", "deepseek/deepseek-v4-pro", 0, 1_000_000, mondayPeak), 2.376 * 2);
    assert.equal(costOf("lebrel", "deepseek/deepseek-v4-pro", 0, 1_000_000, mondayNoon), 2.376);
    assert.equal(costOf("lebrel", "deepseek/deepseek-v4-pro", 0, 1_000_000, saturdayPeak), 2.376, "weekends are off-peak");
    // A model that carries no peak schedule is unaffected at the same hour.
    assert.equal(costOf("lebrel", "qwen/qwen4-max", 0, 1_000_000, mondayPeak), 4.2);
  });

  await test("cached input on a Lebrel model is billed at the cached rate", () => {
    const noon = new Date(Date.UTC(2026, 10, 16, 12, 0, 0));
    const parts = costParts("lebrel", "z-ai/glm-5.3", 1_000_000, 0, noon, { read: 1_000_000 });
    assert.equal(parts.fresh, 0);
    assert.ok(Math.abs(parts.cached - 0.234) < 1e-9, "a cached token is not billed as a new one");
  });

  await test("the provider table has one entry per id", () => {
    const ids = PROVIDERS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes("lebrel"));
  });

  console.log(`lebrel: ${passed} passed`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
