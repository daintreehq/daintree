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
    // Threads pool: lower per-file spawn overhead than forks on the 2-core CI
    // runners, where the unit suite is sharded across jobs. Safe because the
    // global shims in vitest.setup.ts use vi.stubGlobal (restored per-file) and
    // Vitest groups files by environment before distributing them to workers,
    // so the node→jsdom rAF leak (vitest #6392) cannot reproduce. isolate stays
    // at the default (true) — ProjectStore's load-time app.getPath() side effect
    // makes isolate:false unsafe (see projectstore-eager-import-footgun).
    pool: "threads",
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
