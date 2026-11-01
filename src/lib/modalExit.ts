/**
 * Modals leave as smoothly as they arrive.
 *
 * Every modal is a `.scrim` that its owner simply stops rendering, so React
 * removes it at once and there is nothing left to animate. Rather than teach
 * each of them (and each place that closes one) to wait, this watches for a
 * `.scrim` leaving the page and puts an inert copy of it back where it was,
 * marked `is-leaving`, for the length of its exit animation (styles.css). The
 * copy takes no clicks or focus, so the app behind it is usable straight away.
 * Scroll positions are carried over, so a scrolled list does not jump to the
 * top as it fades. With reduced motion asked for, nothing is kept.
 */

/** Longer than the exit animation; the copy goes then even if no animationend arrives. */
const FALLBACK_MS = 600;

export function installModalExit(root: HTMLElement = document.body) {
  const scrolled = new WeakMap<Element, { top: number; left: number }>();
  const onScroll = (event: Event) => {
    const el = event.target;
    if (el instanceof Element && el.closest(".scrim")) scrolled.set(el, { top: el.scrollTop, left: el.scrollLeft });
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  const leave = (scrim: HTMLElement, parent: Node, next: Node | null) => {
    const ghost = scrim.cloneNode(true) as HTMLElement;
    ghost.classList.add("is-leaving");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    const host = parent.isConnected ? parent : document.body;
    host.insertBefore(ghost, next && next.parentNode === host ? next : null);
    // Restore what was scrolled: the copy's elements match the original's one for one.
    const from = scrim.querySelectorAll("*");
    const to = ghost.querySelectorAll("*");
    from.forEach((el, i) => {
      const at = scrolled.get(el);
      const copy = to[i];
      if (at && copy) { copy.scrollTop = at.top; copy.scrollLeft = at.left; }
    });
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ghost.remove();
    };
    const timer = setTimeout(remove, FALLBACK_MS);
    ghost.addEventListener("animationend", (event) => { if (event.target === ghost) remove(); });
  };

  const observer = new MutationObserver((records) => {
    if (reduced?.matches) return;
    for (const record of records) {
      record.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.classList.contains("scrim") && !node.classList.contains("is-leaving")) {
          leave(node, record.target, record.nextSibling);
        }
      });
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    document.removeEventListener("scroll", onScroll, { capture: true });
  };
}
