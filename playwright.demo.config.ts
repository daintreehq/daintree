import { defineConfig } from "@playwright/test";
import { expectTimeout, reporter } from "./playwright.config";

/**
 * Demo-engine specs — deliberately outside `playwright.config.ts`, like the
 * mechanism, plugins and assistant configs: `npm run test:e2e` is a bare
 * `npx playwright test`, which runs every project in that file, and these
 * record 4K screencasts rather than gate anything. `intro-video` additionally
 * drives real agent CLIs, so it self-skips unless `DAINTREE_DEMO_INTRO=1`.
 *
 * Runs on demand via the `demo` suite in .github/workflows/e2e.yml, which
 * shares the main config's reporter wiring (JSON and blob outputs).
 *
 *   npm run build:e2e && npm run test:e2e:demo
 *   npm run build:e2e && npx playwright test --config=playwright.demo.config.ts e2e/demo/demo-terminal-input.spec.ts
 */
export default defineConfig({
  testDir: "./e2e/demo",
  // Recording choreography plus an Electron cold launch on Windows.
  timeout: 1_800_000,
  // Cold Electron launches recording at 4K contend on the crashpad Mach port
  // and the shared demo repo fixtures, so the specs must never run in parallel.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  failOnFlakyTests: process.env.FAIL_ON_FLAKY_TESTS === "true",
  expect: { timeout: expectTimeout },
  outputDir: "./test-results",
  ...(reporter ? { reporter } : {}),
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
