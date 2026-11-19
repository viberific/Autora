/**
 * The server's browser on the machine's graphics chip.
 *
 * A headless Chromium in a container draws WebGL on the CPU (SwiftShader, or Mesa's llvmpipe) unless it is given the chip:
 * a 3D page or a game then runs at a frame a second on a machine whose own Chrome runs it perfectly (an Intel N95's small
 * graphics chip is plenty). Three things are needed and this is the third: the container must be given the device
 * (`/dev/dri`, in the compose file), the image needs the chip's drivers (Mesa, in the Dockerfile), and Chromium must be told
 * which route to the chip to use. Routes differ between machines and Chromium versions, so none is trusted: each is tried, and
 * the browser is asked which renderer it really got (the WebGL debug-renderer string). A route that still lands on software is
 * closed and the next tried; if none gets the chip the caller starts the browser as it always did. With no render node there is
 * nothing to try at all, so a machine without a chip behaves exactly as before.
 *
 * Pure apart from the two reads of the filesystem in `gpuCandidates`' defaults, so it is tested without a chip
 * (tests/gpu.test.ts).
 */
import fs from "node:fs";

/** One way of pointing Chromium at the chip: its flags, and any environment it needs. */
export interface GpuCandidate {
  name: string;
  args: string[];
  env?: Record<string, string>;
}

/** Starts the browser on one candidate and says which renderer WebGL got; `close` takes it down again. */
export type GpuAttempt = (candidate: GpuCandidate) => Promise<{ renderer: string | null; close: () => Promise<void> }>;

const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software|subzero|mesa offscreen/i;

/** Whether a WebGL renderer string is a graphics chip and not the CPU pretending to be one. Nothing at all is not a chip. */
export function isHardwareRenderer(renderer: string | null | undefined): boolean {
  const r = (renderer ?? "").trim();
  return r.length > 0 && !SOFTWARE.test(r);
}

const VULKAN_ICD_DIR = "/usr/share/vulkan/icd.d";

interface Sources {
  /** DRM render nodes the process may open, like /dev/dri/renderD128. */
  renderNodes: string[];
  /** File names in the Vulkan ICD folder. */
  icdDir: string[];
  env: Record<string, string | undefined>;
}

function readSources(): Sources {
  let renderNodes: string[] = [];
  try {
    renderNodes = fs.readdirSync("/dev/dri")
      .filter((n) => /^renderD\d+$/.test(n))
      .map((n) => `/dev/dri/${n}`)
      .filter((p) => { try { fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } });
  } catch { /* no /dev/dri: no chip in this container */ }
  let icdDir: string[] = [];
  try { icdDir = fs.readdirSync(VULKAN_ICD_DIR).filter((n) => n.endsWith(".json")); } catch { /* no Vulkan drivers */ }
  return { renderNodes, icdDir, env: process.env };
}

/** The flags every route shares: use what the chip offers, draw and rasterise on it. */
const COMMON = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy"];

/**
 * The routes to try, best first. None when the container has no render node, or when AUTORA_BROWSER_GPU is off; one when the
 * person has named their own flags (AUTORA_BROWSER_GPU_ARGS), since they know their machine better than a guess.
 */
export function gpuCandidates(sources: Sources = readSources()): GpuCandidate[] {
  const { renderNodes, icdDir, env } = sources;
  if (/^(off|0|false|no)$/i.test(String(env.AUTORA_BROWSER_GPU ?? ""))) return [];
  if (renderNodes.length === 0) return [];
  const own = String(env.AUTORA_BROWSER_GPU_ARGS ?? "").trim();
  if (own) return [{ name: "your flags", args: [...COMMON, ...own.split(/\s+/)] }];
  // The chip's Vulkan driver by name, never the software one: with both listed ANGLE may take whichever comes first.
  const chipIcds = icdDir.filter((n) => !/lvp|swrast|lavapipe/i.test(n)).map((n) => `${VULKAN_ICD_DIR}/${n}`);
  const out: GpuCandidate[] = [
    { name: "OpenGL (EGL)", args: ["--use-gl=angle", "--use-angle=gl-egl", ...COMMON] },
  ];
  if (chipIcds.length) {
    out.push({
      name: "Vulkan",
      args: ["--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--disable-vulkan-surface", ...COMMON],
      env: { VK_ICD_FILENAMES: chipIcds.join(":") },
    });
  }
  out.push({ name: "OpenGL ES", args: ["--use-gl=angle", "--use-angle=gles", ...COMMON] });
  return out;
}

/**
 * Tries each route in turn. The first whose browser reports a real chip is returned, still running; one that reports software, or
 * would not start, is closed first. Null when none got the chip, with nothing left running.
 */
export async function pickGpu(
  candidates: GpuCandidate[],
  attempt: GpuAttempt,
): Promise<{ candidate: GpuCandidate; renderer: string } | null> {
  for (const candidate of candidates) {
    let got: Awaited<ReturnType<GpuAttempt>>;
    try {
      got = await attempt(candidate);
    } catch {
      continue; // would not start with these flags
    }
    if (isHardwareRenderer(got.renderer)) return { candidate, renderer: got.renderer as string };
    await got.close().catch(() => undefined);
  }
  return null;
}

/** What the browser is drawing with, for the log and the status: set once a browser has started. */
let current: { mode: string; renderer: string | null } = { mode: "not started", renderer: null };
export const browserGpuInfo = () => current;
export function noteBrowserGpu(mode: string, renderer: string | null): void {
  current = { mode, renderer };
}
