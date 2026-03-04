import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;
const isWindowsCI = process.platform === "win32" && isCI;

// Windows CI runners are slow to launch Electron — give hooks and tests more time
const coreTimeout = isWindowsCI ? 240_000 : 120_000;

export default defineConfig({
  workers: "50%",
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
      timeout: coreTimeout,
      retries: isCI ? 1 : 0,
    },
    {
      name: "online",
      testDir: "./e2e/online",
      timeout: 300_000,
      retries: isCI ? 1 : 0,
    },
  ],
});
