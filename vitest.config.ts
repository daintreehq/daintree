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
    include: [
      "electron/**/*.{test,spec}.{js,ts}",
      "src/**/*.{test,spec}.{js,ts,jsx,tsx}",
      "shared/**/*.{test,spec}.{js,ts}",
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
