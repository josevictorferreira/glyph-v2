/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";

const backend = process.env.GLYPH_BACKEND_URL ?? "http://localhost:3000";

// gRPC-Web (including server streaming) must pass through uncompressed and
// without a proxy response timeout, or frames buffer and live updates stall.
const grpcProxy = {
  target: backend,
  proxyTimeout: 0,
  headers: { "accept-encoding": "identity" },
} as const;

export default defineConfig({
  plugins: [tanstackRouter({ generatedRouteTree: "src/routeTree.gen.ts" }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@test": fileURLToPath(new URL("./test", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "^/glyph\\.v1\\..*": grpcProxy,
      "^/grpc\\..*": grpcProxy,
      "^/workflows/[^/]+/runs/[^/]+/step_runs/[^/]+/(download|preview)$": {
        target: backend,
      },
      "^/schemas/.*$": { target: backend },
      "^/up$": { target: backend },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
  },
});
