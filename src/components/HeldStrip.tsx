import { holdSurface, useCollab } from "../lib/collab";
import { IconHand } from "./Icons";

const NAME: Record<string, string> = {
  browser: "the browser",
  pdf: "the PDF",
  office: "the document",
  app: "the app window",
  video: "the video",
  code: "the code",
};

/**
 * What the person has taken from the agent, said above the message box with the way to give it back.
 *
 * The Hand back button lived only on the window's own bar (on a phone, an unlabelled hand), and a browser card that was
 * no longer the newest had none at all: a page taken for a sign-in stayed the person's, and the agent called the
 * browser locked until Autora was restarted. This strip is on screen wherever the thread is scrolled to, for as long
 * as anything is held, and one tap hands it back.
 */
export function HeldStrip({ sessionId, live }: { sessionId: string; live: boolean }) {
  const { held } = useCollab();
  if (!live || held.length === 0) return null;
  const things = held.map((s) => NAME[s] ?? s);
  const what = things.length === 1 ? things[0] : `${things.slice(0, -1).join(", ")} and ${things[things.length - 1]}`;
  const giveBack = () => { for (const surface of held) void holdSurface(sessionId, surface, false); };
  return (
    <div className="held-strip" role="status">
      <span className="held-strip-ico" aria-hidden="true"><IconHand size={14} /></span>
      <span className="held-strip-text">
        <b>You have {what}.</b> The agent is leaving {held.length === 1 ? "it" : "them"} alone until you hand {held.length === 1 ? "it" : "them"} back.
      </span>
      <button type="button" className="held-strip-btn" onClick={giveBack} title={held.includes("browser") ? "The browser also comes back to the agent by itself once you have left it alone for a few minutes" : undefined}>Hand back to agent</button>
    </div>
  );
}
