/**
 * The hosted editors that follow one convention: a per-chat state the window shows, a notification when it changes, a
 * briefing the model reads, and something to forget when the chat goes. Each used to be named by hand in three places
 * (server.ts's change handlers and forgetSession, tools.ts's capability briefing); a desk listed here is wired in all of them.
 *
 * Only the four whose shape is identical are here (3D, Games, Photo, Music). PDF, Office and Video differ (their state is a
 * file, or their window owns the model) and join when they fit the same interface; see docs/ENGINE-SURVEY.md and
 * intent/2026-11-04-one-adaptive-engine.md.
 */
import { cadAvailable, cadBriefing, cadState, dropCad, onCadChange } from "./caddesk";
import { dropGame, gameAvailable, gameBriefing, gameState, onGameChange } from "./gamedesk";
import { dropPhoto, onPhotoChange, photoAvailable, photoBriefing, photoState } from "./photodesk";
import { dropStudio, onStudioChange, studioBriefing, studioState } from "./studio";

interface Desk {
  id: "cad" | "game" | "photo" | "studio";
  /** The websocket message type that carries this window's state to the page. */
  message: string;
  /** Whether this server has the editor built in (a server without it says nothing about it). */
  available(): boolean;
  state(session: string): unknown;
  onChange(fn: (session: string) => void): void;
  drop(session: string): void;
  /** The line of the capability briefing; `enabled` is the Tools page switch. */
  briefing(enabled: boolean): string;
}

export const DESKS: Desk[] = [
  { id: "studio", message: "studiodesk", available: () => true, state: studioState, onChange: onStudioChange, drop: dropStudio, briefing: studioBriefing },
  { id: "cad", message: "caddesk", available: cadAvailable, state: cadState, onChange: onCadChange, drop: dropCad, briefing: cadBriefing },
  { id: "game", message: "gamedesk", available: gameAvailable, state: gameState, onChange: onGameChange, drop: dropGame, briefing: gameBriefing },
  { id: "photo", message: "photodesk", available: photoAvailable, state: photoState, onChange: onPhotoChange, drop: dropPhoto, briefing: photoBriefing },
];
