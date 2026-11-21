/**
 * Handing the person a picture, video or sound from the web.
 *
 * media_show fetches an address and, if what came back really is a picture, a
 * film or a sound (judged by its first bytes, not by what the server called
 * it), puts it in the reply as a card: a picture, or a player. While a project
 * is being worked on the Panacea canvas it goes on the canvas instead. Anything
 * else is said in words and nothing is drawn.
 *
 *   npx tsx tests/mediashow.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-imageshow-"));
process.env.AUTORA_STATE_DIR = dir;

const { findTool, runTool } = await import("../server/tools");

console.log("media_show");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The first bytes of an MP4 (an ftyp box) and of an MP3 (an ID3 tag), with filler behind them. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);

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
    case "/clip":
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(MP4);
    case "/song.mp3":
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(MP3);
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
const files: Array<{ id: string; name: string; mime: string; size: number }> = [];
const ctx = {
  showFile: (file: { id: string; name: string; mime: string; size: number }) => { files.push(file); },
  memory: { incognito: false },
  onOutput: () => undefined,
  putBlob: (data: Buffer, mime: string) => { stored.push({ mime, bytes: data.length }); return `blob${stored.length}`; },
  showImage: (blob: string, alt: string, caption: string | null | undefined, size?: { w: number; h: number }) => {
    shown.push({ blob, alt, caption, size });
  },
  cancelled: () => false,
  onCancel: () => undefined,
  session: "test",
} as unknown as import("../server/tools").ToolContext;

const spec = findTool("media_show");
assert.ok(spec, "media_show is a tool");
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

const video = await runTool(spec, { url: `${base}/clip`, caption: "The trailer" }, ctx);
assert.equal(video.ok, true, video.summary);
assert.equal(files.length, 1, "a video is handed over as a file with a player");
assert.equal(files[0].mime, "video/mp4", "known from its bytes, though the server called it octet-stream");
assert.match(files[0].name, /\.mp4$/, "named so the player and the canvas know what it is");
assert.equal(shown.length, before, "and not as a picture");
console.log("  ok  a video from an address is handed over with a player");

const song = await runTool(spec, { url: `${base}/song.mp3` }, ctx);
assert.equal(song.ok, true, song.summary);
assert.equal(files[1].mime, "audio/mpeg");
assert.equal(files[1].name, "song.mp3");
console.log("  ok  a sound from an address is handed over with a player");

const where = await runTool(spec, { url: `${base}/cat.png`, to: "somewhere" }, ctx);
assert.equal(where.ok, false, "to is chat or board");
console.log("  ok  an unknown destination is refused");

const { panaceaHasWork } = await import("../server/panacea");
assert.equal(panaceaHasWork("test"), false, "no project on the canvas yet: it went to the chat");
const onBoard = await runTool(spec, { url: `${base}/cat.png`, caption: "Mood", to: "board" }, ctx);
assert.equal(onBoard.ok, true, onBoard.summary);
assert.match(onBoard.summary, /canvas/);
assert.equal(shown.length, before, "put on the canvas, it is not also a card in the chat");
assert.equal(panaceaHasWork("test"), true, "the canvas now has work on it");
const followed = await runTool(spec, { url: `${base}/cat.png` }, ctx);
assert.equal(followed.ok, true, followed.summary);
assert.match(followed.summary, /canvas/, "while a project is on the canvas, what is fetched goes there by itself");
assert.equal(shown.length, before);
const toChat = await runTool(spec, { url: `${base}/cat.png`, to: "chat" }, ctx);
assert.equal(toChat.ok, true);
assert.equal(shown.length, before + 1, "asked for the chat, it goes in the chat");
console.log("  ok  during a project it goes on the board, and `to` overrides that");

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("mediashow: all passed");
