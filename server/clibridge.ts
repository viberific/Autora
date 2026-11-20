/**
 * The way back in for a subscription CLI: Autora's own tools, called by Claude Code or Gemini while it answers a chat.
 *
 * A CLI has its own hands (files, a shell) and none of Autora's: it could not open a document, put a piece on the board or drive
 * the app preview. For the length of one turn, the turn opens a bridge here; the CLI starts server/delegates/autora-mcp.mjs as an
 * MCP server, and that passes the tool list and each call to POST /api/cli-bridge with the turn's token. The turn's own executor
 * runs the call -- the planning refusal, the person's holds, Ask mode, the events, the windows -- so a call made this way is the
 * agent's call in every respect but who chose it.
 *
 * The token is 32 random bytes, good for one turn, checked by its hash, and closed when the turn's model call ends. Requests
 * come from a process on this host with no browser behind it; crosssite.ts already refuses any a web page starts.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeResult {
  ok: boolean;
  text: string;
  images?: { mime: string; data: string }[];
}

interface Bridge {
  list: () => BridgeTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<BridgeResult>;
}

const open = new Map<string, Bridge>();

const keyOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Open a bridge for one turn. `close` ends it: a call with its token after that is refused. */
export function openBridge(bridge: Bridge): { token: string; close: () => void } {
  const token = crypto.randomBytes(32).toString("base64url");
  const key = keyOf(token);
  open.set(key, bridge);
  return { token, close: () => { open.delete(key); } };
}

/** The address a CLI on this host reaches the bridge at: plain HTTP on the app's own port, on loopback where it listens there. */
export function bridgeUrl(port: number, host: string): string {
  const wildcard = !host || host === "0.0.0.0" || host === "::" || host === "localhost";
  const where = wildcard ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${where}:${port}/api/cli-bridge`;
}

/** What the CLI is handed for one tool result: the text, and any picture, as MCP content. */
function contentOf(result: BridgeResult): { type: string; text?: string; data?: string; mimeType?: string }[] {
  const out: { type: string; text?: string; data?: string; mimeType?: string }[] = [{ type: "text", text: result.text || (result.ok ? "Done." : "It did not work.") }];
  for (const image of result.images ?? []) out.push({ type: "image", data: image.data, mimeType: image.mime });
  return out;
}

export function bridgeRoutes(app: Express): void {
  app.post("/api/cli-bridge", async (req: Request, res: Response) => {
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const bridge = token ? open.get(keyOf(token)) : undefined;
    if (!bridge) return res.status(401).json({ detail: "This bridge is closed: its turn has ended." });
    const op = req.body?.op;
    if (op === "list") return res.json({ tools: bridge.list() });
    if (op === "call") {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const args = req.body?.arguments && typeof req.body.arguments === "object" && !Array.isArray(req.body.arguments) ? req.body.arguments : {};
      if (!name) return res.status(400).json({ detail: "Say which tool." });
      try {
        const result = await bridge.call(name, args);
        return res.json({ content: contentOf(result), isError: !result.ok });
      } catch (err: any) {
        return res.json({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
      }
    }
    return res.status(400).json({ detail: "Ask for the list, or make a call." });
  });
}
