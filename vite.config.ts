import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Found only when object select is first used: prebundled up front, so the dev server does not reload the page then.
  optimizeDeps: { include: ["@mediapipe/tasks-vision"] },
  build: { outDir: "dist", assetsDir: "assets" },
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
});
