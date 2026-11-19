/**
 * Copies the delegate wrappers (server/delegates/: what server/vendor.ts runs to hand a job to the Claude Code or Gemini CLI)
 * into dist/delegates/, where the image carries them. Plain JavaScript, so there is nothing to compile: this is a copy with the
 * wrappers made executable. Run by `npm run build`, after the build has emptied dist/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "server", "delegates");
const to = path.join(root, "dist", "delegates");

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(from)) {
  if (!name.endsWith(".mjs")) continue;
  const target = path.join(to, name);
  fs.copyFileSync(path.join(from, name), target);
  fs.chmodSync(target, name.endsWith("-call.mjs") ? 0o755 : 0o644);
}
console.log(`[delegates] ${fs.readdirSync(to).length} files in dist/delegates`);
