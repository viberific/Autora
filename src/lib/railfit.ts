import { useCallback, useLayoutEffect, useState } from "react";

/**
 * How wide the menu has to be before its words fit, and when it folds to a
 * strip of icons.
 *
 * Both numbers used to be constants (a 160px threshold for "the labels need
 * about 157"), and both were wrong in ways you could see: the labels changed
 * with the theme's text size and the label set itself, and one number meant the
 * menu folded while the words still had room, then unfolded again a pixel later
 * (the flicker while dragging the seam).
 *
 * So the width is measured -- the widest label with its icon, its gaps and both
 * paddings, and the row at the top of the menu, whichever is wider -- and the
 * fold is a band rather than a line: fold below what the words need, unfold only
 * once there is SLACK more than that. A drag can cross the line and come back
 * without the icons appearing and disappearing each time.
 */

/** How much wider than the words need before they come back after folding. Small on
    purpose: the whole menu is 164px and the words need about 144, so the band has to
    fit inside that -- but a band there still is, which is what stops a drag chattering
    on one number. */
export const RAIL_SLACK = 16;

/** An element's own width, kept current. 0 until it has been measured. */
export function useWidthOf(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const take = () => setWidth((was) => {
      const now = Math.round(el.getBoundingClientRect().width);
      return now === was ? was : now;
    });
    take();
    const ro = new ResizeObserver(take);
    ro.observe(el);
    window.addEventListener("resize", take);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", take);
    };
  }, [ref]);
  return width;
}

/**
 * Icons only? Fold under `need`, unfold at `need + slack`, and in between stay
 * as it was -- which is what stops the menu chattering either side of one
 * number. `folded` (the seam's own "Fold the menu to icons") wins either way.
 */
export function useRailIcons(width: number, need: number, folded: boolean): boolean {
  const [icons, setIcons] = useState(false);
  useLayoutEffect(() => {
    if (!width) return;
    setIcons((was) => (was ? width < need + RAIL_SLACK : width < need));
  }, [width, need]);
  return folded || icons;
}

/**
 * How much width a row has left over once everything in it is at its natural
 * size: negative when what is in the row does not fit.
 *
 * Read per render rather than from a ResizeObserver, because what has to be
 * known is the natural width of the children -- a button squeezed to 32px still
 * wants 40 -- and a squeeze does not resize the row, so no observer would fire.
 * Only the rounded number is stored, so a re-measure that finds the same answer
 * is not a re-render.
 */
export function useRowSpare(ref: React.RefObject<HTMLElement | null>): number {
  const [spare, setSpare] = useState(0);
  /* Deliberately on every render: a squeezed child does not resize the row, so no
     observer would catch the moment it stops fitting, and the number is stored
     only when it changes, so this cannot loop. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const kids = [...el.children].filter((k) => {
      const cs = window.getComputedStyle(k);
      return cs.display !== "none" && cs.position !== "absolute" && cs.visibility !== "hidden";
    }) as HTMLElement[];
    const gap = parseFloat(window.getComputedStyle(el).columnGap) || 0;
    /* scrollWidth is the content (padding included); offsetWidth - clientWidth
       is the border, taken off when the box is narrower than its content. */
    const used = kids.reduce((n, k) => n + k.scrollWidth + Math.max(0, k.offsetWidth - k.clientWidth), 0)
      + gap * Math.max(0, kids.length - 1);
    const now = Math.round(el.clientWidth - used);
    setSpare((was) => (now === was ? was : now));
  });
  return spare;
}

/**
 * Whether a control in a tight row should give way -- its word dropped, its
 * label shortened -- with a band so it does not come back the instant it fits:
 * away when what is in the row does not fit, back only once there is `band`
 * spare, which is more than giving way wins back.
 */
export function useGivesWay(spare: number, band = 48): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    setNarrow((was) => (was ? spare < band : spare < 0));
  }, [spare, band]);
  return narrow;
}

/**
 * What the rail's words need, measured from the words: the gauge is a hidden
 * copy of the menu's rows and its top bar, laid out at their natural width, so
 * the theme's text size, the label set and the font all count without a
 * constant to keep in step. Re-measured when the text size or the font
 * changes and whenever the rail is remounted.
 */
export function useRailNeed(
  gauge: React.RefObject<HTMLElement | null>,
): { need: number; measure: () => void } {
  const [need, setNeed] = useState(0);
  const measure = useCallback(() => {
    const el = gauge.current;
    if (!el) return;
    /* scrollWidth of the gauge, which is width:max-content: its widest row, with
       the list's own padding already in it. Two pixels of edge for the rail's own
       border and the seam. The list's scrollbar is deliberately left out: it sits
       in the list's right padding, and counting it would put the fold line above
       164px, the width the whole menu has always been -- so "show the whole menu"
       would widen the rail to a width the words then still did not unfold at. */
    const scroll = Math.ceil(el.scrollWidth);
    setNeed((was) => (scroll > 2 ? Math.max(scroll + 2, was) : was));
  }, [gauge]);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (gauge.current) ro.observe(gauge.current);
    /* The webfonts land after the first paint and change what a word measures. */
    void document.fonts?.ready.then(measure).catch(() => undefined);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [gauge, measure]);
  return { need, measure };
}
