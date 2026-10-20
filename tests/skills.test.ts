/**
 * The skill library: real skills in the Agent Skills format (a folder with a
 * SKILL.md), held to the format, offered by name and description, loaded when
 * picked, written and improved by agents as drafts that earn their way live,
 * imported and exported as plain folders, and moved out of the Mind.
 *
 *   npx tsx tests/skills.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-skills-"));

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const skills = await import("../server/skills");
const { MemoryGraph } = await import("../server/memory");
const { checkEntry } = await import("../server/mindrules");
const { findTool, runTool, capabilityBriefing } = await import("../server/tools");

const GOOD = `---
name: invoice-from-timesheet
description: Turns a timesheet CSV into an invoice PDF. Use when the person asks to bill a client for logged hours.
metadata:
  author: test
---

# Invoice from a timesheet

1. Read the CSV and total the hours per client.
2. Run scripts/total.sh to check the sum.
3. Compose the invoice with pdf_compose and check it with pdf_look.
`;

await test("a SKILL.md is read the way the format writes it: front matter, then instructions", () => {
  const p = skills.parseSkillMd(GOOD);
  assert.ok(p.ok, p.ok ? "" : p.error);
  assert.equal(p.name, "invoice-from-timesheet");
  assert.match(p.description, /Use when the person asks to bill/);
  assert.deepEqual(p.meta.metadata, { author: "test" });
  assert.match(p.body, /^# Invoice from a timesheet/);
  const folded = skills.parseSkillMd("---\nname: a-skill\ndescription: >\n  Does a thing across\n  two lines, when asked.\n---\n\n" + "Step one, then step two, then check the result.\n");
  assert.ok(folded.ok && folded.description === "Does a thing across two lines, when asked.");
});

await test("what the format does not allow is refused, saying what to change", () => {
  const bad = (text: string, why: RegExp) => {
    const p = skills.parseSkillMd(text);
    assert.equal(p.ok, false, text);
    assert.match((p as { error: string }).error, why);
  };
  bad("# no front matter\n\nJust text.", /must start with front matter/);
  bad(GOOD.replace("invoice-from-timesheet", "Invoice_From"), /lowercase letters, digits and single hyphens/);
  bad(GOOD.replace("invoice-from-timesheet", "a--b"), /not a skill name/);
  bad(GOOD.replace(/description: .*/, "description: ok"), /too short to choose by/);
  bad(GOOD.replace(/description: .*/, `description: ${"x".repeat(1100)}`), /allows 1024/);
  bad(GOOD.replace(/# Invoice[\s\S]*/, "Short."), /needs instructions/);
  bad(GOOD.replace("2. Run", "api_key: sk-abcdef1234567890\n2. Run"), /password, key or token/);
  assert.ok(skills.parseSkillMd(GOOD.replace("2. Run", "Read the key from $STRIPE_API_KEY (token: $STRIPE_TOKEN).\n2. Run")).ok, "naming where a key is kept is fine");
  assert.equal(skills.slugOf("Docker: restart a stuck container!"), "docker-restart-a-stuck-container");
});

await test("a skill is a folder on disk with SKILL.md and its files beside it", () => {
  const { info, created } = skills.writeSkill(GOOD, { kind: "person" }, { "scripts/total.sh": "#!/bin/sh\nawk -F, '{s+=$3} END {print s}' \"$1\"\n" });
  assert.ok(created);
  assert.equal(info.status, "live", "the person's own is live at once");
  assert.deepEqual(info.files, ["scripts/total.sh"]);
  const s = skills.getSkill("invoice-from-timesheet")!;
  assert.equal(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), GOOD);
  assert.ok(fs.existsSync(path.join(s.dir, "scripts", "total.sh")));
  assert.throws(() => skills.writeSkill(GOOD, { kind: "person" }, { "../escape.sh": "x" }), /not a path inside/);
  assert.throws(() => skills.writeSkill(GOOD, { kind: "person" }, { ".autora.json": "{}" }), /not a path inside/);
});

await test("the agent sees each skill's name and description every turn, and loads the rest only when it picks one", async () => {
  const brief = await capabilityBriefing();
  assert.match(brief, /- Skills: always available\. Tool: skill\./);
  assert.match(brief, /invoice-from-timesheet: Turns a timesheet CSV into an invoice PDF/);
  assert.doesNotMatch(brief, /Run scripts\/total\.sh/, "the instructions are not in the briefing");
  const use = await runTool(findTool("skill")!, { action: "use", name: "invoice-from-timesheet" }, ctx());
  assert.ok(use.ok);
  assert.match(use.summary, /Run scripts\/total\.sh/);
  assert.match(use.summary, /Files in this skill \(folder .*\): scripts\/total\.sh/);
  assert.equal(skills.getSkill("invoice-from-timesheet")!.uses, 1);
  const read = await runTool(findTool("skill")!, { action: "read", name: "invoice-from-timesheet", path: "scripts/total.sh" }, ctx());
  assert.match(read.summary, /awk/);
  const miss = await runTool(findTool("skill")!, { action: "use", name: "invoice-timesheet" }, ctx());
  assert.equal(miss.ok, false);
  assert.match(miss.summary, /Did you mean invoice-from-timesheet/);
  const list = await runTool(findTool("skill")!, { action: "list", query: "bill a client" }, ctx());
  assert.match(list.summary, /invoice-from-timesheet/);
});

await test("an agent writes a skill as a draft, improves it with the old text kept, and it goes live by working", async () => {
  const w = await runTool(findTool("skill")!, {
    action: "write", name: "restart-jellyfin-scan",
    description: "Gets a stuck Jellyfin library scan going again. Use when the media library stops updating.",
    body: "1. Stop the container with docker stop jellyfin.\n2. Start it again.\n3. Check the scan log moves.",
    files: { "scripts/restart.sh": "#!/bin/sh\ndocker stop jellyfin && docker start jellyfin\n" },
  }, ctx({ id: "agent_x", name: "Sabrina" }));
  assert.ok(w.ok, w.summary);
  assert.match(w.summary, /as a draft/);
  let s = skills.getSkill("restart-jellyfin-scan")!;
  assert.equal(s.status, "draft");
  assert.deepEqual(s.author, { kind: "agent", id: "agent_x", name: "Sabrina" });
  assert.match(skills.catalogue(), /restart-jellyfin-scan \(draft, not yet approved\)/);

  const again = await runTool(findTool("skill")!, {
    action: "write", name: "restart-jellyfin-scan",
    description: "Gets a stuck Jellyfin library scan going again. Use when the media library stops updating.",
    body: "1. Stop the container with docker stop jellyfin.\n2. Wait five seconds.\n3. Start it again and check the scan log moves.",
  }, ctx({ id: "agent_y", name: "Marcus" }));
  assert.ok(again.ok);
  s = skills.getSkill("restart-jellyfin-scan")!;
  assert.equal(s.versions, 1);
  assert.match(s.body, /Wait five seconds/);
  assert.equal(s.author.kind === "agent" && s.author.name, "Sabrina", "the author stays who first wrote it");
  skills.revertSkill("restart-jellyfin-scan");
  assert.doesNotMatch(skills.getSkill("restart-jellyfin-scan")!.body, /Wait five seconds/, "one step back");

  for (let i = 0; i < skills.LIVE_AFTER - 1; i++) skills.noteSkillOutcome(["restart-jellyfin-scan"], true);
  skills.noteSkillOutcome(["restart-jellyfin-scan"], false);
  assert.equal(skills.getSkill("restart-jellyfin-scan")!.status, "draft");
  const went = skills.noteSkillOutcome(["restart-jellyfin-scan"], true);
  assert.deepEqual(went, [{ name: "restart-jellyfin-scan", live: true }]);
  assert.equal(skills.getSkill("restart-jellyfin-scan")!.status, "live");

  const bad = await runTool(findTool("skill")!, { action: "write", name: "Bad Name", description: "x", body: "y" }, ctx());
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /^Not written\./);
  const hidden = await runTool(findTool("skill")!, { action: "write", name: "x-skill", description: "A thing worth writing down.", body: "Do the first step, then the second, then check." }, { ...ctx(), memory: { ...ctx().memory, incognito: true } });
  assert.equal(hidden.ok, false, "an incognito chat keeps nothing");
});

await test("a skill comes in from a zip of its folder and goes out as one, so it works anywhere the format is read", () => {
  const zip = zipSync({
    "pack/pdf-tidy/SKILL.md": strToU8("---\nname: pdf-tidy\ndescription: Tidies a scanned PDF so it reads well. Use when a scan is crooked or too large.\n---\n\nDeskew each page, compress it, then check the result with pdf_look.\n"),
    "pack/pdf-tidy/references/notes.md": strToU8("Notes."),
    "pack/broken/SKILL.md": strToU8("no front matter here"),
    "__MACOSX/pack/pdf-tidy/SKILL.md": strToU8("junk"),
  });
  const r = skills.importSkills(zip);
  assert.deepEqual(r.imported.map((s) => s.name), ["pdf-tidy"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].error, /front matter/);
  assert.deepEqual(skills.getSkill("pdf-tidy")!.files, ["references/notes.md"]);
  const out = unzipSync(skills.exportSkill("pdf-tidy"));
  assert.deepEqual(Object.keys(out).sort(), ["pdf-tidy/SKILL.md", "pdf-tidy/references/notes.md"]);
  assert.match(strFromU8(out["pdf-tidy/SKILL.md"]), /^---\nname: pdf-tidy/);
  assert.throws(() => skills.importSkills(strToU8("not a zip")), /not a zip/);
});

await test("skills leave the Mind: old skill memories become skills, and the Mind refuses new ones", () => {
  const g = new MemoryGraph([], [], () => undefined);
  g.write({ title: "Backups: rotate the NAS snapshots", body: "Run the rotation script weekly, keep eight, and check free space after.", kind: "skill", tags: ["skill", "backups"] });
  g.write({ title: "A fact", body: "The NAS is at 10.0.0.5.", kind: "fact" });
  assert.equal(skills.moveSkillsOutOf(g, { kind: "person" }), 1);
  assert.deepEqual(g.active().map((r) => r.kind), ["fact"]);
  const moved = skills.getSkill("backups-rotate-the-nas-snapshots")!;
  assert.ok(moved, "named from its title");
  assert.match(moved.description, /Use for work about backups/);
  assert.match(moved.body, /Run the rotation script weekly/);
  assert.equal(skills.moveSkillsOutOf(g, { kind: "person" }), 0, "running it again moves nothing");
  const refused = checkEntry({ title: "x", body: "a way to do it", kind: "skill" });
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /skill tool/);
});

await test("a skill learns how many steps it usually takes, and a turn far past that is told once", () => {
  skills.writeSkillParts({ name: "pace-check", description: "A skill to test how its usual pace is learned.", body: "Do the first thing, then the second, then check it." }, { kind: "person" });
  assert.equal(skills.typicalSteps("pace-check"), null, "nothing to go on yet");
  assert.equal(skills.overBudget(["pace-check"], 50), null, "no budget without a history");
  skills.noteSkillOutcome(["pace-check"], true, 4);
  skills.noteSkillOutcome(["pace-check"], true, 6);
  skills.noteSkillOutcome(["pace-check"], false, 40);
  assert.equal(skills.typicalSteps("pace-check"), 5, "the median of the turns that went well");
  assert.equal(skills.overBudget(["pace-check"], 10), null, "under the floor of eight, whatever twice the usual is");
  assert.match(skills.overBudget(["pace-check"], 11) ?? "", /\[Step budget\] This turn has taken 11 rounds; the skill it follows usually takes pace-check about 5/);
  const use = skills.skillForUse("pace-check");
  assert.ok(use.ok && /took about 5 rounds/.test(use.text));
});

await test("the Skills page's routes: list, open, check as typed, create, rename, approve, roll back, export, import", async () => {
  const express = (await import("express")).default;
  const { skillRoutes } = await import("../server/routes/skills");
  const app = express();
  app.use(express.json());
  skillRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(base + url, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  try {
    assert.ok((await send("GET", "/api/skills")).body.skills.some((s: { name: string }) => s.name === "invoice-from-timesheet"));
    const check = await send("POST", "/api/skills-check", { text: "---\nname: x\n---\n" });
    assert.equal(check.body.ok, false);
    const text = skills.composeSkillMd("weekly-report", "Writes the weekly status report from the board. Use every Friday or when asked for the week's report.", "1. Read the board.\n2. Group by owner.\n3. Write it up and check every card is covered.");
    assert.equal((await send("POST", "/api/skills", { text })).status, 200);
    assert.equal((await send("POST", "/api/skills", { text })).status, 409, "a second with the same name is refused");
    const renamed = await send("PUT", "/api/skills/weekly-report", { text: text.replace("name: weekly-report", "name: friday-report") });
    assert.equal(renamed.body.info.name, "friday-report");
    assert.equal((await send("GET", "/api/skills/weekly-report")).status, 404);
    const opened = await send("GET", "/api/skills/friday-report");
    assert.equal(opened.body.versions.length, 1);
    assert.equal(opened.body.skill.dir, undefined, "where it is on disk is not the page's business");
    assert.equal((await send("POST", "/api/skills/friday-report/revert", { index: 0 })).status, 400, "an old version under another name is refused");
    const zip = await fetch(`${base}/api/skills/friday-report/export`);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    const bytes = new Uint8Array(await zip.arrayBuffer());
    assert.equal((await send("DELETE", "/api/skills/friday-report")).status, 200);
    const back = await fetch(`${base}/api/skills-import`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: bytes });
    assert.deepEqual(((await back.json()) as { imported: { name: string }[] }).imported.map((s) => s.name), ["friday-report"]);
    const drafted = skills.writeSkillParts({ name: "draft-one", description: "A draft an agent wrote to test approval here.", body: "Do the first thing, then the second, then check it." }, { kind: "agent", id: "a", name: "Ana" });
    assert.equal(drafted.info.status, "draft");
    assert.equal((await send("POST", "/api/skills/draft-one/approve")).body.skill.status, "live");
  } finally {
    server.close();
  }
});

await test("a skill's script is edited on its own, kept as a version, and the whole library comes out as one zip", async () => {
  const express = (await import("express")).default;
  const { skillRoutes } = await import("../server/routes/skills");
  const { unzipSync } = await import("fflate");
  const app = express();
  app.use(express.json());
  skillRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const put = async (path: string, text: string | null) => {
    const r = await fetch(`${base}/api/skills/with-script/files`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, text }),
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const reads = (rel: string) => {
    const got = skills.readSkillFile("with-script", rel);
    return got.ok ? got.text : `not read: ${got.error}`;
  };
  try {
    skills.writeSkill(
      skills.composeSkillMd("with-script", "Runs a small script beside it, to prove a file can be edited here.", "1. Run `scripts/run.sh` from the skill's folder.\n2. Read what it prints and compare it with the figures in the report.\n3. When a line differs, say which one before changing anything."),
      { kind: "person" },
    );
    const added = await put("scripts/run.sh", "echo one\n");
    assert.equal(added.status, 200);
    assert.equal(reads("scripts/run.sh"), "echo one\n");

    /* "New file" sends an empty text: that makes an empty file, it does not delete one. */
    const empty = await put("scripts/empty.txt", "");
    assert.equal(empty.status, 200);
    assert.equal(reads("scripts/empty.txt"), "", "an empty text creates an empty file");

    const absolute = await put("/etc/passwd", "x");
    assert.equal(absolute.status, 400, "an absolute path is refused, not tucked into the folder");
    assert.match(absolute.body.error, /absolute path/);

    const escape = await put("../../outside.txt", "x");
    assert.equal(escape.status, 400, "a path out of the skill's folder is refused");
    assert.match(escape.body.error, /inside the skill's folder/);
    assert.equal((await put("SKILL.md", "x")).status, 400, "SKILL.md is the text, not a file beside it");

    const edited = await put("scripts/run.sh", "echo two\n");
    assert.equal(reads("scripts/run.sh"), "echo two\n");
    assert.equal(edited.body.versions[0].files["scripts/run.sh"], "echo one\n", "the version keeps the script it replaced");
    assert.equal(edited.body.skill.text === undefined, true, "the route does not send the body back");
    const opened = await (await fetch(`${base}/api/skills/with-script`)).json() as any;
    assert.ok(
      opened.versions.some((v: { files?: Record<string, string | null> }) => v.files && v.files["scripts/run.sh"] === "echo one\n"),
      "the page is told which files a version changed, so it can say so",
    );

    skills.revertSkill("with-script", 0);
    assert.equal(reads("scripts/run.sh"), "echo one\n", "going back puts the script back too");

    const removed = await put("scripts/run.sh", null);
    assert.equal(removed.status, 200);
    assert.match(reads("scripts/run.sh"), /^not read/);
    skills.revertSkill("with-script", 0);
    assert.equal(reads("scripts/run.sh"), "echo one\n", "a removed file comes back too");

    const all = await fetch(`${base}/api/skills-export`);
    assert.equal(all.headers.get("content-type"), "application/zip");
    const zipped = Object.keys(unzipSync(new Uint8Array(await all.arrayBuffer())));
    assert.ok(zipped.includes("with-script/SKILL.md"), "every skill's SKILL.md is in the one zip");
    assert.ok(zipped.includes("with-script/scripts/run.sh"), "and the scripts beside it");
    assert.ok(zipped.filter((p) => /\.zip/.test(p)).length === 0);
  } finally {
    server.close();
  }
});

console.log(`${passed} passed`);

function ctx(self?: { id: string; name: string }) {
  return {
    onOutput: () => undefined, putBlob: () => "", showImage: () => undefined, showWidget: () => undefined,
    showScreen: () => undefined, browser: () => { throw new Error("no browser"); }, browserChanged: () => undefined,
    watchDesktop: () => undefined, cancelled: () => false, onCancel: () => undefined,
    memory: {
      write: () => ({ id: "", action: "added" }), search: () => [], update: () => false, confirm: () => false,
      forget: () => false, link: () => null,
    },
    vault: () => null, session: "s-test", ask: async () => ({ cancelled: true, choices: [], text: "", who: "" }),
    ...(self ? { agents: { self, run: async () => ({ ok: true, summary: "" }), mind: { domains: () => "", teach: () => ({ ok: true, summary: "" }) } } } : {}),
  } as unknown as Parameters<typeof runTool>[2];
}
