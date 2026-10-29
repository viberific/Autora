/**
 * Object select: a click on a person, a thing or the sky, and the picture's segmentation model (MediaPipe's interactive
 * segmenter, "magic touch", Apache-2.0) finds its outline, in the browser. The model's runtime is bundled with Autora
 * (its wasm is served from the app itself) and the model is fetched once by the server and kept
 * (`/api/panacea/model/magic_touch.tflite`, server/panacea.ts), so no picture ever leaves the machine.
 *
 * Loaded the first time it is needed, as its own chunk.
 */
// By path: the package does not export its wasm folder, and the files are served from the app as they are.
import wasmLoaderPath from "../../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url";
import wasmBinaryPath from "../../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url";
import type { InteractiveSegmenter } from "@mediapipe/tasks-vision";
import { coverage } from "../../lib/panacea/mask";

const MODEL = "/api/panacea/model/magic_touch.tflite";

let loading: Promise<InteractiveSegmenter> | null = null;

function segmenter(): Promise<InteractiveSegmenter> {
  loading ??= (async () => {
    const vision = await import("@mediapipe/tasks-vision");
    const probe = await fetch(MODEL, { method: "HEAD" }).catch(() => null);
    if (!probe?.ok) throw new Error(probe?.status === 503 ? "The object model could not be fetched (is this machine online?)." : "The object model is not available.");
    return await vision.InteractiveSegmenter.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, {
      baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** The object at a point (0..1 across the picture), as a mask the size of `image`: 0 outside, 255 inside. */
export async function objectAt(image: HTMLCanvasElement, x: number, y: number): Promise<Uint8Array> {
  const seg = await segmenter();
  const result = seg.segment(image, { keypoint: { x, y } });
  const masks = result.confidenceMasks ?? [];
  // The model gives the background's confidence and the object's; the object's is the last.
  const m = masks.at(-1);
  if (!m) throw new Error("The model found nothing there.");
  const conf = m.getAsFloat32Array();
  const mw = m.width;
  const mh = m.height;
  // Taken to the picture's size (the model's mask is the size of what it was given, but say so either way).
  const out = new Uint8Array(image.width * image.height);
  for (let j = 0; j < image.height; j++) {
    const sy = Math.min(mh - 1, Math.floor(((j + 0.5) * mh) / image.height));
    for (let i = 0; i < image.width; i++) {
      const sx = Math.min(mw - 1, Math.floor(((i + 0.5) * mw) / image.width));
      const v = conf[sy * mw + sx]!;
      // A soft edge from the model's own confidence around a half.
      out[j * image.width + i] = v <= 0.35 ? 0 : v >= 0.65 ? 255 : Math.round(((v - 0.35) / 0.3) * 255);
    }
  }
  for (const k of masks) k.close();
  return out;
}

/**
 * The picture's main subject: the object at the centre, or at a third of the way in if the centre gives the whole
 * frame or a speck; the one most like a subject (a fair part of the picture, not all of it) wins.
 */
export async function subjectOf(image: HTMLCanvasElement): Promise<{ mask: Uint8Array; x: number; y: number }> {
  const points: Array<[number, number]> = [[0.5, 0.5], [0.5, 0.42], [1 / 3, 0.5], [2 / 3, 0.5], [0.5, 2 / 3]];
  let best: { mask: Uint8Array; x: number; y: number; score: number } | null = null;
  for (const [x, y] of points) {
    const mask = await objectAt(image, x, y);
    const c = coverage(mask);
    const score = c < 0.01 || c > 0.9 ? 0 : 1 - Math.abs(c - 0.3);
    if (!best || score > best.score) best = { mask, x, y, score };
    if (score > 0.85) break;
  }
  if (!best || best.score === 0) throw new Error("No subject stands out; click it with Object select.");
  return best;
}
