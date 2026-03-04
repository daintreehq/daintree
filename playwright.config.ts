import { defineConfig } from "@playwright/test";

export default defineConfig({
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  outputDir: "./test-results",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "core",
      testDir: "./e2e/core",
      timeout: 120_000,
      retries: process.env.CI ? 1 : 0,
    },
    {
      name: "online",
      testDir: "./e2e/online",
      timeout: 300_000,
      retries: process.env.CI ? 1 : 0,
    },
  ],
});
