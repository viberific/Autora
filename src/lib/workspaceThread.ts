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
