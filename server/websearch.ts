/**
 * Web search in the order the person asked for: 4get, then Webclaw, then the
 * built-in key-based search. The browser is deliberately not a tier -- it is
 * driven only when the person asks for it, or asks to see a page themselves.
 *
 * The tiers are handed in rather than imported so that the order, the
 * give-up rules and the "which one answered" reporting can be tested without
 * a network or a running MCP server.
 */

export interface SearchToolRef {
  /** The name the agent sees, e.g. mcp__4get__search. */
  name: string;
  /** The server it belongs to, e.g. 4get. */
  server: string;
  /** The name the server knows it by, e.g. search. */
  remote: string;
}

export interface SearchDeps {
  /** The MCP tools connected right now. */
  tools: () => SearchToolRef[];
  /** Run one MCP tool. */
  call: (name: string, args: Record<string, any>) => Promise<{ ok: boolean; text: string }>;
  /** The key-based search Autora had before any MCP server: Tavily, Brave, DuckDuckGo. */
  builtin: (query: string) => Promise<string>;
}

/** Preferred order. A server that is not connected is skipped, not retried. */
export const SEARCH_TIERS = ["4get", "webclaw"] as const;

/** What a bot wall or a throttle says. Never a page of real results. */
const BLOCKED = /captcha|just a moment|are you a robot|verify you are human|access denied|rate limit|too many requests|forbidden|unusual traffic|cloudflare/i;

/**
 * Whether a tier answered without really answering: nothing, a stub, or a bot
 * wall. Long text is trusted even when it mentions a CAPTCHA -- pages about
 * CAPTCHAs are real results -- so the wall check only applies to a short
 * answer, which is what a wall returns.
 */
export function resultsUnusable(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length === 0 || t === "(no output)") return true;
  if (t.length < 40) return true;
  return t.length < 1200 && BLOCKED.test(t);
}

export interface SearchOutcome {
  ok: boolean;
  /** The tier that answered: 4get, webclaw, or built-in. */
  tier: string;
  text: string;
  /** Every tier that was tried and why it did not answer, in order. */
  tried: string[];
}

function searchToolFor(server: string, tools: SearchToolRef[]): SearchToolRef | undefined {
  const want = server.toLowerCase();
  return tools.find((t) => /search/i.test(t.remote)
    && (t.server.toLowerCase() === want || t.name.toLowerCase().includes(`__${want}__`)));
}

export async function searchInTiers(query: string, deps: SearchDeps): Promise<SearchOutcome> {
  const tried: string[] = [];
  const tools = deps.tools();
  for (const server of SEARCH_TIERS) {
    const tool = searchToolFor(server, tools);
    if (!tool) {
      tried.push(`${server}: not connected`);
      continue;
    }
    let text = "";
    try {
      const result = await deps.call(tool.name, { query });
      text = result.text ?? "";
      if (!result.ok) {
        tried.push(`${server}: errored`);
        continue;
      }
    } catch {
      tried.push(`${server}: errored`);
      continue;
    }
    if (resultsUnusable(text)) {
      tried.push(`${server}: no usable results`);
      continue;
    }
    return { ok: true, tier: server, text, tried };
  }

  try {
    const text = await deps.builtin(query);
    if (!resultsUnusable(text)) return { ok: true, tier: "built-in", text, tried };
    tried.push("built-in: no usable results");
  } catch {
    tried.push("built-in: errored");
  }
  return { ok: false, tier: "", text: "", tried };
}
