import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The host clipboard is a file under /data/settings. Point it at a scratch folder for the test rather than touching the
 * real one, so a test run cannot overwrite what the person has copied.
 */
const dir = mkdtempSync(join(tmpdir(), "clip-"));
const file = join(dir, "clipboard.txt");
process.env.AUTORA_CLIPBOARD_FILE = file;

/** The path is read when the module loads, so it is set above before the first import. */
describe("the clipboard", () => {
  let mod: typeof import("../server/clipboard");

  beforeEach(async () => {
    mod = await import("../server/clipboard");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies to the host and reads it back", () => {
    const done = mod.copyText("hello there", "host");
    expect(done.place).toBe("host");
    expect(done.chars).toBe(11);
    expect(mod.hostClipboard().text).toBe("hello there");
  });

  it("says how much was copied without repeating a long text", () => {
    const long = "x".repeat(900);
    const said = mod.describeClip(mod.copyText(long, "host"), "copied");
    expect(said).toContain("900 characters");
    expect(said.length).toBeLessThan(200);
  });

  it("says plainly when a clipboard is empty", () => {
    expect(mod.describeClip(mod.hostClipboard(), "pasted")).toMatch(/Nothing on the host clipboard/);
  });

  it("shows the start of what was pasted, and says where from", () => {
    mod.copyText("a token for GitHub", "host");
    const said = mod.describeClip(mod.hostClipboard(), "pasted");
    expect(said).toContain("a token for GitHub");
    expect(said).toContain("host clipboard");
  });

  it("cuts text longer than the limit and says so", () => {
    const done = mod.copyText("y".repeat(250_000), "host");
    expect(done.text.length).toBe(200_000);
    expect(done.truncated).toBe(true);
    expect(mod.describeClip(done, "copied")).toContain("cut");
  });

  it("keeps the file on disk, so it survives a restart", () => {
    mod.copyText("durable", "host");
    expect(readFileSync(file, "utf8")).toBe("durable");
  });
});
