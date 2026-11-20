/**
 * Where the subscription CLIs are, and whether one looks signed in, without running anything.
 *
 * No imports from the rest of the server: state.ts asks it which subscription is usable (resolveProvider), and vendor.ts and
 * cli-signin.ts build on it, so it has to sit below all three.
 */
import fs from "node:fs";
import path from "node:path";

/** Where an executable of that name is: on PATH, or in the box's own bin folder (/data/bin, AUTORA_BIN_DIR), which outlives an
    update but is not on the image's PATH. The wrappers look in the same places (server/delegates/common.mjs), so a CLI one of
    them would run is never called missing here. */
export function cliPath(bin: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), process.env.AUTORA_BIN_DIR || "/data/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const file = path.join(dir, bin);
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* not in this one */ }
  }
  return null;
}

/** The HOME a CLI runs with: AUTORA_DELEGATE_HOME (under /data in the image, so a sign-in outlives an update), else this one. */
export function cliHome(): string {
  return (process.env.AUTORA_DELEGATE_HOME || "").trim() || process.env.HOME || "/root";
}

/** Gemini's own sign-in file, written by the CLI once the person has signed in with Google. */
export function geminiCredsFile(): string {
  return path.join(cliHome(), ".gemini", "oauth_creds.json");
}

/**
 * Whether a subscription CLI is there and looks signed in: the files its sign-in leaves, nothing run. Good enough for
 * Automatic to pass over one nobody has set up (cli-signin.ts asks the CLI itself when the answer is shown to the person).
 * agy keeps its own token on a box that has it, so a box with agy is taken at its word.
 */
export function cliSignedIn(id: "claude" | "gemini"): boolean {
  if (id === "claude") {
    if (!cliPath("claude")) return false;
    if ((process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim()) return true;
    return fs.existsSync(path.join(cliHome(), ".claude", ".credentials.json"));
  }
  if (cliPath("agy")) return true;
  return Boolean(cliPath("gemini")) && fs.existsSync(geminiCredsFile());
}
