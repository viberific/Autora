import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", assetsDir: "assets" },
  server: {
    host: "0.0.0.0",
    port: 3000,
    watch: {
      ignored: [
        "**/.cache/**",
        "**/gdevelop-editor/work/**",
        "**/spectra-editor/src/renderer/**",
        "**/opencut-editor/src/web/**",
      ],
    },
  },
});
