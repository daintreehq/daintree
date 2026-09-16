import { defineConfig } from "@playwright/test";

/**
 * Live plugin checks — deliberately outside `playwright.config.ts`, for the
 * same reason as the mechanism checks: `npm run test:e2e` runs every project in
 * that file, and these must never be swept into a suite or a release gate.
 *
 * Each spec drives one plugin through the real app against the real toolchain
 * it targets (a SvelteKit dev server installed from the registry, not a stub),
 * so they need network on a cold npm cache and take minutes. Run on request:
 *
 *   npm run build:e2e && npm run test:e2e:plugins
 *   npm run build:e2e && npx playwright test --config=playwright.plugins.config.ts e2e/plugins/sveltekit-builder.spec.ts
 */
export default defineConfig({
  testDir: "./e2e/plugins",
  testMatch: "**/*.spec.ts",
  // Dependency install, a cold Vite compile and a cold Electron launch share
  // one budget in `beforeAll`.
  timeout: 600_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results-plugins",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
