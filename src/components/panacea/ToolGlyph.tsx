/** The image engine's tools, each a small line drawing in the text colour (src/lib/panacea/image.ts TOOLS). */
const PATHS: Record<string, string> = {
  pointer: "M5 3l11 6-5 1.5L8.5 16z",
  move: "M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5",
  marquee: "M3 4h2M7 4h2M11 4h2M15 4h2v2M17 8v2M17 12v2M17 16h-2M13 16h-2M9 16H7M5 16H3v-2M3 12v-2M3 8V6",
  ellipse: "M10 4c4.5 0 7 2.7 7 6s-2.5 6-7 6-7-2.7-7-6 2.5-6 7-6z",
  lasso: "M5.5 12.5C3 11 2.5 8.5 4 6.5S9 3 12.5 3.6 18 6.6 17 9.6s-5 4-8.6 3.6c-1.5-.2-3 0-3.4 1.4s.6 2.6 2 2.6",
  polygon: "M4 15l2-10 9 2 2 8z",
  wand: "M3 17l9-9M13 3v3M17 7h-3M15.5 4.5l-2 2M11 4.5l1 1M16.5 9.5l-1-1",
  quick: "M4 14c2-2 3-6 7-6s4 3 6 2M3 17c1.5 0 2-1 2.5-2.5",
  object: "M10 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM4.5 17c.5-3.5 2.8-5.5 5.5-5.5s5 2 5.5 5.5",
  color: "M10 3c3 4 5 6.3 5 8.7a5 5 0 0 1-10 0C5 9.3 7 7 10 3z",
  crop: "M6 2v12h12M2 6h12v12",
  brush: "M13 3l4 4-7 7-4-4zM6 10c-2 0-3.5 1.5-3.5 4 0 1-.5 2-1 2.5 3 .5 6-.5 6.5-3.5",
  eraser: "M7 17h10M3.5 12.5l7.5-7.5 5 5-6.5 6.5H7z",
  heal: "M7.5 3h5v4.5H17v5h-4.5V17h-5v-4.5H3v-5h4.5z",
  text: "M4 5V3h12v2M10 3v14M7.5 17h5",
  eyedropper: "M14 3l3 3-2 2-3-3zM12.5 6.5l-8 8L4 17l2.5-.5 8-8",
};

export function ToolGlyph({ tool, size = 16 }: { tool: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[tool] ?? PATHS.pointer} />
    </svg>
  );
}
