/**
 * Who may connect to the plain port at all, when the deployment says.
 *
 * On Umbrel the login is the app proxy's, in a container of its own that
 * forwards to this one over Docker's network. But every app on the box is on
 * that network, and this container's port answers whoever reaches it: any
 * other app (or anything that compromises one) could talk to Autora directly,
 * past the login, and Autora runs commands as root with the host's whole
 * filesystem mounted. AUTORA_TRUSTED_PEERS names the containers that may
 * connect (comma-separated hostnames or addresses: on Umbrel, the app's own
 * proxy); every other peer is refused before a byte of HTTP is read. This
 * machine itself (loopback: the agent opening its own app) is always let in.
 *
 * Names are resolved through Docker's DNS and looked up again every minute,
 * and at once (at most every few seconds) when an unknown peer knocks, since
 * a recreated proxy comes back on a new address. While no name has ever
 * resolved the gate stays open and says so in the log, so a misspelt name
 * leaves the app as it was rather than locking everyone out.
 */
import dns from "node:dns/promises";
import net from "node:net";

const REFRESH_MS = 60_000;
const RETRY_MS = 5_000;

/** An address as Node reports it, with the IPv4-in-IPv6 prefix taken off. */
export function plainAddress(address: string | undefined): string {
  const a = String(address ?? "").toLowerCase();
  return a.startsWith("::ffff:") && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

interface PeerGate {
  /** Whether a connection from `address` may go ahead. */
  allows(address: string | undefined): Promise<boolean>;
  /** The addresses currently trusted (for tests and the log). */
  trusted(): Set<string>;
}

type Lookup = (name: string) => Promise<string[]>;

const lookupAll: Lookup = async (name) => (await dns.lookup(name, { all: true })).map((r) => r.address);

/** A gate for the names in `spec`, or null when none are configured. */
export function peerGate(
  spec: string | undefined,
  log: (line: string) => void = () => undefined,
  lookup: Lookup = lookupAll,
  now: () => number = Date.now,
): PeerGate | null {
  const names = String(spec ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;

  let addresses = new Set<string>();
  let everResolved = false;
  let lastTry = 0;
  let running: Promise<void> | null = null;
  let warnedOpen = false;

  const refresh = () => {
    running ??= (async () => {
      lastTry = now();
      const next = new Set<string>();
      for (const name of names) {
        if (net.isIP(name)) {
          next.add(plainAddress(name));
          continue;
        }
        try {
          for (const a of await lookup(name)) next.add(plainAddress(a));
        } catch {
          // Not up yet, or gone for a moment: the other names still count.
        }
      }
      if (next.size > 0) {
        everResolved = true;
        addresses = next;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  void refresh();

  return {
    trusted: () => addresses,
    async allows(raw) {
      const address = plainAddress(raw);
      if (isLoopback(address)) return true;
      // The first look-up, still under way at start, decides the first peers.
      if (running) await running;
      if (now() - lastTry > REFRESH_MS) await refresh();
      if (addresses.has(address)) return true;
      // An unknown peer: the proxy may have come back on a new address.
      if (now() - lastTry > RETRY_MS) {
        await refresh();
        if (addresses.has(address)) return true;
      }
      if (!everResolved) {
        if (!warnedOpen) {
          warnedOpen = true;
          log(`AUTORA_TRUSTED_PEERS (${names.join(", ")}) did not resolve; letting every peer in until it does`);
        }
        return true;
      }
      log(`connection from ${address} refused: not one of AUTORA_TRUSTED_PEERS`);
      return false;
    },
  };
}
