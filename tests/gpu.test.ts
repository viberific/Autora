/**
 * The server's browser on the machine's graphics chip (server/browsergpu.ts). A headless Chromium in a container draws WebGL
 * on the CPU (SwiftShader / llvmpipe) unless it is given the chip, and a 3D page or a game then runs at a frame a second.
 * Nothing here needs a chip: the choice of what to try, and the decision from what the browser says it got, are plain code.
 *
 *   npx tsx tests/gpu.test.ts
 */
import assert from "node:assert/strict";
import { gpuCandidates, isHardwareRenderer, pickGpu, type GpuAttempt } from "../server/browsergpu";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const none = { renderNodes: [] as string[], icdDir: [] as string[], env: {} as Record<string, string | undefined> };

await test("software renderers are told from the chip", () => {
  for (const r of ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "llvmpipe (LLVM 17.0.6, 256 bits)", "Mesa Software Rasterizer", "ANGLE (Mesa, llvmpipe)", "softpipe", "Google SwiftShader", "", null]) {
    assert.equal(isHardwareRenderer(r as string | null), false, String(r));
  }
  for (const r of ["ANGLE (Intel, Mesa Intel(R) Graphics (ADL-N), OpenGL ES 3.2)", "Mesa Intel(R) UHD Graphics 600 (GLK 3)", "ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir), OpenGL 4.6)", "NVIDIA GeForce GTX 1650/PCIe/SSE2"]) {
    assert.equal(isHardwareRenderer(r), true, r);
  }
});

await test("with no render node there is nothing to try: the browser starts as it always did", () => {
  assert.deepEqual(gpuCandidates(none), []);
});

await test("with a render node the chip is tried before anything else, by more than one route, and the Vulkan one names the chip's driver", () => {
  const c = gpuCandidates({ renderNodes: ["/dev/dri/renderD128"], icdDir: ["lvp_icd.x86_64.json", "intel_icd.x86_64.json"], env: {} });
  assert.ok(c.length >= 2);
  assert.ok(c[0].args.some((a) => /use-angle=gl-egl/.test(a)), "the GL route first");
  const vulkan = c.find((x) => x.args.some((a) => /use-angle=vulkan/.test(a)));
  assert.ok(vulkan, "and the Vulkan route");
  assert.match(vulkan!.env?.VK_ICD_FILENAMES ?? "", /intel_icd\.x86_64\.json/, "Vulkan is pointed at the chip's driver, not the software one");
  assert.ok(!/lvp/.test(vulkan!.env?.VK_ICD_FILENAMES ?? ""));
});

await test("off in the environment means off, and a person's own flags are the only thing tried", () => {
  assert.deepEqual(gpuCandidates({ renderNodes: ["/dev/dri/renderD128"], icdDir: [], env: { AUTORA_BROWSER_GPU: "off" } }), []);
  const own = gpuCandidates({ renderNodes: ["/dev/dri/renderD128"], icdDir: [], env: { AUTORA_BROWSER_GPU_ARGS: "--use-angle=gl --foo=1" } });
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].args.filter((a) => /^--(use-angle|foo)/.test(a)), ["--use-angle=gl", "--foo=1"]);
});

await test("the first route that really gets the chip wins; one that falls back to software is closed and the next is tried", async () => {
  const tried: string[] = [];
  const cands = gpuCandidates({ renderNodes: ["/dev/dri/renderD128"], icdDir: ["intel_icd.x86_64.json"], env: {} });
  const closed: string[] = [];
  const attempt = (renderers: Record<string, string>): GpuAttempt => async (c) => {
    tried.push(c.name);
    return { renderer: renderers[c.name] ?? null, close: async () => { closed.push(c.name); } };
  };
  const first = await pickGpu(cands, attempt({ [cands[0].name]: "ANGLE (Intel, Mesa Intel(R) Graphics (ADL-N))" }));
  assert.equal(first?.candidate.name, cands[0].name);
  assert.deepEqual(closed, [], "the one that worked stays open");
  tried.length = 0;
  const second = await pickGpu(cands, attempt({ [cands[0].name]: "Google SwiftShader", [cands[1].name]: "ANGLE (Intel, Mesa Intel(R) Graphics (ADL-N))" }));
  assert.equal(second?.candidate.name, cands[1].name);
  assert.deepEqual(closed, [cands[0].name], "the software one was closed");
  closed.length = 0;
  const none2 = await pickGpu(cands, attempt({}));
  assert.equal(none2, null, "none worked: the caller starts the browser as before");
  assert.equal(closed.length, cands.length, "and none is left running");
});

await test("a route that throws is a route that did not work", async () => {
  const cands = gpuCandidates({ renderNodes: ["/dev/dri/renderD128"], icdDir: [], env: {} });
  const got = await pickGpu(cands, async (c) => {
    if (c === cands[0]) throw new Error("the browser would not start");
    return { renderer: "Mesa Intel(R) Graphics", close: async () => undefined };
  });
  assert.ok(got && got.candidate !== cands[0]);
});

console.log(`${passed} gpu tests passed`);
