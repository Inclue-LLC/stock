import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  esbuild: { target: "es2022" },
  test: { environment: "node", testTimeout: 30000, hookTimeout: 60000 },
});
