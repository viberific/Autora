/**
 * A chat turn answered by a subscription CLI instead of an API.
 *
 * The person's Google and Claude subscriptions are signed in on this host already, and the CLIs (Antigravity's `agy`, Claude
 * Code) are what those subscriptions cover. This runs one of them with the conversation as the prompt and streams back what it
 * says, so a chat can be had with a subscription -- no key, no per-token bill -- in place of an API that would be paid for.
 *
 * It is not the API and does not pretend to be one:
 *
 * - The history goes in as text (who said what), not as the vendor's own message objects. The CLI keeps no state between
 *   calls, so every turn is the whole conversation again.
 * - No tools. The CLI has its own, but their calls are not this app's tools, so a turn is text: reading, writing and running
 *   things stay with the delegate tools (claude_cli, gemini_cli) and with the agent.
 * - Nothing is billed. Usage is counted, with `estimated` set, so the ledger shows the tokens and prices none of them.
 *
 * The wrapper is the one the delegates use (server/delegates/, its stream contract in server/vendor.ts), so a failure arrives
 * with the same reasons a delegate's does and is raised as a ProviderError with the status that tells the caller whether
 * trying again is worth it.
 */

import { ProviderError, type ChatCall, type ChatTurn } from "./llm";
import { onPath, runVendor } from "./vendor";

/** One exchange as the CLI reads it. */
function line(message: ChatCall["messages"][number]): string {
  const who = message.role === "user" ? "Person" : message.role === "assistant" ? "Autora" : "Tool";
  return `${who}: ${message.text ?? ""}`.trim();
}

/** The whole conversation as one prompt: the CLI has no memory of the last call. */
function promptOf(call: ChatCall): string {
  const said = call.messages.filter((m) => (m.text ?? "").trim()).map(line);
  return [
    call.system.trim(),
    said.length ? `The conversation so far:\n\n${said.join("\n\n")}` : "",
    "Answer the person's last message. You are the one writing in their chat now: reply with the answer only, in their " +
      "language, and do not restate the conversation or introduce yourself.",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** The status a CLI failure is worth retrying at, or null for one that would fail again. */
function statusOf(reason: string): number | null {
  if (reason === "rate_limit") return 429;
  if (reason === "timeout") return 504;
  if (reason === "auth" || reason === "not_installed") return null;
  return 500;
}

export async function streamCli(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  /* The wrapper is the way to the CLI, not the CLI: with none behind it every turn would fail, so it is refused here rather
     than four times over by the retry. */
  const cli = call.provider === "claude-cli" ? "claude" : "agy";
  if (!onPath(cli)) {
    throw new ProviderError(
      `The ${cli} CLI is not installed on this host, so ${call.provider} cannot answer. Install it and sign in once.`,
      null,
    );
  }
  /* A turn is one answer, not a job: no file is edited under the person's feet by a chat message. The wrapper's own timeout
     is the backstop; the signal is the person pressing Stop. */
  const seconds = Math.round(Math.max(30_000, Number(process.env.AUTORA_CLI_TIMEOUT_MS) || 600_000) / 1000);
  const out = await runVendor({
    id: call.provider === "claude-cli" ? "claude" : "gemini",
    prompt: promptOf(call),
    cwd: process.env.AUTORA_CLI_CWD || "/data/work/agy-scratch",
    write: false,
    timeoutArg: `${seconds}s`,
    hardTimeoutMs: seconds * 1000 + 15_000,
    model: call.model || undefined,
    effort: call.effort || undefined,
    // The wrapper's own streaming contract is what makes the answer arrive as it is written.
    onDelta,
    onStatus: () => undefined,
    signal: call.signal,
  });
  if (!out.ok || !out.text.trim()) {
    throw new ProviderError(out.message || `${call.provider} stopped without an answer.`, statusOf(out.reason ?? "other"));
  }
  return {
    text: out.text.trim(),
    calls: [],
    // The CLI reports no token counts we can trust, and nothing here is billed: the turn is marked estimated.
    usage: { input: out.usage?.input_tokens ?? 0, output: out.usage?.output_tokens ?? 0, estimated: true },
  };
}
