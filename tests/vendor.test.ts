/**
 * Handing a job to a vendor's subscription CLI.
 *
 * Three things here are load-bearing and none of them is cosmetic:
 *
 *   1. THE CONTRACT TOLERATES ITS OWN ABSENCE. A wrapper that streams JSON
 *      Lines and a wrapper that prints one plain answer when it is done both
 *      have to work through one path, because the second is what exists today.
 *   2. A FAILURE IS A RESULT, NOT A THROW. Rate limited, signed out, timed
 *      out, not installed: each becomes a sentence the person can act on, and
 *      none of them may take the turn down with it -- the whole point is that
 *      the job can still be done another way.
 *   3. NOTHING SECRET SURVIVES. A vendor's stderr can carry a key or a path to
 *      one, and this text is kept on disk in the transcript.
 *
 *   npm test -- vendor
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derive } from "../src/lib/derive";
import { Kind, type AutoraEvent } from "../src/lib/types";
import {
  failureOf, filesTouched, lineSplitter, parseLine, redact, refusedOption, runVendor, vendorArgs, vendorEnv, vendorReady,
} from "../server/vendor";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}
async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** An event log built the way the server writes one. */
function vendorLog() {
  const events: AutoraEvent[] = [];
  let seq = 0;
  const add = (kind: string, payload: Record<string, any>) => {
    seq += 1;
    events.push({ seq, ts: 1_700_000_000 + seq, kind, actor: "agent", span: null, payload, blob: null });
  };
  return { events, add };
}

const vendorCells = (events: AutoraEvent[]) =>
  derive(events).buckets.flatMap((b) => b.cells).filter((c): c is Extract<ReturnType<typeof derive>["buckets"][0]["cells"][0], { kind: "vendor" }> => c.kind === "vendor");

console.log("vendor");

/* ------------------------------------------------------------- the lines -- */

test("a delta line is answer text", () => {
  assert.deepEqual(parseLine('{"type":"delta","text":"hello "}'), { type: "delta", text: "hello " });
});

test("a status line is what it is doing, not what it says", () => {
  assert.deepEqual(parseLine('{"type":"status","text":"reading lib/derive.ts"}'), { type: "status", text: "reading lib/derive.ts" });
});

test("a result line carries the whole answer, the files and the usage", () => {
  const line = parseLine('{"type":"result","text":"done","files":["src/a.ts"],"usage":{"input_tokens":12,"output_tokens":30}}');
  assert.deepEqual(line, { type: "result", text: "done", files: ["src/a.ts"], usage: { input_tokens: 12, output_tokens: 30 } });
});

test("a result with a junk usage object keeps only the numbers", () => {
  const line = parseLine('{"type":"result","text":"x","usage":{"input_tokens":"12","note":"hi","output_tokens":4}}');
  assert.ok(line && line.type === "result");
  assert.deepEqual(line.usage, { input_tokens: 12, output_tokens: 4 });
});

test("an error line keeps its reason when it is one we know", () => {
  assert.deepEqual(parseLine('{"type":"error","message":"slow down","reason":"rate_limit"}'), {
    type: "error", message: "slow down", reason: "rate_limit",
  });
  const odd = parseLine('{"type":"error","message":"?","reason":"meteor"}');
  assert.ok(odd && odd.type === "error" && odd.reason === "other");
});

test("plain text is answer text: a wrapper that cannot stream still works", () => {
  assert.deepEqual(parseLine("Claude wrote the endpoint."), { type: "delta", text: "Claude wrote the endpoint.\n" });
});

test("a line that starts like JSON but is not JSON is answer text, not a crash", () => {
  assert.deepEqual(parseLine("{not json at all"), { type: "delta", text: "{not json at all\n" });
});

test("a JSON object with a type nobody defined yet still gives up its words", () => {
  assert.deepEqual(parseLine('{"type":"thinking","text":"hmm"}'), { type: "delta", text: "hmm" });
});

test("an empty line says nothing, and so does an empty delta", () => {
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine('{"type":"delta","text":""}'), null);
});

test("a line split across chunks is put back together", () => {
  const got: string[] = [];
  const split = lineSplitter((line) => got.push(line));
  split('{"type":"delta","text":"one"}\n{"type":"del');
  split('ta","text":"two"}\n');
  assert.deepEqual(got, ['{"type":"delta","text":"one"}', '{"type":"delta","text":"two"}']);
});

test("the tail after the last newline waits for the rest of it", () => {
  const got: string[] = [];
  const split = lineSplitter((line) => got.push(line));
  split("no newline yet");
  assert.deepEqual(got, []);
  split("\n");
  assert.deepEqual(got, ["no newline yet"]);
});

/* ------------------------------------------------------------- arguments -- */

test("the prompt goes in on stdin, never as an option the wrapper could read", () => {
  const args = vendorArgs({ id: "claude", prompt: "-rf /", cwd: "/data/work/x" });
  assert.deepEqual(args, ["--jsonl", "--cwd", "/data/work/x", "-"]);
});

test("a wrapper that predates the streaming contract is called without --jsonl", () => {
  const args = vendorArgs({ id: "claude", prompt: "go", cwd: "/x" }, "argv", false);
  assert.deepEqual(args, ["--cwd", "/x", "--", "go"]);
});

test("the reasoning effort goes to Gemini, whose CLI has one, and not to Claude", () => {
  assert.ok(vendorArgs({ id: "gemini", prompt: "x", cwd: "/x", effort: "high" }).includes("--effort"));
  assert.ok(!vendorArgs({ id: "claude", prompt: "x", cwd: "/x", effort: "high" }).includes("--effort"));
});

test("the option a wrapper did not know is read out of what it said", () => {
  assert.equal(refusedOption("unknown option: --jsonl"), "--jsonl");
  assert.equal(refusedOption("unknown option: -"), "-");
  assert.equal(refusedOption("Error: not signed in"), null);
});

test("write, timeout, model and effort are passed through in the wrapper's own form", () => {
  const args = vendorArgs({
    id: "gemini", prompt: "x", cwd: "/tmp/x", write: true, timeoutArg: "10m", model: "gemini-3.8-flash-high", effort: "high",
  });
  assert.deepEqual(args, ["--jsonl", "--model", "gemini-3.8-flash-high", "--effort", "high", "--cwd", "/tmp/x", "--write", "--timeout", "10m", "-"]);
});

/* -------------------------------------------------------------- failures -- */

test("being timed out beats whatever it happened to say last", () => {
  const f = failureOf(1, "some noise", "", true);
  assert.equal(f.reason, "timeout");
});

test("a rate limit is named as one", () => {
  assert.equal(failureOf(1, "Error 429: rate_limit exceeded", "", false).reason, "rate_limit");
  assert.equal(failureOf(1, "API quota exceeded for this project", "", false).reason, "rate_limit");
});

test("being signed out is named as one, because the person has to act", () => {
  assert.equal(failureOf(1, "You are not signed in. Run the login command.", "", false).reason, "auth");
  assert.equal(failureOf(1, "401 Unauthorized", "", false).reason, "auth");
});

test("a missing CLI is named as one", () => {
  assert.equal(failureOf(127, "command not found: claude", "", false).reason, "not_installed");
});

test("anything else keeps what it said, cut to one line", () => {
  const f = failureOf(1, "Traceback\n  more\n  more", "", false);
  assert.equal(f.reason, "other");
  assert.ok(!f.message.includes("\n"));
});

test("a failure with nothing said still says something a person can read", () => {
  const f = failureOf(null, "", "", false);
  assert.equal(f.reason, "other");
  assert.ok(f.message.length > 10);
});

/* -------------------------------------------------------------- redaction -- */

test("a key=value pair never reaches the transcript", () => {
  const out = redact("running with API_KEY=sk-ant-abcdef123456 and token: abcdef");
  assert.ok(!out.includes("sk-ant-abcdef123456"), out);
  assert.ok(!out.includes("abcdef"), out);
});

test("a path to a key is redacted too", () => {
  const out = redact("reading /root/.config/gemini/apikeys.json");
  assert.ok(!out.includes("/root/.config"), out);
});

test("ordinary prose is left alone", () => {
  assert.equal(redact("I fixed the failing test in src/a.ts."), "I fixed the failing test in src/a.ts.");
});

/* ----------------------------------------------------------------- files -- */

test("files written while a delegate ran are found, in the folder it was given", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-files-"));
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, "a.ts"), "x");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "ignored.js"), "x");
  const found = filesTouched(dir, since).map((f) => path.relative(dir, f));
  assert.deepEqual(found, ["a.ts"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an old file is not an edit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-old-"));
  const file = path.join(dir, "old.ts");
  fs.writeFileSync(file, "x");
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(file, old, old);
  assert.deepEqual(filesTouched(dir, Date.now()), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- the run --- */

async function withWrapper(body: string, fn: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-run-"));
  const file = path.join(dir, "wrapper.sh");
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  const was = process.env.AUTORA_CLAUDE_CLI;
  process.env.AUTORA_CLAUDE_CLI = file;
  try {
    await fn(dir);
  } finally {
    if (was === undefined) delete process.env.AUTORA_CLAUDE_CLI;
    else process.env.AUTORA_CLAUDE_CLI = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await testAsync("a streaming wrapper's words arrive before it exits, in order", async () => {
  await withWrapper(
    `printf '%s\\n' '{"type":"status","text":"reading src/a.ts"}' '{"type":"delta","text":"one "}' '{"type":"delta","text":"two"}' '{"type":"result","text":"one two"}'`,
    async (dir) => {
      const chunks: string[] = [];
      const states: string[] = [];
      const out = await runVendor({
        id: "claude", prompt: "go", cwd: dir,
        onDelta: (t) => chunks.push(t), onStatus: (s) => states.push(s),
      });
      assert.equal(out.ok, true);
      assert.equal(out.text, "one two");
      assert.deepEqual(states, ["reading src/a.ts"]);
      assert.equal(chunks.join(""), "one two");
      assert.equal(out.streamed, true);
    },
  );
});

await testAsync("a wrapper that prints one plain answer is read as one piece", async () => {
  await withWrapper(`echo "I fixed the failing test."`, async (dir) => {
    const out = await runVendor({ id: "claude", prompt: "go", cwd: dir });
    assert.equal(out.ok, true);
    assert.equal(out.text.trim(), "I fixed the failing test.");
  });
});

await testAsync("the result line is not said twice when its text already streamed", async () => {
  await withWrapper(
    `printf '%s\\n' '{"type":"delta","text":"the answer"}' '{"type":"result","text":"the answer","files":["src/a.ts"]}'`,
    async (dir) => {
      const out = await runVendor({ id: "claude", prompt: "go", cwd: dir });
      assert.equal(out.text, "the answer");
      assert.deepEqual(out.files, ["src/a.ts"]);
    },
  );
});

await testAsync("a rate limit is a result the caller can act on, not an exception", async () => {
  await withWrapper(
    `printf '%s\\n' '{"type":"error","message":"5-hour limit reached","reason":"rate_limit"}'; exit 1`,
    async (dir) => {
      const out = await runVendor({ id: "claude", prompt: "go", cwd: dir });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "rate_limit");
      assert.ok(out.message.includes("rate limit"));
      assert.equal(out.exitCode, 1);
    },
  );
});

await testAsync("a sign-in that has gone is named, with what it said", async () => {
  await withWrapper(`echo "Error: not signed in. Run claude login." >&2; exit 1`, async (dir) => {
    const out = await runVendor({ id: "claude", prompt: "go", cwd: dir });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "auth");
    assert.ok(out.message.toLowerCase().includes("signed in"));
  });
});

await testAsync("half an answer before a failure is kept: it is worth more than nothing", async () => {
  await withWrapper(
    `printf '%s\\n' '{"type":"delta","text":"half of it"}'; echo "killed" >&2; exit 1`,
    async (dir) => {
      const out = await runVendor({ id: "claude", prompt: "go", cwd: dir });
      assert.equal(out.ok, false);
      assert.equal(out.text, "half of it");
    },
  );
});

await testAsync("a wrapper that is not there is named as not installed, with the fix", async () => {
  const was = process.env.AUTORA_CLAUDE_CLI;
  process.env.AUTORA_CLAUDE_CLI = "/nonexistent/claude-call.sh";
  try {
    const out = await runVendor({ id: "claude", prompt: "go", cwd: os.tmpdir() });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not_installed");
    assert.ok(out.message.includes("/nonexistent/claude-call.sh"), out.message);
  } finally {
    if (was === undefined) delete process.env.AUTORA_CLAUDE_CLI;
    else process.env.AUTORA_CLAUDE_CLI = was;
  }
});

await testAsync("a wrapper that does not take stdin is asked again with the prompt as the last word", async () => {
  /* Exactly what /data/bin/gemini-call.sh does today: `-` hits its option
     parser and exits 2 before it does any work. */
  await withWrapper(
    `for a in "$@"; do case "$a" in -) echo "unknown option: $a" >&2; exit 2 ;; esac; done; echo "asked: $*"`,
    async (dir) => {
      const out = await runVendor({ id: "claude", prompt: "review the diff", cwd: dir });
      assert.equal(out.ok, true);
      assert.ok(out.text.includes("review the diff"), out.text);
    },
  );
});

await testAsync("a wrapper written before --jsonl is still called, without it", async () => {
  /* The older shape: it knows --cwd and --write and nothing else, and refuses
     the bare `-` too. Both are shed, and the answer still arrives. */
  await withWrapper(
    `for a in "$@"; do case "$a" in --jsonl|-|--effort) echo "unknown option: $a" >&2; exit 2 ;; esac; done; echo "asked: $*"`,
    async (dir) => {
      const out = await runVendor({ id: "claude", prompt: "review it", cwd: dir, effort: "high" });
      assert.equal(out.ok, true, out.message);
      assert.ok(out.text.includes("review it"), out.text);
    },
  );
});

await testAsync("a wrapper that never finishes is stopped at the ceiling and says so", async () => {
  await withWrapper(`sleep 30`, async (dir) => {
    const out = await runVendor({ id: "claude", prompt: "go", cwd: dir, hardTimeoutMs: 400 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "timeout");
  });
});

await testAsync("a key printed by the wrapper does not survive into what is kept", async () => {
  await withWrapper(`echo "using API_KEY=sk-ant-secretvalue123"`, async (dir) => {
    const out = await runVendor({ id: "claude", prompt: "go", cwd: dir });
    assert.ok(!out.text.includes("sk-ant-secretvalue123"), out.text);
  });
});

test("a delegate is not handed the server's own secrets", () => {
  const env = vendorEnv({
    PATH: "/usr/bin", HOME: "/root", DEEPGRAM_API_KEY: "dg-secret", OPENROUTER_API_KEY: "or-secret",
    ANTHROPIC_API_KEY: "vendor-own", XDG_CONFIG_HOME: "/root/.config", AUTORA_PORT: "8817",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/root");
  assert.equal(env.ANTHROPIC_API_KEY, "vendor-own", "the vendor's own variable goes through");
  assert.equal(env.XDG_CONFIG_HOME, "/root/.config");
  assert.equal(env.DEEPGRAM_API_KEY, undefined, "another service's key does not");
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.TERM, "dumb");
});

test("the default wrapper for each vendor is where it is documented to be", () => {
  const ready = vendorReady("gemini");
  assert.ok(ready.path.endsWith("gemini-call.sh"), ready.path);
});

/* ------------------------------------------------------------- the thread -- */

test("a handoff and a streamed answer make one bubble, holding both halves", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "claude", name: "Claude", text: "Handing this to Claude to read /data/work/x.", cwd: "/data/work/x" });
  add(Kind.VendorDelta, { id: "v1", text: "The test " });
  add(Kind.VendorDelta, { id: "v1", text: "fails on line 4." });
  const cells = vendorCells(events);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].text, "The test fails on line 4.");
  assert.equal(cells[0].done, false);
  assert.equal(cells[0].folder, "/data/work/x");
  assert.equal(cells[0].name, "Claude");
});

test("what it is doing shows while it works and is cleared by its answer", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "gemini", name: "Gemini", text: "Handing this to Gemini.", cwd: "/x" });
  add(Kind.VendorStatus, { id: "v1", text: "reading server/tools.ts" });
  assert.equal(vendorCells(events)[0].doing, "reading server/tools.ts");
  add(Kind.VendorDelta, { id: "v1", text: "done" });
  assert.equal(vendorCells(events)[0].doing, null);
});

test("the end of a run carries the duration and what it edited", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "claude", name: "Claude", text: "Handing this to Claude.", cwd: "/x" });
  add(Kind.VendorDelta, { id: "v1", text: "Done." });
  add(Kind.VendorDone, { id: "v1", ok: true, reason: null, message: "", durationMs: 62_000, files: ["src/a.ts", "src/b.ts"] });
  const cell = vendorCells(events)[0];
  assert.equal(cell.done, true);
  assert.equal(cell.ok, true);
  assert.equal(cell.durationMs, 62_000);
  assert.deepEqual(cell.files, ["src/a.ts", "src/b.ts"]);
});

test("a failure is the vendor's bubble saying which, and keeps what it managed to say", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "claude", name: "Claude", text: "Handing this to Claude.", cwd: "/x" });
  add(Kind.VendorDelta, { id: "v1", text: "Starting on the file… " });
  add(Kind.VendorDone, { id: "v1", ok: false, reason: "rate_limit", message: "It hit its rate limit.", durationMs: 3000, files: [] });
  const cell = vendorCells(events)[0];
  assert.equal(cell.ok, false);
  assert.equal(cell.reason, "rate_limit");
  assert.equal(cell.message, "It hit its rate limit.");
  assert.equal(cell.text, "Starting on the file… ");
});

test("an answer that only arrives with the finish is not lost", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "gemini", name: "Gemini", text: "Handing this to Gemini.", cwd: "/x" });
  add(Kind.VendorDone, { id: "v1", ok: true, reason: null, message: "", durationMs: 900, files: [], text: "All of it, at the end." });
  assert.equal(vendorCells(events)[0].text, "All of it, at the end.");
});

test("a delta for a bubble that is already finished does not reopen it", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "claude", name: "Claude", text: "Handing this to Claude.", cwd: "/x" });
  add(Kind.VendorDone, { id: "v1", ok: true, reason: null, message: "", durationMs: 10, files: [] });
  add(Kind.VendorDelta, { id: "v1", text: "late" });
  const cell = vendorCells(events)[0];
  assert.equal(cell.done, true);
  assert.equal(cell.text, "late");
});

test("two delegates are two bubbles, each holding its own words", () => {
  const { events, add } = vendorLog();
  add(Kind.VendorHandoff, { id: "v1", vendor: "claude", name: "Claude", text: "Handing this to Claude.", cwd: "/x" });
  add(Kind.VendorDelta, { id: "v1", text: "claude says" });
  add(Kind.VendorHandoff, { id: "v2", vendor: "gemini", name: "Gemini", text: "Handing this to Gemini.", cwd: "/y" });
  add(Kind.VendorDelta, { id: "v2", text: "gemini says" });
  const cells = vendorCells(events);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map((c) => c.text), ["claude says", "gemini says"]);
});

console.log(`\nvendor: ${passed} passed`);
