/**
 * The protections around the app: requests from other websites refused,
 * secrets blanked wherever they turn up, the GitHub token sent only to
 * GitHub, the https listener's certificates, and settings that survive a
 * crash or a corrupt file.
 *
 *   npx tsx tests/security.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-sec-"));
process.env.AUTORA_STATE_DIR = dir;
// A settings file edited into nonsense, there before the app starts.
fs.writeFileSync(path.join(dir, "settings.json"), "{ this is not json");
// Provider keys that come only from the environment.
process.env.DEEPSEEK_API_KEY = "sk-deepseek-env-0123456789";
process.env.OPENROUTER_API_KEY = "sk-or-v1-abcdefabcdef";
process.env.DEEPGRAM_API_KEY = "dg-secret-key-99887766";

const stateMod = await import("../server/state");
const { allowSocket, allowedHost, fromAnotherSite, refuseHost, refuseRequest } = await import("../server/crosssite");
const { gateConnections, peerGate, plainAddress } = await import("../server/peers");
const { certificateSource, issueCertificate, pem, publicKeyId, tlsSettings } = await import("../server/tls");
const { isGitHubApi } = await import("../server/tools");
const { addressFor } = await import("../server/browser");
const logs = await import("../server/logs");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log("security");

await test("a request another website started cannot change anything", () => {
  assert.equal(refuseRequest("POST", { "sec-fetch-site": "same-origin" }), null);
  assert.equal(refuseRequest("POST", { "sec-fetch-site": "none" }), null);
  // The relay, curl and old browsers send no header at all.
  assert.equal(refuseRequest("POST", {}), null);
  assert.match(refuseRequest("POST", { "sec-fetch-site": "cross-site" }) ?? "", /another website/);
  // Another app on the same host is another site too.
  assert.ok(refuseRequest("DELETE", { "sec-fetch-site": "same-site" }));
  assert.ok(refuseRequest("PATCH", { "sec-fetch-site": "Cross-Site" }));
  // Reading is left alone: links from elsewhere, and the widget frame's script.
  assert.equal(refuseRequest("GET", { "sec-fetch-site": "cross-site" }), null);
  assert.equal(refuseRequest("HEAD", { "sec-fetch-site": "cross-site" }), null);
});

await test("a websocket from another website is refused, the relay is not", () => {
  assert.equal(allowSocket({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(allowSocket({}), true);
  assert.equal(allowSocket({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(fromAnotherSite({ "sec-fetch-site": "same-site" }), true);
});

await test("a request under a name a rebinding page could use is refused", () => {
  for (const ok of [undefined, "", "localhost:8817", "127.0.0.1:8817", "[::1]:8817", "192.168.1.20:8817", "umbrel.local",
    "umbrel:8817", "blofstedt-autora_app_1:8817", "box.tail1234.ts.net:8443", "nas.lan", "app.localhost", "Umbrel.Local."]) {
    assert.equal(allowedHost(ok, ""), true, String(ok));
  }
  for (const bad of ["evil.example", "evil.example:8817", "127.0.0.1.nip.io", "rebind.attacker.com"]) {
    assert.equal(allowedHost(bad, ""), false, bad);
  }
  // A domain of the person's own, named in AUTORA_ALLOWED_HOSTS.
  assert.equal(allowedHost("autora.example.com", "autora.example.com"), true);
  assert.equal(allowedHost("a.example.com", " .example.com "), true);
  assert.equal(allowedHost("example.com", ".example.com"), true);
  assert.equal(allowedHost("notexample.com", ".example.com"), false);
  assert.equal(allowedHost("anything.example", "*"), true);
  assert.match(refuseHost("evil.example") ?? "", /AUTORA_ALLOWED_HOSTS/);
});

await test("only the named peers reach either port, loopback always", async () => {
  assert.equal(peerGate("", () => undefined), null, "nothing configured: no gate");
  assert.equal(plainAddress("::ffff:172.18.0.5"), "172.18.0.5");
  let proxy = ["172.18.0.5"];
  const said: string[] = [];
  let clock = 0;
  const gate = peerGate("proxy", (l) => said.push(l), async () => proxy, () => clock,
    async (address) => address === "172.18.0.9" ? ["cloudflared_connector_1.umbrel_main_network"] : [])!;
  assert.equal(await gate.allows("::ffff:172.18.0.5"), true);
  assert.equal(await gate.allows("127.0.0.1"), true);
  assert.equal(await gate.allows("::1"), true);
  assert.equal(await gate.allows("172.18.0.9"), false, "another app on the network");
  assert.equal(await gate.allows("172.18.0.9"), false);
  // The proxy recreated on a new address: looked up again when it knocks.
  proxy = ["172.18.0.7"];
  clock += 10_000;
  assert.equal(await gate.allows("172.18.0.7"), true);
  assert.equal(await gate.allows("172.18.0.5"), false);
  await new Promise((resolve) => setImmediate(resolve));
  const refusals = said.filter((line) => line.includes("172.18.0.9"));
  assert.equal(refusals.length, 1, "a refused peer is logged once a minute, not per connection");
  assert.match(refusals[0], /\(cloudflared_connector_1\) refused: .*\(proxy\); add cloudflared_connector_1/,
    "the log names the container to trust");
});

await test("unresolved peers fail closed and recover without losing loopback or literal trust", async () => {
  let clock = 0;
  let found: string[] | null = null;
  const said: string[] = [];
  const gate = peerGate("cloudflared", (line) => said.push(line), async () => {
    if (found === null) throw new Error("ENOTFOUND");
    return found;
  }, () => clock)!;
  assert.equal(await gate.allows("10.0.0.1"), false);
  assert.equal(await gate.allows("10.0.0.2"), false);
  assert.equal(await gate.allows(undefined), false);
  assert.equal(await gate.allows("127.0.0.1"), true);
  assert.equal(await gate.allows("::ffff:127.0.0.1"), true);
  assert.equal(await gate.allows("::1"), true);
  clock += 10_000;
  assert.equal(await gate.allows("10.0.0.1"), false, "a repeated failure stays closed");
  found = [];
  clock += 10_000;
  assert.equal(await gate.allows("10.0.0.1"), false, "empty DNS results stay closed");
  found = ["10.0.0.1"];
  clock += 10_000;
  assert.equal(await gate.allows("::ffff:10.0.0.1"), true, "the tunnel recovers once resolved");
  found = null;
  clock += 70_000;
  assert.equal(await gate.allows("10.0.0.1"), true, "retain last-known-good trust during an outage");
  assert.equal(await gate.allows("10.0.0.2"), false);
  assert.ok(said.some((line) => line.includes("ENOTFOUND")));
  assert.ok(said.some((line) => line.includes("no addresses")));
  const literal = peerGate("10.0.0.3, unavailable", (line) => said.push(line),
    async () => { throw new Error("ENOTFOUND"); })!;
  assert.equal(await literal.allows("::ffff:10.0.0.3"), true);
  assert.equal(await literal.allows("10.0.0.4"), false);
});

await test("HTTP and HTTPS gate requests and upgrades before any handler sees them", async () => {
  const source = certificateSource(tlsSettings(3000, { AUTORA_TLS: "1" }), path.join(dir, "gate-tls"));
  for (const encrypted of [false, true]) {
    let allow = false;
    let fail = false;
    let handled = 0;
    const said: string[] = [];
    const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      handled += 1;
      res.end("allowed");
    };
    const server = encrypted ? https.createServer(source.options, handler) : http.createServer(handler);
    server.on("upgrade", (_req, socket) => {
      handled += 1;
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
    });
    assert.equal(gateConnections(server, null, (line) => said.push(line)), server, "standalone listener is unchanged");
    const listener = gateConnections(server, { allows: async (address) => {
      assert.equal(plainAddress(address), "127.0.0.1", "check the socket peer, not forwarded client IP");
      if (fail) throw new Error("lookup failed");
      return allow;
    } }, (line) => said.push(line));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as AddressInfo;
    const request = (upgrade: boolean) => new Promise<number>((resolve, reject) => {
      const req = (encrypted ? https : http).request({
        host: "127.0.0.1", port, agent: false, ca: source.caPem!,
        headers: { "CF-Connecting-IP": "203.0.113.1", "X-Forwarded-For": "203.0.113.1",
          ...(upgrade ? { Connection: "Upgrade", Upgrade: "test" } : {}) },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.setTimeout(2_000, () => req.destroy(new Error("request timed out")));
      req.end();
    });
    try {
      await assert.rejects(request(false), { code: "ECONNRESET" });
      await assert.rejects(request(true), { code: "ECONNRESET" });
      assert.equal(handled, 0);
      allow = true;
      assert.equal(await request(false), 200);
      assert.equal(await request(true), 101);
      assert.equal(handled, 2, "a trusted connector still reaches both request types");
      fail = true;
      await assert.rejects(request(false), { code: "ECONNRESET" });
      assert.equal(handled, 2);
      assert.ok(said.some((line) => line.includes("lookup failed")));
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    }
  }
});

await test("localhost HTTP and HTTPS still work with no gate or an unresolved configured proxy", async () => {
  const source = certificateSource(tlsSettings(3000, { AUTORA_TLS: "1" }), path.join(dir, "localhost-tls"));
  for (const encrypted of [false, true]) {
    for (const configured of [false, true]) {
      const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("localhost");
      const server = encrypted ? https.createServer(source.options, handler) : http.createServer(handler);
      const gate = configured ? peerGate("unresolved", () => undefined,
        async () => { throw new Error("ENOTFOUND"); }) : null;
      const listener = gateConnections(server, gate, () => undefined);
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const { port } = listener.address() as AddressInfo;
      try {
        const body = await new Promise<string>((resolve, reject) => {
          const req = (encrypted ? https : http).get({
            host: "127.0.0.1", port, ca: source.caPem!, agent: false,
          }, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve(body));
          });
          req.on("error", reject);
          req.setTimeout(2_000, () => req.destroy(new Error("request timed out")));
        });
        assert.equal(body, "localhost");
      } finally {
        await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
      }
    }
  }
});

await test("an unreadable settings file is kept aside, not overwritten", () => {
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.unreadable-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "{ this is not json");
  // And the app came up on defaults.
  assert.equal(stateMod.state.provider, "auto");
});

await test("a waiting save is written by flushState, not lost with the process", () => {
  stateMod.setKey("openai", "sk-saved-in-app-1234567890");
  // save() is debounced; nothing is on disk until the timer or a flush.
  stateMod.flushState();
  const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(written.keys.openai, "sk-saved-in-app-1234567890");
});

await test("provider keys from the environment are blanked, not only three of them", () => {
  const out = stateMod.redactSecrets(
    "DEEPSEEK_API_KEY=sk-deepseek-env-0123456789\nOPENROUTER_API_KEY=sk-or-v1-abcdefabcdef\n" +
    "DEEPGRAM_API_KEY=dg-secret-key-99887766\nOPENAI=sk-saved-in-app-1234567890",
  );
  assert.ok(!out.includes("sk-deepseek-env-0123456789"), out);
  assert.ok(!out.includes("sk-or-v1-abcdefabcdef"), out);
  assert.ok(!out.includes("dg-secret-key-99887766"), out);
  assert.ok(!out.includes("sk-saved-in-app-1234567890"), out);
  assert.match(out, /\[REDACTED_DEEPSEEK_API_KEY\]/);
  assert.match(out, /\[REDACTED_OPENAI_KEY\]/);
});

await test("a secret containing another is blanked whole, and changes apply at once", () => {
  stateMod.setSecret("SHORT_TOKEN", "abcd1234");
  stateMod.setSecret("LONG_TOKEN", "abcd1234-and-more");
  assert.equal(stateMod.redactSecrets("x abcd1234-and-more y"), "x [REDACTED_LONG_TOKEN] y");
  assert.equal(stateMod.redactSecrets("x abcd1234 y"), "x [REDACTED_SHORT_TOKEN] y");
  // Special characters in a secret are matched literally.
  stateMod.setSecret("ODD_TOKEN", "a.b*c(d)+e?");
  assert.equal(stateMod.redactSecrets("[a.b*c(d)+e?]"), "[[REDACTED_ODD_TOKEN]]");
  assert.equal(stateMod.redactSecrets("aXb*c(d)+e?"), "aXb*c(d)+e?");
  stateMod.deleteSecret("ODD_TOKEN");
  assert.equal(stateMod.redactSecrets("a.b*c(d)+e?"), "a.b*c(d)+e?");
});

await test("the Logs page blanks secrets too, and a redactor that logs cannot recurse", () => {
  logs.setLogRedactor((text) => {
    console.warn("[test] redacting");
    return stateMod.redactSecrets(text);
  });
  logs.log("info", "test", "token is sk-deepseek-env-0123456789");
  const lines = logs.readLogs({ component: "test" }).lines;
  const last = lines[lines.length - 1];
  assert.equal(last.message, "token is [REDACTED_DEEPSEEK_API_KEY]");
  logs.setLogRedactor(null);
});

await test("the GitHub token goes only to GitHub's API", () => {
  assert.equal(isGitHubApi("https://api.github.com/repos/a/b"), true);
  assert.equal(isGitHubApi("https://API.GitHub.com/user"), true);
  assert.equal(isGitHubApi("https://evil.example/?u=api.github.com"), false);
  assert.equal(isGitHubApi("https://api.github.com.evil.example/"), false);
  assert.equal(isGitHubApi("https://evil.example/api.github.com/"), false);
  assert.equal(isGitHubApi("http://api.github.com/"), false);
  assert.equal(isGitHubApi("not a url"), false);
});

await test("addresses without a scheme open, over http when they are local", () => {
  assert.equal(addressFor("localhost:3000"), "http://localhost:3000");
  assert.equal(addressFor("umbrel.local:8817/app"), "http://umbrel.local:8817/app");
  assert.equal(addressFor("192.168.1.5:8080"), "http://192.168.1.5:8080");
  assert.equal(addressFor("10.0.0.2"), "http://10.0.0.2");
  assert.equal(addressFor("[::1]:5173"), "http://[::1]:5173");
  assert.equal(addressFor("intranet/wiki"), "http://intranet/wiki");
  assert.equal(addressFor("example.com"), "https://example.com");
  assert.equal(addressFor("github.com:443/x"), "https://github.com:443/x");
  assert.equal(addressFor("https://example.com"), "https://example.com");
  assert.equal(addressFor("http://localhost"), "http://localhost");
  assert.equal(addressFor("about:blank"), "about:blank");
  assert.equal(addressFor("file:///tmp/x.html"), "file:///tmp/x.html");
});

await test("https is off unless asked, on the next port up by default", () => {
  assert.equal(tlsSettings(8817, {}).enabled, false);
  const on = tlsSettings(8817, { AUTORA_TLS: "1" });
  assert.equal(on.enabled, true);
  assert.equal(on.port, 8818);
  assert.equal(tlsSettings(3000, { AUTORA_TLS: "true", AUTORA_TLS_PORT: "4443" }).port, 4443);
  assert.equal(tlsSettings(3000, { AUTORA_TLS: "0" }).enabled, false);
  assert.deepEqual(tlsSettings(3000, { AUTORA_TLS_NAMES: "box.lan, 192.168.1.9" }).names, ["box.lan", "192.168.1.9"]);
});

await test("a certificate Autora issues is one Node's own X.509 parser accepts", () => {
  const ca = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caCert = new crypto.X509Certificate(pem(issueCertificate({
    commonName: "Test authority", subjectKey: ca.publicKey, issuerKey: ca.privateKey, ca: true, days: 30,
  })));
  assert.equal(caCert.ca, true);
  assert.ok(caCert.verify(ca.publicKey));

  const leafKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leaf = new crypto.X509Certificate(pem(issueCertificate({
    commonName: "box.local", names: ["box.local", "127.0.0.1", "::1", "not a name!"],
    subjectKey: leafKey.publicKey, issuerKey: ca.privateKey,
    issuer: { commonName: "Test authority", keyId: publicKeyId(ca.publicKey) }, days: 397,
  })));
  assert.equal(leaf.ca, false);
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(leaf.checkIssued(caCert));
  assert.equal(leaf.checkHost("box.local"), "box.local");
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(leaf.checkIP("::1"), "::1");
  assert.equal(leaf.checkHost("other.local"), undefined);
  // Under Apple's 825-day ceiling.
  const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 86_400_000;
  assert.ok(days < 825, `valid for ${days} days`);
});

await test("the https listener hands each name its own trusted certificate", async () => {
  const tlsDir = path.join(dir, "tls");
  const source = certificateSource(tlsSettings(3000, { AUTORA_TLS: "1" }), tlsDir);
  assert.ok(source.caPem);
  // The authority is kept: a second start reuses it rather than making a new one.
  assert.equal(certificateSource(tlsSettings(3000, { AUTORA_TLS: "1" }), tlsDir).caPem, source.caPem);
  assert.equal((fs.statSync(path.join(tlsDir, "ca.key")).mode & 0o077), 0);

  const server = https.createServer(source.options, (_req, res) => res.end("secure"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = (servername: string | undefined) => new Promise<{ body: string; cert: crypto.X509Certificate }>((resolve, reject) => {
    const req = https.request({
      // A fresh connection each time, so the second handshake is its own.
      host: "127.0.0.1", port, path: "/", ca: source.caPem!, agent: false,
      ...(servername ? { servername, headers: { host: servername } } : {}),
    }, (res) => {
      const peer = (res.socket as import("node:tls").TLSSocket).getPeerX509Certificate();
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ body, cert: peer! }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    // By name: a leaf for exactly that name, verified against the authority.
    const named = await get("my-box.local");
    assert.equal(named.body, "secure");
    assert.equal(named.cert.checkHost("my-box.local"), "my-box.local");
    // By bare address: no name is sent, and the fallback names the address.
    const bare = await get(undefined);
    assert.equal(bare.body, "secure");
    assert.equal(bare.cert.checkIP("127.0.0.1"), "127.0.0.1");
  } finally {
    server.close();
  }
});

await test("a real certificate from files is used as given, with no authority offered", () => {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const certFile = path.join(dir, "real.crt");
  const keyFile = path.join(dir, "real.key");
  fs.writeFileSync(certFile, pem(issueCertificate({
    commonName: "real.example", subjectKey: key.publicKey, issuerKey: key.privateKey, days: 30,
  })));
  fs.writeFileSync(keyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }));
  const source = certificateSource(
    tlsSettings(3000, { AUTORA_TLS: "1", AUTORA_TLS_CERT: certFile, AUTORA_TLS_KEY: keyFile }),
    path.join(dir, "unused"),
  );
  assert.equal(source.caPem, null);
  assert.ok(source.options.cert);
  assert.throws(() => certificateSource(tlsSettings(3000, { AUTORA_TLS: "1", AUTORA_TLS_CERT: certFile }), dir));
});

console.log(`${passed} passed`);
