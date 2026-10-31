import { useEffect, useId, useRef, type ReactNode } from "react";
import "./ConversationFlow.css";

interface ConversationFlowProps {
  conversation: ReactNode;
  entry: ReactNode;
  todos?: ReactNode;
  workNavigation?: ReactNode;
  conversationLabel?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}

/** Hosts the live Thread and native composer without taking ownership of either. */
export function ConversationFlow({
  conversation,
  entry,
  todos,
  workNavigation,
  conversationLabel = "Conversation with Autora",
  collapsed = false,
  onToggle,
}: ConversationFlowProps) {
  const conversationId = useId();
  const historyRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    if (collapsed && history.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
  }, [collapsed]);

  useEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    let frame = 0;
    let messages: HTMLElement[] = [];
    let dirty = true;
    const faded = new Set<HTMLElement>();
    const update = () => {
      frame = 0;
      if (history.getAttribute("aria-hidden") !== "true") {
        history.style.setProperty("--flow-history-height", `${history.getBoundingClientRect().height}px`);
      }
      const thread = history.querySelector<HTMLElement>(".thread");
      if (!thread) return;
      if (dirty) {
        messages = Array.from(thread.querySelectorAll<HTMLElement>(".msg"));
        dirty = false;
      }
      const edge = thread.getBoundingClientRect().top;
      // Messages follow DOM order. Find the live top edge without measuring every old turn.
      let low = 0;
      let high = messages.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (messages[middle].getBoundingClientRect().bottom <= edge) low = middle + 1;
        else high = middle;
      }
      const next = new Set<HTMLElement>();
      for (let index = low; index < messages.length; index += 1) {
        const message = messages[index];
        const rect = message.getBoundingClientRect();
        if (rect.top >= edge + 36) break;
        // Fade only the bubble's top strip, never a long reply's entire visible body.
        // A focused control or fixed overlay stays unmasked, including its focus ring.
        if (message.contains(document.activeElement)
          || Array.from(message.querySelectorAll("*")).some((node) => getComputedStyle(node).position === "fixed")) continue;
        const start = edge - rect.top;
        message.style.setProperty("--flow-edge-mask", `linear-gradient(to bottom, transparent ${start}px, var(--text) ${start + 36}px)`);
        next.add(message);
      }
      for (const message of faded) {
        if (!next.has(message)) message.style.removeProperty("--flow-edge-mask");
      }
      faded.clear();
      for (const message of next) faded.add(message);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const mutation = new MutationObserver(() => {
      dirty = true;
      schedule();
    });
    mutation.observe(history, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(history);
    history.addEventListener("scroll", schedule, true);
    history.addEventListener("focusin", schedule);
    history.addEventListener("focusout", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      history.removeEventListener("scroll", schedule, true);
      history.removeEventListener("focusin", schedule);
      history.removeEventListener("focusout", schedule);
      for (const message of faded) message.style.removeProperty("--flow-edge-mask");
      history.style.removeProperty("--flow-history-height");
    };
  }, []);

  return (
    <div className={`conversation-flow${collapsed ? " is-collapsed" : ""}`}>
      <div className="conversation-flow__column">
        <section
          className="conversation-flow__conversation"
          id={conversationId}
          ref={historyRef}
          aria-label={conversationLabel}
          aria-hidden={collapsed || undefined}
          {...(collapsed ? { inert: "" } : {})}
        >
          {conversation}
        </section>
        <div className="conversation-flow__entry-area">
          {onToggle && (
            <button
              className="conversation-flow__toggle"
              type="button"
              ref={toggleRef}
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-controls={conversationId}
            >
              {collapsed ? "Show conversation" : "Retract conversation"}
            </button>
          )}
          {todos != null && <div className="conversation-flow__todos">{todos}</div>}
          <div className="conversation-flow__entry">{entry}</div>
        </div>
      </div>
      {workNavigation != null && (
        <div className="conversation-flow__work-navigation" role="group" aria-label="Workspace navigation">
          {workNavigation}
        </div>
      )}
    </div>
  );
}
