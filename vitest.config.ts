import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    globalSetup: "./vitest.global-setup.ts",
    setupFiles: ["./vitest.setup.ts"],
    onConsoleLog: () => false,
    // Pool stays at the default (forks). The threads pool was tried for lower
    // per-file overhead, but @parcel/watcher's native addon (pulled in
    // transitively by the file-watching services) is not context-aware and
    // fails with "Module did not self-register" when loaded into a second
    // worker_thread on Linux. Forks give each worker its own process, sidestep
    // that, and the headline speedup is the 4-way sharding in ci.yml — not the
    // pool. minWorkers is left unset so workers track CPU count (the old
    // minWorkers:3 forced 3 workers even on the 2-core CI runners).
    maxConcurrency: 10,
    include: [
      "electron/**/*.{test,spec}.{js,ts}",
      "src/**/*.{test,spec}.{js,ts,jsx,tsx}",
      "shared/**/*.{test,spec}.{js,ts}",
      "scripts/**/*.{test,spec}.{js,ts,mjs}",
      "e2e/helpers/__tests__/*.{test,spec}.{js,ts}",
      "plugins/**/*.{test,spec}.{js,ts,jsx,tsx}",
      "packages/**/*.{test,spec}.{js,ts,jsx,tsx}",
    ],
    exclude: [
      "node_modules",
      "dist",
      "dist-electron",
      "build",
      "release",
      "**/*.integration.test.{js,ts}",
    ],
    testTimeout: 15000,
    env: {
      NODE_ENV: "development",
    },
  },
});
