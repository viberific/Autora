/**
 * Requests from other websites, refused.
 *
 * Autora has no login of its own -- on Umbrel the app proxy's login is in
 * front of it, and elsewhere it is whoever can reach the port -- and what it
 * can do is run commands on this machine. That makes the browser of the
 * person using it the thing to protect: while they have Autora open in one
 * tab, a page in another tab can still aim requests at Autora's address.
 * Most of those are already stopped by the browser (a JSON body needs a CORS
 * preflight this server never grants), but not all of them: a form post with
 * no body can still stop a turn, run a job or clear the spend ledger, and a
 * WebSocket is not covered by CORS at all -- a page anywhere could open
 * `/ws/<session>`, read the whole thread and approve a held command.
 *
 * Browsers say where a request came from in `Sec-Fetch-Site`, a header a page
 * cannot set or forge. Everything the app itself sends is `same-origin`; a
 * request typed into the address bar is `none`. Anything else changing state,
 * and any WebSocket from another site, is refused here.
 *
 * Deliberately fail-open when the header is missing: the desktop relay and
 * curl send none, and neither does an old browser. A proxy in front (Umbrel's,
 * `tailscale serve`, nginx) passes the header through untouched, so nothing
 * here depends on how the Host header was rewritten on the way in.
 */

import type { IncomingHttpHeaders } from "node:http";

/** Methods that only read. */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when the browser says the request was started by a page on another
    site -- including another app on the same host, which is "same-site". */
export function fromAnotherSite(headers: IncomingHttpHeaders): boolean {
  const site = String(headers["sec-fetch-site"] ?? "").trim().toLowerCase();
  return site === "cross-site" || site === "same-site";
}

/** Why an HTTP request is refused, or null to let it through. */
export function refuseRequest(method: string, headers: IncomingHttpHeaders): string | null {
  if (SAFE.has(method.toUpperCase())) return null;
  return fromAnotherSite(headers)
    ? "Refused: this request came from another website, not from Autora's own page."
    : null;
}

/** Whether a WebSocket upgrade may go ahead. */
export function allowSocket(headers: IncomingHttpHeaders): boolean {
  return !fromAnotherSite(headers);
}

/*
 * Names this app may be addressed by, against DNS rebinding.
 *
 * The check above trusts `Sec-Fetch-Site: same-origin`, and a rebinding page
 * gets exactly that: evil.example is loaded once, its DNS answer then switches
 * to 127.0.0.1 (or a tailnet or LAN address that reaches Autora), and from then
 * on its scripts talk to Autora as "same-origin" -- read every thread, start a
 * turn, run a command. What such a page cannot change is the name: the browser
 * still sends `Host: evil.example`. So a request is only served under a name
 * an attacker cannot point at this machine from the public internet: an
 * address, localhost, a single-label name (a Docker service, `umbrel`), a name
 * under a suffix public DNS never answers (`.local`, `.lan`, `.internal`,
 * `.home.arpa`) or a Tailscale name (`.ts.net`, whose DNS only Tailscale
 * answers). Anything else -- a real domain in front of a reverse proxy or a
 * tunnel -- is named in AUTORA_ALLOWED_HOSTS (comma-separated; `.example.com`
 * allows the domain and every name under it; `*` turns the check off).
 */

const PRIVATE_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa", ".ts.net"];

/** The hostname of a Host header, lower-case, without port or brackets. */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  // More than one colon and no brackets: a bare IPv6 address.
  if ((h.match(/:/g) ?? []).length > 1) return h;
  return h.replace(/:\d*$/, "").replace(/\.$/, "");
}

/** True for IPv4 dotted quads and anything with a colon (IPv6). */
function isAddress(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(":");
}

/** Whether a request addressed to `host` may be served. */
export function allowedHost(host: string | undefined, extra = process.env.AUTORA_ALLOWED_HOSTS ?? ""): boolean {
  // HTTP/1.0 and some tools send none; a browser always does.
  if (!host) return true;
  const name = hostnameOf(host);
  if (!name || isAddress(name) || name === "localhost" || !name.includes(".")) return true;
  if (PRIVATE_SUFFIXES.some((s) => name.endsWith(s))) return true;
  for (const raw of extra.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry.startsWith(".") ? name === entry.slice(1) || name.endsWith(entry) : name === entry) return true;
  }
  return false;
}

/** Why a request is refused for the name it was sent to, or null. */
export function refuseHost(host: string | undefined): string | null {
  if (allowedHost(host)) return null;
  return `Refused: Autora is not served under the name "${hostnameOf(String(host))}". ` +
    "If that is your own domain in front of Autora, add it to AUTORA_ALLOWED_HOSTS.";
}
