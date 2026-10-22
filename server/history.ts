/**
 * What the model is told of the session so far, read out of the event log: the conversation in the vendor-neutral
 * shape (historyFor) and a line per earlier tool call (pastToolCalls). Plain functions of the log, moved out of
 * server.ts so a change to what the model sees starts here.
 */
import { attachmentNote, attachmentRefs, notebookNote, notebookRefs, picturesFor, type AttachmentRef } from "./attach";
import { frameImage, latestFrame, liveViewNote } from "./liveview";
import type { ChatMessage } from "./llm";
import type { Session } from "./session-types";

/**
 * This session's conversation, in the vendor-neutral shape ./server/llm takes.
 *
 * Built from the event log rather than a second transcript kept alongside it,
 * so what the model sees is what the thread shows -- including the turn just
 * posted, which the caller has already emitted by the time we get here.
 *
 * Two details every vendor cares about: consecutive turns from the same
 * speaker are merged (streamed replies arrive as many `turn.agent.text`
 * deltas, and forty one-word model turns is not a conversation), and a history
 * may not open on the assistant, so any leading assistant turns are dropped --
 * unless earlier turns were folded into the anchored memory, in which case the
 * context engine opens the history with a line saying so instead.
 *
 * Events at or below `sinceSeq` have already been folded into that memory and
 * are left out. Each message carries the highest seq it was built from, which
 * is how the engine knows, later, what a fold has covered.
 */
export function historyFor(session: Session, sinceSeq = 0): { message: ChatMessage; seq: number }[] {
  const turns: { message: ChatMessage; seq: number }[] = [];
  /* What each user turn came with, by the seq that turn ended on. The bytes
     are read only for the turn about to be answered (below), never for the
     ones already in the history. */
  const attached = new Map<number, AttachmentRef[]>();

  for (const event of session.events) {
    if (event.seq <= sinceSeq) continue;
    let role: "user" | "assistant" | null = null;
    if (event.kind === "turn.user" || event.kind === "turn.amend") role = "user";
    else if (event.kind === "agent.remark") role = "assistant";
    else if (event.kind === "turn.agent.text") {
      /* Text this server composed -- the no-model notice, the seeded opening
         turn -- is not something a model said, and must not come back as if
         it were. Replaying it is how a perfectly live provider ends up
         insisting no provider is connected: it reads its own canned notice
         in the history, takes it for its own earlier words, and stays
         consistent with it. */
      if (event.payload?.local) continue;
      role = "assistant";
    }
    let note = "";
    if (event.kind === "media.widget.error") {
      /* Said to the agent as the person's side of the conversation: it
         happened in their browser, after the widget was shown. */
      role = "user";
      note = `[Autora: the widget "${event.payload?.title}" you made threw an error in the person's browser: ${
        event.payload?.error}.${event.payload?.artifact
          ? ` Its source is artifact ${event.payload.artifact} (artifact_read); fix it and show the corrected widget with widget_show.`
          : ""}]`;
    }
    if (!role) continue;

    const said = String(event.payload?.text ?? "");
    const files = role === "user" ? attachmentRefs(event.payload?.attachments) : [];
    if (role === "user" && files.length > 0) attached.set(event.seq, files);
    const books = role === "user" ? notebookRefs(event.payload?.notebooks, true) : [];
    /* The note goes after what they said, as a second paragraph: it is a fact
       about the message, not a continuation of the sentence. */
    const text = note
      || [said, files.length > 0 ? attachmentNote(files) : "", notebookNote(books)].filter(Boolean).join("\n\n");
    if (!text) continue;

    const last = turns[turns.length - 1];
    if (last && last.message.role === role) {
      /* Assistant text arrives as stream deltas -- one event per fragment of
         a single reply -- so those join edge to edge. Two user turns running
         together are two separate things somebody typed, which happens
         whenever what sat between them was console text rather than the
         model's, and they need the break: Anthropic rejects consecutive
         same-role messages, so they cannot simply be kept apart. */
      last.message.text += role === "user" ? `\n\n${text}` : text;
      last.seq = event.seq;
    } else {
      turns.push({ message: { role, text }, seq: event.seq });
    }
  }

  /* The pictures of the message being answered, and only that one: they go as
     pictures for this turn and are left to the note afterwards, so a
     photograph already looked at is not uploaded again on every turn. */
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].message.role !== "user") continue;
    const pictures = picturesFor(attached.get(turns[i].seq) ?? []);
    /* And the camera, when live view is on: the newest frame the person's
       device sent goes to the turn being answered, so what they say out loud
       arrives with what they are looking at. It is a stream rather than a
       file, and the note says so -- and it is only ever the newest one,
       because the rest were never kept. */
    const live = latestFrame(session.id);
    if (live) {
      const image = frameImage(live);
      if (image) pictures.push(image);
      turns[i].message.text += `\n\n${liveViewNote(live)}`;
    }
    if (pictures.length > 0) turns[i].message.images = pictures;
    break;
  }

  if (sinceSeq === 0) {
    while (turns.length > 0 && turns[0].message.role === "assistant") turns.shift();
  }
  return turns;
}

/** How many past tool calls to recap. Enough to cover the work behind a
    follow-up question, bounded so a long session does not push the whole
    prompt out on the digest alone. */
const RECAP_CALLS = 30;

/**
 * What the agent did earlier in this session, read back out of the log.
 *
 * One line per call: the tool, the essential argument, and how it turned out.
 * Paired by span, which is how the log already ties a call to its result --
 * the same relation the transcript is built from, so this cannot describe a
 * call the person cannot also see.
 */
export function pastToolCalls(session: Pick<Session, "events"> | undefined, sinceSeq = 0): string[] {
  if (!session) return [];

  const calls = new Map<string, { name: string; args: any; outcome: string; stored?: string }>();
  for (const event of session.events) {
    if (!event.span || event.seq <= sinceSeq) continue;
    if (event.kind === "tool.call") {
      calls.set(event.span, {
        name: String(event.payload?.name ?? "tool"),
        args: event.payload?.args ?? {},
        outcome: "did not finish",
      });
      continue;
    }
    const found = calls.get(event.span);
    if (!found) continue;
    if (event.kind === "tool.stored") {
      found.stored = `full output in vault ${event.payload?.id} (${Number(event.payload?.lines ?? 0).toLocaleString("en-US")} lines; vault_read it)`;
    } else if (event.kind === "tool.result") {
      const code = event.payload?.display?.exit_code;
      const preview = String(event.payload?.preview ?? "").trim();
      /* How a failure failed, not only that it did: "exit 1" told the look
         back after the turn (and the next turn) nothing about what to do
         differently. A command's preview is its last line of output, which
         for a failure is nearly always the error. */
      const why = preview && preview !== `exit ${code}` ? ` -- ${preview.slice(0, 100)}` : "";
      found.outcome =
        code !== undefined
          ? `exit ${code}${code !== 0 ? why : ""}`
          : event.payload?.ok === false
            ? `failed${why}`
            : `ok${preview ? ` -- ${preview.slice(0, 80)}` : ""}`;
    } else if (event.kind === "tool.error") {
      found.outcome = event.payload?.denied
        ? "declined by the person"
        : `failed: ${String(event.payload?.error ?? "unknown").slice(0, 80)}`;
    }
  }

  const essential = (name: string, args: any): string => {
    if (name === "terminal") return String(args.command ?? "");
    if (name === "browser_open") return String(args.url ?? "");
    if (name === "memory_write") return String(args.title ?? "");
    if (name === "memory_search") return String(args.query ?? "");
    const keys = Object.keys(args ?? {});
    return keys.length > 0 ? JSON.stringify(args).slice(0, 80) : "";
  };

  return [...calls.values()]
    .slice(-RECAP_CALLS)
    .map((c) => {
      const what = essential(c.name, c.args);
      return `- ${c.name}${what ? ` (${what})` : ""} -> ${c.outcome}${c.stored ? ` [${c.stored}]` : ""}`;
    });
}
