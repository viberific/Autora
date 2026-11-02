/**
 * The document editors on screen, by surface id: where the agent's hand types (hand.ts), into the same editor the person
 * types into, so its words go in through the editor's own input rules and keys and are saved as typing.
 */
import type { EditorView } from "prosemirror-view";

export const docViews = new Map<string, EditorView>();
