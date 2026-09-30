import { defineConfig } from "@playwright/test";

/**
 * Assistant workflow runs: the Daintree Assistant driving real agent CLIs on
 * the user's own subscriptions, end to end (`e2e/assistant/`).
 *
 * Deliberately outside `playwright.config.ts`, like the mechanism checks: a bare
 * `npx playwright test` runs every project in that file, and these runs are for
 * measuring and tuning the assistant, never for gating a release. Nothing runs
 * unless `DAINTREE_E2E_ASSISTANT_WORKFLOW` names scenarios.
 *
 *   npm run build:e2e
 *   DAINTREE_E2E_ASSISTANT_WORKFLOW=facts-vote npm run test:e2e:assistant
 */
export default defineConfig({
  testDir: "./e2e/assistant",
  // Each scenario sets its own budget from its timeout.
  timeout: 60 * 60_000,
  workers: 1,
  fullyParallel: false,
  // A workflow that only works on a retry is a finding, not a flake.
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  outputDir: "./test-results-assistant",
  use: { trace: "retain-on-failure" },
});
