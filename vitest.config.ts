import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
      "@github-renderer": path.resolve(__dirname, "./plugins/builtin/github/renderer"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    globalSetup: "./vitest.global-setup.ts",
    setupFiles: ["./vitest.setup.ts"],
    onConsoleLog: () => false,
    minWorkers: 3,
    maxConcurrency: 10,
    include: [
      "electron/**/*.{test,spec}.{js,ts}",
      "src/**/*.{test,spec}.{js,ts,jsx,tsx}",
      "shared/**/*.{test,spec}.{js,ts}",
      "scripts/**/*.{test,spec}.{js,ts,mjs}",
      "plugins/**/*.{test,spec}.{js,ts,jsx,tsx}",
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
