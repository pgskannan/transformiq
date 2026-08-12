/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      // Sprint 1 baseline (TQ-009) — raise as real coverage grows, do not lower it.
      thresholds: { statements: 40, branches: 30, functions: 40, lines: 40 },
    },
  },
});
