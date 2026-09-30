import { defineConfig } from "@playwright/test";

// Opt-in measurement harnesses (`npm run perf <command>`, scripts/perf/registry.ts).
// Kept out of playwright.config.ts so no correctness bucket imports them and a
// bare `npx playwright test` never reaches them. Every spec here cold-launches
// Electron and measures wall-clock behaviour, so it runs serially and never
// retries: a retry would hide exactly the variance a benchmark exists to report.
const isCI = !!process.env.CI;
const isWindowsCI = process.platform === "win32" && isCI;

export default defineConfig({
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Most harnesses size their own budget with test.setTimeout; this covers the
  // ones that do not (fixture-heavy beforeAll plus a multi-sample loop).
  timeout: 600_000,
  expect: { timeout: isWindowsCI ? 15_000 : isCI ? 10_000 : 5_000 },
  outputDir: "./test-results/perf",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "perf",
      testDir: "./e2e/perf",
    },
  ],
});
