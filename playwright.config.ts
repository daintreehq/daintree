import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;
const isWindowsCI = process.platform === "win32" && isCI;

// Per-test timeout: allow enough time for launch retries + test execution.
// launchApp retries up to 5x with 45s timeout per attempt on Windows CI.
const coreTimeout = isWindowsCI ? 300_000 : 120_000;
const onlineTimeout = isWindowsCI ? 480_000 : 300_000;

export default defineConfig({
  workers: 1,
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
