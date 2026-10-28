/**
 * A project's notebook: the context every chat in a project folder leaves behind, kept where the next chat can read it.
 *
 * A project folder on the Artifacts page (server/folders.ts) holds the files its chats made. This gives it a notebook
 * too, made the first time one of its chats finishes a turn: one note per chat, headed with the chat's name, that keeps a
 * short line per turn (what was asked, what came of it, the files it made). Pulling the folder into any chat (the
 * composer's Artifacts button) brings the notebook with its files, so the work carries on with what was decided before.
 *
 * Nothing is asked of a model: the lines are the request and the start of the reply, trimmed. An incognito chat
 * leaves nothing.
 */
import { folderNote, folderNotebook, folderOfChat, getFolder, setFolderNote, setFolderNotebook } from "./folders";
import { addEntries, createNotebook, getNotebook, updateEntry, type Notebook } from "./notebooks";

/** Lines kept per chat: the newest. */
const KEEP_LINES = 14;

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The project's notebook, made the first time it is wanted. Null when the chat is in no project folder. */
export function projectNotebook(folderId: string): Notebook | null {
  const folder = getFolder(folderId);
  if (!folder) return null;
  const have = folderNotebook(folder.id);
  const book = have ? getNotebook(have) : null;
  if (book) return book;
  try {
    const made = createNotebook({
      title: `${folder.name}: project notes`,
      purpose: `What every chat in the ${folder.name} project did and decided, kept by Autora so the next chat can carry on.`,
      by: "agent",
    });
    setFolderNotebook(folder.id, made.id);
    return made;
  } catch {
    return null;
  }
}

/** A turn finished in a chat: if the chat is in a project, its line goes in the project's notebook. */
export function recordProjectTurn(chat: string, turn: { title: string; request: string; reply: string; files: string[]; scheduled?: boolean; at?: number }): void {
  const folder = folderOfChat(chat);
  if (!folder) return;
  const request = oneLine(turn.request, 160);
  const reply = oneLine(turn.reply, 220);
  if (!request && !reply) return;
  const book = projectNotebook(folder);
  if (!book) return;
  const day = new Date(turn.at ?? Date.now()).toISOString().slice(0, 10);
  const line = `- ${day}${turn.scheduled ? " (scheduled)" : ""}: ${request || "(no words)"}${reply ? ` → ${reply}` : ""}${turn.files.length ? ` [files: ${turn.files.slice(0, 6).join(", ")}]` : ""}`;
  const known = folderNote(folder, chat);
  const entry = known ? book.entries.find((e) => e.id === known && e.kind === "note") : undefined;
  try {
    if (entry) {
      const lines = (entry.text ?? "").split("\n").filter((l) => l.startsWith("- "));
      lines.push(line);
      updateEntry(book.id, entry.id, { title: `Chat: ${turn.title}`, text: lines.slice(-KEEP_LINES).join("\n") });
    } else {
      const { added } = addEntries(book.id, [{ title: `Chat: ${turn.title}`, text: line }], "agent");
      if (added[0]) setFolderNote(folder, chat, added[0].id);
    }
  } catch {
    // A full notebook keeps what it has; the project's files are still in its folder.
  }
}

/** The notebooks of these project folders, made if need be: what comes with a folder pulled into a chat. */
export function projectNotebookRefs(folders: string[]): Array<{ id: string; title: string }> {
  return folders.map((f) => projectNotebook(f)).filter((b): b is Notebook => b !== null).map((b) => ({ id: b.id, title: b.title }));
}
