export type WorldRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type Viewport = Readonly<{ width: number; height: number }>;
type ScreenPoint = Readonly<{ x: number; y: number }>;

/** Pixel translation: screen = world * zoom + { x, y }. */
export type Camera = Readonly<{ x: number; y: number; zoom: number }>;

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function positive(value: number, name: string): number {
  if (finite(value, name) <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function validateRect(rect: WorldRect): void {
  finite(rect.x, "rect.x");
  finite(rect.y, "rect.y");
  if (finite(rect.width, "rect.width") < 0 || finite(rect.height, "rect.height") < 0) {
    throw new RangeError("Rectangle dimensions must be nonnegative");
  }
  finite(rect.x + rect.width, "rect right edge");
  finite(rect.y + rect.height, "rect bottom edge");
}

function validateViewport(viewport: Viewport): void {
  positive(viewport.width, "viewport.width");
  positive(viewport.height, "viewport.height");
}

function validateCamera(camera: Camera): Camera {
  finite(camera.x, "camera.x");
  finite(camera.y, "camera.y");
  positive(camera.zoom, "camera.zoom");
  return camera;
}

/** Empty scenes have no bounds. Zero-sized rectangles are valid points/lines; malformed bounds throw. */
export function unionBounds(rects: readonly WorldRect[]): WorldRect | null {
  if (!rects.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    validateRect(rect);
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return {
    x: left, y: top,
    width: finite(right - left, "bounds.width"),
    height: finite(bottom - top, "bounds.height"),
  };
}

/** Padding is in pixels and must leave positive room. No minimum zoom can clip a large scene. */
export function fitAll(
  rects: readonly WorldRect[], viewport: Viewport, padding = 32, maxZoom = 1,
): Camera {
  validateViewport(viewport);
  if (finite(padding, "padding") < 0) throw new RangeError("padding must be nonnegative");
  positive(maxZoom, "maxZoom");
  const roomWidth = positive(viewport.width - 2 * padding, "padded viewport.width");
  const roomHeight = positive(viewport.height - 2 * padding, "padded viewport.height");
  const bounds = unionBounds(rects);
  if (!bounds) return { x: viewport.width / 2, y: viewport.height / 2, zoom: Math.min(1, maxZoom) };
  const zoom = Math.min(
    maxZoom,
    bounds.width > 0 ? roomWidth / bounds.width : Infinity,
    bounds.height > 0 ? roomHeight / bounds.height : Infinity,
  );
  return jumpTo(bounds, viewport, { x: 0, y: 0, zoom });
}

/** Center one surface without altering zoom, rectangles, or which work is present. */
export function jumpTo(rect: WorldRect, viewport: Viewport, camera: Camera): Camera {
  validateRect(rect);
  validateViewport(viewport);
  validateCamera(camera);
  return validateCamera({
    x: viewport.width / 2 - (rect.x + rect.width / 2) * camera.zoom,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * camera.zoom,
    zoom: camera.zoom,
  });
}

/** Set an absolute zoom, keeping the world point beneath the viewport-local pixel anchor fixed. */
export function zoomAt(camera: Camera, anchor: ScreenPoint, nextZoom: number): Camera {
  validateCamera(camera);
  finite(anchor.x, "anchor.x");
  finite(anchor.y, "anchor.y");
  positive(nextZoom, "nextZoom");
  if (nextZoom === camera.zoom) return { ...camera };
  return validateCamera({
    x: anchor.x - ((anchor.x - camera.x) / camera.zoom) * nextZoom,
    y: anchor.y - ((anchor.y - camera.y) / camera.zoom) * nextZoom,
    zoom: nextZoom,
  });
}
