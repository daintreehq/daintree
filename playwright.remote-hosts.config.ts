import { defineConfig } from "@playwright/test";

/**
 * Remote Hosts end to end — deliberately outside `playwright.config.ts`, for
 * the same reason as the mechanism and plugin checks: `npm run test:e2e` runs
 * every project in that file, and these must never be swept into a suite or a
 * release gate.
 *
 * The main spec runs two real app instances, a Host and a Shell, joined by the
 * system `ssh` through a private user-mode `sshd` on 127.0.0.1 (macOS, needs
 * `/usr/sbin/sshd`; nothing touches ~/.ssh or Remote Login). Run on request:
 *
 *   npm run build:e2e && npm run test:e2e:remote-hosts
 */
export default defineConfig({
  testDir: "./e2e/remote-hosts",
  testMatch: "**/*.spec.ts",
  // Two cold Electron launches, a real ssh setup and a reconnect in one budget.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results-remote-hosts",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
