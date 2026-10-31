import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");
const apps = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "umbrel-app.yml")))
  .map((entry) => entry.name).sort();

assert.deepEqual(apps, ["blofstedt-autora", "blofstedt-flix"], "the store packages Autora and Flix");
assert.match(read("umbrel-app-store.yml"), /^id: "blofstedt"$/m, "keep the existing store identity");
const manifest = read("blofstedt-autora", "umbrel-app.yml");
assert.match(manifest, /^id: blofstedt-autora$/m, "keep the existing install identity");
for (const field of ["developer", "submitter"]) {
  assert.match(manifest, new RegExp(`^${field}: viberific$`, "m"));
}
for (const field of ["website", "submission", "repo", "support"]) {
  assert.match(manifest, new RegExp(`^${field}: https://github\\.com/viberific/Autora${field === "support" ? "/issues" : ""}$`, "m"));
}
const compose = read("blofstedt-autora", "docker-compose.yml");
assert.match(compose, /^\s+APP_HOST: blofstedt-autora_app_1$/m);
assert.match(compose, /^\s+AUTORA_TRUSTED_PEERS: "blofstedt-autora_app_proxy_1,cloudflared_connector_1"$/m);
assert.match(compose, /^\s+AUTORA_ALLOWED_HOSTS: "autora\.049993\.xyz"$/m, "the Cloudflare tunnel's public hostname");
assert.match(compose, /^\s+image: ghcr\.io\/viberific\/autora:/m);
assert.match(compose, /^\s+- "8818:8818"$/m, "keep the HTTPS origin port stable for configured tunnels");
assert.match(compose, /^\s+AUTORA_TLS: "0"$/m);
const server = read("server.ts");
assert.match(server, /gateConnections\(server, gate, peerLog\)\.listen\(PORT, HOST, listening\)/);
assert.match(server, /gateConnections\(secureServer, gate, peerLog\)\.listen\(secure\.port, HOST,/);
assert.doesNotMatch(server, /secureServer\.listen\(/, "HTTPS must not bypass the shared gate");
assert.match(manifest, /^icon: https:\/\/raw\.githubusercontent\.com\/viberific\/Autora\/main\/blofstedt-autora\/icon\.svg$/m);
assert.ok(fs.existsSync(path.join(root, "blofstedt-autora", "icon.svg")));
for (const file of [".github/scripts/check_flix_store.py", ".github/workflows/flix-store-check.yml"]) {
  assert.equal(fs.existsSync(path.join(root, file)), false, "unrelated store checks must not remain");
}
assert.doesNotMatch(read("README.md"), /github\.com\/blofstedt\//i);
assert.doesNotMatch(read("scripts", "build-gdevelop-editor.mjs"), /github\.com\/blofstedt\/Autora/i);
const source = JSON.parse(read("autora-3d", "SOURCE.json")) as { repo: string; commit: string };
assert.equal(source.repo, "3D-Modeling", "source metadata names the project, not a personal account");
assert.match(source.commit, /^[0-9a-f]{40}$/, "preserve the source commit");
assert.doesNotMatch(read("scripts", "sync-autora-3d.mjs"), /blofstedt/i);
console.log("Autora packaging: current branding, one app, existing Umbrel identity preserved");
