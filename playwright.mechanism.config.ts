import { defineConfig } from "@playwright/test";

/**
 * Mechanism checks — deliberately outside `playwright.config.ts` (#12242).
 *
 * These answer "does the platform actually behave this way", not "does the
 * product still work". They need real encoded fixtures, a real media pipeline
 * and several hundred megabytes of scratch disk, so they are run on request and
 * never as part of a suite.
 *
 * A project added to the main config would not be safe: `npm run test:e2e` is a
 * bare `npx playwright test`, which runs *every* project in that file. A second
 * config is the only placement that cannot be swept up by accident.
 *
 *   npm run build:e2e && npm run test:e2e:mechanism
 */
export default defineConfig({
  testDir: "./e2e/mechanism",
  // Cold Electron launch, fixture generation and a large file write all land in
  // one test budget; there is no value in failing it on the clock.
  timeout: 900_000,
  workers: 1,
  fullyParallel: false,
  // A mechanism result that only reproduces sometimes is a finding, not a
  // flake to be retried away.
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results-mechanism",
  use: { trace: "retain-on-failure" },
});
