/**
 * The mirror view of the live browser (server/mirror.ts, server/mirror-script.ts, src/lib/mirrorDom.ts).
 *
 * First the cleaning, as plain functions: scripts, `on*` handlers and `javascript:` addresses never leave the
 * server, every sub-resource becomes a token, a password is its length only, a resource is never served as a page.
 * Then a real Chromium: a site with a DOM, a canvas, a password field and a page full of traps is recorded on one
 * origin and rebuilt on another, in a sandboxed frame with no scripts, the way MirrorView does it. The snapshot
 * arrives, a change on the real page shows up in the copy, a node's box and a scroll go back to the real page, the
 * canvas comes as a cropped picture, a page too large falls back, nothing from the site runs, and the copy loads
 * nothing from the site directly.
 *
 *   npx tsx tests/mirror.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildSync } from "esbuild";
import { chromium } from "playwright-core";
import {
  MIRROR_LIMITS, MirrorRecorder, ResourceTokens, cleanNode, cleanOp, remember, rewriteCss, servedType, type MirrorNode,
} from "../server/mirror";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const PREFIX = "/r/";
const san = () => ({ tokens: new ResourceTokens(PREFIX), base: "https://site.test/dir/page", referer: "https://site.test/dir/page" });

function walk(node: MirrorNode | { r: number } | undefined, fn: (n: MirrorNode) => void) {
  if (!node || "r" in node) return;
  fn(node);
  for (const c of node.c ?? []) walk(c, fn);
  for (const c of node.s?.c ?? []) walk(c, fn);
}

async function main() {
  await test("scripts, handlers and javascript: addresses are left out", () => {
    const s = san();
    const out = cleanNode({
      i: 1, n: "body", a: { onload: "x()" }, c: [
        { i: 2, n: "script", a: {}, c: [{ i: 3, t: "alert(1)" }] },
        { i: 4, n: "img", a: { src: "javascript:alert(1)", onerror: "alert(1)", alt: "a" } },
        { i: 5, n: "a", a: { href: "javascript:alert(1)", OnClick: "x" } },
        { i: 6, n: "a", a: { href: "/next" } },
        { i: 7, n: "svg", ns: 1, a: { onload: "x" }, c: [{ i: 8, n: "set", ns: 1, a: { attributeName: "href", to: "javascript:alert(1)" } }] },
        { i: 9, n: "meta", a: { "http-equiv": "refresh", content: "0;url=x" } },
        { i: 10, n: "base", a: { href: "https://evil.test/" } },
        { i: 11, n: "form", a: { action: "https://site.test/post" } },
        { i: 12, n: "button", a: { formaction: "https://x" } },
        { i: 13, n: "iframe", a: { src: "https://other.test/", srcdoc: "<script>", class: "f" }, w: 300, h: 150 },
      ],
    }, s)!;
    const all: MirrorNode[] = [];
    walk(out, (n) => all.push(n));
    const json = JSON.stringify(out);
    assert.ok(!all.some((n) => n.n === "script" || n.n === "meta" || n.n === "base" || n.n === "set"));
    assert.ok(!/javascript:|onload|onerror|onclick|srcdoc|formaction|action|other\.test/i.test(json), json);
    assert.equal(all.find((n) => n.i === 6)?.a?.href, "#", "a link goes nowhere on its own");
    const frame = all.find((n) => n.i === 13)!;
    assert.equal(frame.rg, 1, "a frame is a picture region");
    assert.deepEqual(frame.a, { class: "f" });
  });

  await test("every sub-resource is a token, in attributes, srcset and style sheets", () => {
    const s = san();
    const out = cleanNode({
      i: 1, n: "div", a: { style: "background:url('../bg.png')" }, c: [
        { i: 2, n: "img", a: { src: "https://cdn.test/a.png", srcset: "https://cdn.test/a.png 1x, https://cdn.test/b.png 2x" } },
        { i: 3, n: "link", a: { rel: "stylesheet", href: "https://site.test/s.css", integrity: "sha-x" } },
        { i: 4, n: "link", a: { rel: "preload", href: "https://site.test/x.js" } },
        { i: 5, n: "style", a: {}, c: [{ i: -1, t: "@import 'more.css'; @font-face{src:url(f.woff2)} .x{background:url(data:image/png;base64,AAA)} .y{background:url(javascript:alert(1))}" }] },
        { i: 6, n: "img", a: { src: "data:image/png;base64,AAAA" } },
        { i: 7, n: "img", a: { src: "data:text/html,<script>alert(1)</script>" } },
      ],
    }, s)!;
    const json = JSON.stringify(out);
    assert.ok(!/cdn\.test|site\.test|javascript/.test(json), json);
    const kids = out.c as MirrorNode[];
    assert.ok(kids[0].a!.src.startsWith(PREFIX));
    assert.match(kids[0].a!.srcset, /^\/r\/\S+ 1x, \/r\/\S+ 2x$/);
    assert.ok(kids[1].a!.href.startsWith(PREFIX));
    assert.equal(kids[1].a!.integrity, undefined, "integrity would fail against the rewritten sheet");
    assert.equal(kids[2].a!.href, undefined, "a preload loads nothing");
    assert.match(String((kids[3].c![0] as MirrorNode).t), /@import url\("\/r\/[^"]+"\)/);
    assert.match(String((kids[3].c![0] as MirrorNode).t), /url\("data:image\/png;base64,AAA"\)/);
    assert.match(String((kids[3].c![0] as MirrorNode).t), /url\("about:invalid"\)/);
    assert.equal(kids[4].a!.src, "data:image/png;base64,AAAA");
    assert.equal(kids[5].a!.src, undefined, "an inline page is not a picture");
    assert.equal(s.tokens.get(kids[0].a!.src.slice(PREFIX.length))?.url, "https://cdn.test/a.png");
    assert.equal(s.tokens.get(kids[1].a!.href.slice(PREFIX.length))?.kind, "css");
    assert.match(out.a!.style, /url\("\/r\//);
  });

  await test("a token is the same for the same address, and unguessable", () => {
    const t = new ResourceTokens(PREFIX);
    const a = t.token("https://x.test/a.png", "img", "");
    assert.equal(t.token("https://x.test/a.png", "img", ""), a);
    assert.notEqual(t.token("https://x.test/b.png", "img", ""), a);
    assert.ok(a.length - PREFIX.length >= 16);
    assert.equal(t.get("nope"), undefined);
  });

  await test("a password is its length only, in the snapshot and in changes", () => {
    const s = san();
    const tags = new Map<number, string>();
    const node = cleanNode({ i: 1, n: "input", a: { type: "password", value: "hunter2" }, v: "hunter2" }, s)!;
    remember([node], tags);
    assert.equal(node.v, "•".repeat(7));
    assert.equal(node.a!.value, "");
    assert.deepEqual(cleanOp({ o: "val", i: 1, v: "secret!!" }, s, tags), { o: "val", i: 1, v: "•".repeat(8), k: 0 });
    const text = cleanNode({ i: 2, n: "input", a: { type: "text" }, v: "hello" }, s)!;
    remember([text], tags);
    assert.equal(cleanOp({ o: "val", i: 2, v: "hello" }, s, tags)?.v, "hello");
    assert.equal(cleanOp({ o: "attr", i: 2, k: "onclick", v: "x()" }, s, tags)?.v, null);
  });

  await test("a resource is never served as a page", () => {
    assert.equal(servedType("img", "text/html"), "application/octet-stream");
    assert.equal(servedType("any", "application/javascript"), "application/octet-stream");
    assert.equal(servedType("css", "text/html"), "application/octet-stream");
    assert.equal(servedType("css", "text/css"), "text/css; charset=utf-8");
    assert.equal(servedType("img", "image/png"), "image/png");
    assert.equal(servedType("any", "font/woff2"), "font/woff2");
    assert.equal(rewriteCss("a{b:expression(alert(1))}", "https://x.test/", new ResourceTokens(PREFIX), ""), "a{b:invalid(alert(1))}");
  });

  const exe = CHROME;
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); console.log(`\n${passed} passed`); return; }

  // ---- the site, on one origin
  const siteHits: string[] = [];
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const site = http.createServer((req, res) => {
    siteHits.push(`${req.url} ${req.headers["user-agent"]?.includes("Headless") ? "browser" : "fetch"}`);
    if (req.url === "/s.css") { res.setHeader("content-type", "text/css"); res.end("body{margin:0} .boxed{background:url(/dot.png);width:40px;height:40px}"); return; }
    if (req.url === "/dot.png") { res.setHeader("content-type", "image/png"); res.end(PNG); return; }
    if (req.url === "/big") {
      res.setHeader("content-type", "text/html");
      res.end(`<body>${"<p>words words words</p>".repeat(4000)}</body>`);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/s.css"><style>#hi{color:rgb(1,2,3)}</style></head>
<body style="height:3000px">
<h1 id="hi">Hello mirror</h1>
<div class="boxed" id="boxed"></div>
<img id="pic" src="/dot.png" width="10" height="10">
<input id="pw" type="password" value="">
<input id="name" type="text" value="start">
<button id="btn" onclick="var p=document.createElement('p');p.id='added';p.textContent='Added by the page';document.body.appendChild(p)">Add</button>
<canvas id="cv" width="80" height="60"></canvas>
<script>var c=document.getElementById('cv').getContext('2d');c.fillStyle='rgb(255,0,0)';c.fillRect(0,0,80,60);window.siteRan=1;</script>
<img src="nope.png" onerror="window.__pwned=1">
<a id="js" href="javascript:window.__pwned=1">trap</a>
<svg width="10" height="10" onload="window.__pwned=1"><script>window.__pwned=1</script></svg>
<div id="host"></div>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<b id="inside">In the shadow</b>';</script>
</body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  // ---- the viewer, on another origin: a sandboxed frame with no scripts, as MirrorView makes it
  let recorder: MirrorRecorder | null = null;
  const app = http.createServer(async (req, res) => {
    if (req.url?.startsWith(PREFIX) && recorder) {
      const entry = recorder.tokens.get(req.url.slice(PREFIX.length));
      if (!entry) { res.statusCode = 404; res.end(); return; }
      const up = await fetch(entry.url);
      const body = Buffer.from(await up.arrayBuffer());
      res.setHeader("content-type", servedType(entry.kind, up.headers.get("content-type") ?? ""));
      res.setHeader("content-security-policy", "sandbox");
      res.end(entry.kind === "css" ? rewriteCss(body.toString(), entry.url, recorder.tokens, entry.referer) : body);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><body></body>");
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  const bundle = buildSync({
    entryPoints: [new URL("../src/lib/mirrorDom.ts", import.meta.url).pathname],
    bundle: true, write: false, format: "iife", globalName: "MirrorLib",
  }).outputFiles[0].text;

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const realCtx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const real = await realCtx.newPage();
    await real.goto(`${siteUrl}/`);
    const sent: Array<Record<string, any>> = [];
    let active = true;
    recorder = new MirrorRecorder({ prefix: PREFIX, send: (m) => sent.push(m), active: () => active });
    const cdp = await realCtx.newCDPSession(real);
    await recorder.attach(cdp as any);
    const until = async (pred: () => boolean, what: string, ms = 5000) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(() => sent.some((m) => m.op === "snapshot"), "the snapshot");
    const snap = sent.find((m) => m.op === "snapshot")!;

    await test("the snapshot arrives clean, from a world the page cannot see", async () => {
      const json = JSON.stringify(snap);
      assert.match(json, /Hello mirror/);
      assert.match(json, /In the shadow/, "an open shadow root is carried");
      assert.ok(!/javascript:|onerror|onload|onclick|<script|window\.siteRan|__pwned/.test(json), "nothing that runs");
      assert.ok(!JSON.stringify(snap.root).includes(siteUrl), "no address of the site itself in the page");
      assert.equal(recorder!.status().status, "live");
      assert.equal(await real.evaluate(() => typeof (window as any).__autoraMirror), "undefined", "the recorder is not in the page's world");
      assert.equal(snap.vw, 800);
    });

    // The viewer.
    const viewCtx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const view = await viewCtx.newPage();
    const viewRequests: string[] = [];
    view.on("request", (r) => viewRequests.push(r.url()));
    await view.goto(`${appUrl}/`);
    await view.addScriptTag({ content: bundle });
    await view.evaluate(async (csp) => {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-same-origin");
      f.style.cssText = "width:800px;height:600px;border:0";
      f.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`;
      document.body.appendChild(f);
      await new Promise((r) => f.addEventListener("load", r, { once: true }));
      (window as any).mirror = new (window as any).MirrorLib.MirrorDom(f.contentDocument, "/r/");
      (window as any).frameDoc = f.contentDocument;
      (window as any).frameWin = f.contentWindow;
    }, "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:");
    let applied = 0;
    const pump = async () => {
      const next = sent.slice(applied);
      applied = sent.length;
      await view.evaluate((msgs) => {
        for (const m of msgs) {
          if (m.op === "snapshot") (window as any).mirror.snapshot(m);
          else if (m.op === "batch") (window as any).mirror.apply(m.m);
          else if (m.op === "region") {
            void (window as any).mirror.region(m, (src: string) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; }));
          }
        }
      }, next);
    };
    await pump();

    await test("the copy is drawn in the frame, its style sheets and pictures through Autora", async () => {
      await view.waitForTimeout(400);
      const read = await view.evaluate(() => {
        const d = (window as any).frameDoc as Document;
        return {
          h1: d.getElementById("hi")?.textContent,
          color: getComputedStyle(d.getElementById("hi")!).color,
          boxed: getComputedStyle(d.getElementById("boxed")!).width,
          pic: (d.getElementById("pic") as HTMLImageElement).naturalWidth,
          shadow: d.getElementById("host")?.shadowRoot?.getElementById("inside")?.textContent,
          js: d.getElementById("js")?.getAttribute("href"),
          canvas: d.getElementById("cv")?.tagName,
        };
      });
      assert.equal(read.h1, "Hello mirror");
      assert.equal(read.color, "rgb(1, 2, 3)", "the page's own <style>");
      assert.equal(read.boxed, "40px", "the linked style sheet, through a token");
      assert.equal(read.pic, 1, "the picture, through a token");
      assert.equal(read.shadow, "In the shadow");
      assert.equal(read.js, "#");
      assert.equal(read.canvas, "CANVAS");
    });

    await test("nothing from the site runs, and the copy loads nothing from the site directly", async () => {
      const probe = await view.evaluate(() => ({ app: (window as any).__pwned, frame: ((window as any).frameWin as any).__pwned, ran: ((window as any).frameWin as any).siteRan }));
      assert.deepEqual(probe, { app: undefined, frame: undefined, ran: undefined });
      const direct = viewRequests.filter((u) => u.startsWith(siteUrl));
      assert.deepEqual(direct, [], "every request from the viewer went to Autora");
    });

    await test("a change on the real page shows up in the copy", async () => {
      await real.click("#btn");
      await until(() => sent.slice(applied).some((m) => m.op === "batch" && JSON.stringify(m).includes("Added by the page")), "the batch");
      await pump();
      const text = await view.evaluate(() => ((window as any).frameDoc as Document).getElementById("added")?.textContent);
      assert.equal(text, "Added by the page");
      await real.fill("#name", "typed");
      await until(() => sent.slice(applied).some((m) => m.op === "batch" && m.m.some((o: any) => o.o === "val" && o.v === "typed")), "the value");
      await pump();
      assert.equal(await view.evaluate(() => (((window as any).frameDoc as Document).getElementById("name") as HTMLInputElement).value), "typed");
    });

    await test("a password typed into the real page arrives as dots", async () => {
      const before = sent.length;
      await real.fill("#pw", "hunter22");
      await until(() => JSON.stringify(sent.slice(before)).includes("\u2022".repeat(8)), "the password value");
      const json = JSON.stringify(sent);
      assert.ok(!json.includes("hunter22"), "the characters never leave the page");
      assert.ok(json.includes("•".repeat(8)), JSON.stringify(sent.slice(before)).slice(0, 800));
    });

    await test("a node's box and a scroll go back to the real page", async () => {
      const ids: number[] = [];
      walk(snap.root, (n) => { if (n.a?.id === "btn") ids.push(n.i); });
      const r = await recorder!.rect(ids[0]);
      const real0 = await real.evaluate(() => { const b = document.getElementById("btn")!.getBoundingClientRect(); return { x: b.left, y: b.top }; });
      assert.ok(r && Math.abs(r.x - real0.x) < 1 && Math.abs(r.y - real0.y) < 1);
      assert.equal(await recorder!.rect(999999), null);
      assert.equal(await recorder!.scroll(0, 0, 900), true);
      assert.equal(await real.evaluate(() => scrollY), 900);
      await until(() => sent.some((m) => m.op === "batch" && m.m.some((o: any) => o.o === "scroll" && o.i === 0 && o.y === 900)), "the scroll coming back");
    });

    await test("the canvas comes as a cropped picture, drawn where it belongs", async () => {
      await recorder!.scroll(0, 0, 0);
      await until(() => sent.some((m) => m.op === "region"), "a region picture", 6000);
      await pump();
      await view.waitForTimeout(300);
      const px = await view.evaluate(() => {
        const c = ((window as any).frameDoc as Document).getElementById("cv") as HTMLCanvasElement;
        return Array.from(c.getContext("2d")!.getImageData(40, 30, 1, 1).data);
      });
      assert.ok(px[0] > 200 && px[1] < 60 && px[2] < 60, `red, got ${px}`);
      active = false;
    });

    await test("a page too large for the mirror falls back to pictures", async () => {
      const was = MIRROR_LIMITS.snapshotBytes;
      MIRROR_LIMITS.snapshotBytes = 50_000;
      try {
        await real.goto(`${siteUrl}/big`);
        await until(() => recorder!.status().status === "fallback", "the fallback");
        assert.match(String(recorder!.status().reason), /too large/);
        assert.ok(sent.some((m) => m.op === "state" && m.status === "fallback"));
      } finally {
        MIRROR_LIMITS.snapshotBytes = was;
      }
      await real.goto(`${siteUrl}/`);
      await until(() => recorder!.status().status === "live", `live again on the next page: ${JSON.stringify(sent.slice(-3)).slice(0, 300)}`);
    });
    recorder.detach();
  } finally {
    await browser.close();
    site.close();
    app.close();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
