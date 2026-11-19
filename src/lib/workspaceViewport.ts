type WorkView = { x: number; y: number; zoom: number };
export type WorkBox = { x: number; y: number; w: number; h: number };
type WorkViewport = { width: number; height: number };

/** Fit world coordinates, never animated screen rectangles; hidden modes cannot establish a view. */
export function fitWorkView(boxes: readonly WorkBox[], viewport: WorkViewport, opts: { padding?: number; foot?: number } = {}): WorkView | null {
  if (viewport.width <= 40 || viewport.height <= 40) return null;
  if (!boxes.length) return { x: -viewport.width / 2, y: -viewport.height / 3, zoom: 1 };
  if (viewport.width <= 64 || viewport.height <= 140) return null;
  const bounds = unionBounds(boxes.map((box) => ({ x: box.x, y: box.y, width: box.w, height: box.h })));
  // `foot`: room kept at the bottom for the entry strip; a viewport already measured above it (a phone's) keeps none.
  /* Fitted work is shown at its real size at most, as on a laptop; a wide screen has room to show it larger, in step with its
     width (1.33 at 1920 px, 1.6 from 2300), so a table and a chart do not sit small in a sea of dotted grid. */
  const maxZoom = Math.min(1.6, Math.max(1, viewport.width / 1440));
  const camera = fitAll(bounds ? [bounds] : [], { width: viewport.width, height: viewport.height - (opts.foot ?? 76) }, opts.padding ?? 32, maxZoom);
  return { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, zoom: camera.zoom };
}

/** World bounds make queued reveals independent of an in-flight CSS glide. */
export function revealWorkView(view: WorkView, boxes: readonly WorkBox[], viewport: WorkViewport): WorkView {
  if (!boxes.length || viewport.width <= 40 || viewport.height <= 40) return view;
  const margin = 16 / view.zoom;
  const floor = view.y + (viewport.height - 76) / view.zoom;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  const dx = left < view.x + margin ? left - view.x - margin
    : right > view.x + viewport.width / view.zoom - margin
      ? Math.min(right - view.x - viewport.width / view.zoom + margin, left - view.x - margin) : 0;
  const dy = top < view.y + margin ? top - view.y - margin
    : bottom > floor ? Math.min(bottom - floor, top - view.y - margin) : 0;
  return dx || dy ? { ...view, x: view.x + dx, y: view.y + dy } : view;
}
import { fitAll, unionBounds } from "./panacea/workspace-camera";
