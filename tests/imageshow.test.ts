/**
 * Showing a picture from the web in the conversation.
 *
 * image_show fetches an address and, if what came back really is a picture
 * (judged by its first bytes, not by what the server called it), puts it in the
 * thread as a card. Anything else is said in words and nothing is drawn.
 *
 *   npx tsx tests/imageshow.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-imageshow-"));
process.env.AUTORA_STATE_DIR = dir;

const { findTool, runTool } = await import("../server/tools");

console.log("image_show");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const server = http.createServer((req, res) => {
  switch (req.url) {
    case "/cat.png":
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    // Served as text/html, as a hotlink-protected host does: the bytes decide.
    case "/mislabelled":
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(PNG);
    case "/page.html":
      res.writeHead(200, { "content-type": "image/png" });
      return res.end("<html><body>not a picture</body></html>");
    case "/huge.png":
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]));
    default:
      res.writeHead(404);
      return res.end("nope");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const shown: Array<{ blob: string; alt: string; caption: string | null | undefined; size?: { w: number; h: number } }> = [];
const stored: Array<{ mime: string; bytes: number }> = [];
const ctx = {
  onOutput: () => undefined,
  putBlob: (data: Buffer, mime: string) => { stored.push({ mime, bytes: data.length }); return `blob${stored.length}`; },
  showImage: (blob: string, alt: string, caption: string | null | undefined, size?: { w: number; h: number }) => {
    shown.push({ blob, alt, caption, size });
  },
  cancelled: () => false,
  onCancel: () => undefined,
  session: "test",
} as unknown as import("../server/tools").ToolContext;

const spec = findTool("image_show");
assert.ok(spec, "image_show is a tool");
assert.equal(spec.risky, undefined, "showing a picture asks nobody for anything");

const ok = await runTool(spec, { url: `${base}/cat.png`, caption: "A cat" }, ctx);
assert.equal(ok.ok, true, ok.summary);
assert.equal(shown.length, 1, "one card");
assert.equal(shown[0].caption, "A cat");
assert.equal(shown[0].size?.w, 1, "the size is read from the file");
assert.deepEqual(stored[0], { mime: "image/png", bytes: PNG.length });
console.log("  ok  a picture from an address becomes a card in the thread");

const mislabelled = await runTool(spec, { url: `${base}/mislabelled` }, ctx);
assert.equal(mislabelled.ok, true, "a picture served as text/html is still a picture");
assert.equal(stored[1].mime, "image/png", "the kind comes from the bytes");
console.log("  ok  the bytes decide what it is, not the server's label");

const before = shown.length;
const notPicture = await runTool(spec, { url: `${base}/page.html` }, ctx);
assert.equal(notPicture.ok, false);
assert.match(notPicture.summary, /not a (?:picture|image)/i);
assert.equal(shown.length, before, "nothing is drawn for a page labelled as a picture");
console.log("  ok  something that is not a picture is said in words, not drawn");

const missing = await runTool(spec, { url: `${base}/gone.png` }, ctx);
assert.equal(missing.ok, false);
assert.match(missing.summary, /404/);
assert.equal(shown.length, before);
console.log("  ok  an address that answers with an error says so");

const huge = await runTool(spec, { url: `${base}/huge.png` }, ctx);
assert.equal(huge.ok, false);
assert.match(huge.summary, /too (?:big|large)/i);
assert.equal(shown.length, before);
console.log("  ok  a file over the size cap is refused, not held in memory");

for (const url of ["", "ftp://example.com/a.png", "file:///etc/passwd", "/etc/passwd", "data:image/png;base64,AAAA"]) {
  const bad = await runTool(spec, { url }, ctx);
  assert.equal(bad.ok, false, `refused: ${url}`);
}
assert.equal(shown.length, before);
console.log("  ok  only http and https addresses are fetched");

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("imageshow: all passed");
