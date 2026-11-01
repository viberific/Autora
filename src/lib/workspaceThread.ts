import type { Cell } from "./derive";

/** Commands belong to the conversation, never to a separate workspace application. */
export const isWorkspaceCell = (cell: Cell): boolean =>
  cell.kind === "screen" || cell.kind === "images" || cell.kind === "files"
  || cell.kind === "widget" || cell.kind === "file" || cell.kind === "tool" || cell.kind === "app";

export function conversationCells(cells: readonly Cell[]): Cell[] {
  return cells.flatMap((cell) => cell.kind === "screen"
    ? conversationCells(cell.log)
    : isWorkspaceCell(cell) ? [] : [cell]);
}

/** A command nested under browser work still appears only in the conversation. */
export function workspaceCells(cells: readonly Cell[]): Cell[] {
  return cells.filter(isWorkspaceCell).map((cell) => cell.kind === "screen"
    ? { ...cell, log: cell.log.filter((entry) => entry.kind !== "terminal") }
    : cell);
}

/** The steps behind a conversation rather than part of it: a command, a tool, a memory pulse, a mode change, a note,
    an app opening. A phone's sheet leaves them out until it is nearly full (see ConversationFlow). */
export const isDetailCell = (cell: Cell): boolean =>
  cell.kind === "terminal" || cell.kind === "tool" || cell.kind === "memory" || cell.kind === "learned"
  || cell.kind === "mode" || cell.kind === "note" || cell.kind === "app";

/** How many of those the newest turn holds, including the memories its replies recalled. */
export function hiddenStepCount(cells: readonly Cell[]): number {
  let n = 0;
  for (const cell of cells) {
    if (cell.kind === "reply") n += cell.memories.length;
    else if (cell.kind === "screen") n += hiddenStepCount(cell.log);
    else if (isDetailCell(cell)) n += 1;
  }
  return n;
}
