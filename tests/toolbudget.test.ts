/**
 * What every model call carries before the conversation: the tool schemas of
 * the default set and the capability briefing.
 *
 * Measured at 0.9.159: 51 tools, 44 KB of schema (~11k tokens), and a 16 KB
 * briefing (~4k tokens). It is paid on every cache miss and in full by vendors
 * that do not cache, so growth should be a decision rather than a drift:
 * raise the budget here on purpose, in the change that adds the weight.
 * (docs/REVIEW.md M1)
 *
 *   npx tsx tests/toolbudget.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-budget-"));

const { availableTools, capabilityBriefing } = await import("../server/tools");
const { withoutUnloaded, unloadedIndex, FAMILIES, familyIds } = await import("../server/toolload");

// Raised to 48_200 (2026-10-16): main stood at exactly 48,000; artifact_list and artifact_save now say that files live in
// one folder per project (the composer's Artifacts button attaches project folders), +66 chars after trimming both.
// Raised again, to 48_700 (2026-10-16): memory_link, the tool that connects two memories (~420 chars with its schema).
// Raised again, to 52_000 (2026-10-18): the set had drifted to 51,184 over several commits after 16 Oct without a bump here,
// so this check had been failing on main rather than on any one change -- identical on 0.9.275 and 0.9.276. The raise is
// deliberate: the 55 default tools measure 27,125 chars of description and 21,071 of parameter text, and every paragraph
// in it is instruction the agent follows (nothing duplicates the briefing -- checked). Trimming 2,500 chars here would have
// deleted guidance to satisfy a number. The honest saving, if it is wanted, is moving rarely-used tools to on-demand
// loading rather than shaving them. Set tight on purpose so the next addition is caught soon.
// The default set was 118,330 chars (93 tools) at 0.9.277 with every specialist set on the list; 0.9.278 moved the sets off it
// (server/toolload.ts), so what every call carries is this figure, and the ceiling is unchanged on purpose. Adding a tool to
// the always-on set pays for it here.
const SCHEMA_BUDGET_CHARS = 52_000;
// Raised from 17,500 for the windows overview (server/handbook.ts): the manuals themselves are not in the briefing, they arrive with a window's first call.
// Raised again, to 22_000: on CI the browser, memory and voice groups are all available, and their guides are in the briefing (20,871 chars there before Autora Photo's line, about 18,000 on a machine without a browser).
// Raised again, to 24_000: the tool bars add each window's bar and All-tools grid to the guides; CI measured 23,354 chars, about 21,500 on a machine without a browser.
// Raised again, to 25_000 (2026-10-11): five commits had added their weight without it -- 4da9831 and 9ededd7 (the working agent's cursor and what it says it is doing there), 01d5cb4 (no Threads from handed-down work), 2f5b8b8 (to-do cards carry their steps; the bar counts credit left), 6896367 (the memory card opens the memory; the lead routes work to agents). CI measured 24,249 chars (~6,062 tokens) against the old 24,000.
// Raised again, to 26_000 (2026-10-16): the overview's "Saving and files" (Save, project folders, Load in every window, the
// composer's Artifacts button) and the scripts-only schedule line, both trimmed; CI measured 26,473 before the trim, about
// 25,700 after (24,151 on a machine without a browser).
const BRIEFING_BUDGET_CHARS = 26_000;

console.log("tool budget");

const shown = withoutUnloaded(await availableTools() as any[], new Set());
const schema = shown.reduce(
  (n, t: any) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0);
console.log(`  ${shown.length} tools, ${schema} chars of schema (~${Math.round(schema / 4)} tokens)`);
assert.ok(schema <= SCHEMA_BUDGET_CHARS, `the default tool set is ${schema} chars; the budget is ${SCHEMA_BUDGET_CHARS}`);
console.log("  ok  the default tool set is within its budget");

/* Nothing may become unreachable: no tool is claimed by two sets, and every set is in the index the briefing prints (which is
   what tools_enable takes by name). A set whose tools are not built on this machine (the office ones need their
   dependencies) matches nothing here and is not a fault. */
const all = await availableTools() as any[];
const seen = new Set<string>();
for (const f of FAMILIES) {
  for (const t of all.filter((x) => f.match(x.name))) {
    assert.ok(!seen.has(t.name), `${t.name} is in two sets`);
    seen.add(t.name);
  }
}
const index = unloadedIndex(new Set()) ?? "";
for (const id of familyIds()) assert.match(index, new RegExp(`^- ${id}: .`, "m"), `the ${id} set is not in the index`);
assert.deepEqual(familyIds(), FAMILIES.map((f) => f.id));
console.log(`  ok  ${FAMILIES.length} sets, none overlapping and every one named in the index`);

const briefing = (await capabilityBriefing()).length;
console.log(`  the briefing is ${briefing} chars (~${Math.round(briefing / 4)} tokens)`);
assert.ok(briefing <= BRIEFING_BUDGET_CHARS, `the briefing is ${briefing} chars; the budget is ${BRIEFING_BUDGET_CHARS}`);
console.log("  ok  the capability briefing is within its budget");

console.log("2 passed");
process.exit(0);
