import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;
const isWindowsCI = process.platform === "win32" && isCI;

// Windows CI runners are slow to launch Electron — give hooks and tests more time
const coreTimeout = isWindowsCI ? 600_000 : 120_000;
const onlineTimeout = isWindowsCI ? 600_000 : 300_000;

export default defineConfig({
  workers: "50%",
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: isWindowsCI ? 15_000 : isCI ? 10_000 : 5_000 },
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
      retries: isCI ? 2 : 0,
    },
    {
      name: "online",
      testDir: "./e2e/online",
      timeout: onlineTimeout,
      retries: isCI ? 1 : 0,
    },
  ],
});
