import { defineConfig, type ReporterDescription } from "@playwright/test";

const isCI = !!process.env.CI;
const isWindowsCI = process.platform === "win32" && isCI;
const isNonWindowsCI = process.platform !== "win32" && isCI;
// macOS local: parallel cold launches contend for crashpad Mach ports
// (FATAL kr == KERN_SUCCESS in exception_handler_server.cc), so serialize.
// CI runners cycle Electron processes more slowly and don't hit this.
const isMacLocal = process.platform === "darwin" && !isCI;
const e2eWorkers = isWindowsCI || isMacLocal ? 1 : 2;

// Per-test timeout: allow enough time for launch retries + test execution.
// launchApp retries up to 3x with 75s timeout per attempt on Windows CI.
// macOS local: 3x50s retries = 152s, leaves ~88s for test work in 240s window.
const coreTimeout = isWindowsCI
  ? 300_000
  : isMacLocal
    ? 240_000
    : isNonWindowsCI
      ? 180_000
      : 120_000;
export const expectTimeout = isWindowsCI ? 15_000 : isCI ? 10_000 : 5_000;

// Blob reporter is opted into by the cross-platform stabilize sweep and the
// release E2E matrix, so per-leg outputs can be merged into a single unified
// HTML report. PR CI and local runs keep the default reporters. The JSON
// reporter is also enabled on that path so extract-failures.mjs has structured
// data to build signature-keyed failure reports the stabilize agent triages.
// JSON reporter is opted into by two consumers:
//   1. E2E workflow retry path — sets PLAYWRIGHT_JSON_OUTPUT_FILE to the
//      target path; attempt 1 writes the JSON, the next step extracts failed
//      spec paths into a --test-list artifact, and any retry attempt
//      downloads that artifact and reruns only the failed specs.
//   2. Stabilize triage — sets PLAYWRIGHT_JSON_REPORT=1; extract-failures.mjs
//      reads the JSON to build signature-keyed failure reports the agent reads.
// When both are set the explicit output file wins; otherwise the triage path
// falls back to the historical default `playwright-results.json`.
// Blob and JSON reporters can coexist: a single stabilize/release run produces
// a blob for the merged HTML report and a JSON for downstream triage.
const jsonOutputFile =
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ||
  (process.env.PLAYWRIGHT_JSON_REPORT === "1" ? "playwright-results.json" : "");
const useJsonReporter = jsonOutputFile.length > 0;
const useBlobReporter = process.env.PLAYWRIGHT_BLOB_REPORT === "1";
// Exported so playwright.demo.config.ts reports through the same CI paths.
export const reporter: ReporterDescription[] | undefined =
  useBlobReporter || useJsonReporter
    ? [
        ["github"] as ReporterDescription,
        ...(useBlobReporter ? [["blob", { outputDir: "blob-report" }] as ReporterDescription] : []),
        ...(useJsonReporter
          ? [["json", { outputFile: jsonOutputFile }] as ReporterDescription]
          : []),
      ]
    : undefined;

export default defineConfig({
  workers: e2eWorkers,
  fullyParallel: false,
  timeout: 180_000,
  // failOnFlakyTests is top-level only (not per-project). Gate it behind
  // FAIL_ON_FLAKY_TESTS so only the release-gating core suite enables
  // it in CI. full-* buckets keep retries without a flake gate for PR velocity.
  failOnFlakyTests: process.env.FAIL_ON_FLAKY_TESTS === "true",
  expect: { timeout: expectTimeout },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  outputDir: "./test-results",
  ...(reporter ? { reporter } : {}),
  use: {
    trace: "retain-on-failure",
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
      name: "full-terminal",
      testDir: "./e2e/full/terminal",
      timeout: coreTimeout,
      retries: isCI ? 2 : 0,
    },
    {
      name: "full-worktree",
      testDir: "./e2e/full/worktree",
      timeout: coreTimeout,
      retries: isCI ? 2 : 0,
    },
    {
      name: "full-presets",
      testDir: "./e2e/full/presets",
      timeout: coreTimeout,
      retries: isCI ? 2 : 0,
    },
    {
      name: "full-platform",
      testDir: "./e2e/full/platform",
      timeout: coreTimeout,
      retries: isCI ? 2 : 0,
    },
    {
      name: "full-panels",
      testDir: "./e2e/full/panels",
      timeout: coreTimeout,
      retries: isCI ? 2 : 0,
    },
    {
      name: "full-resilience",
      testDir: "./e2e/full/resilience",
      timeout: coreTimeout,
      retries: isCI ? 2 : 0,
    },
    {
      // Each full-plugins spec cold-launches Electron with a sideloaded
      // plugin. Parallel workers contend on the crashpad Mach port and exhaust
      // OS-level resources (FATAL kr == KERN_SUCCESS in
      // exception_handler_server.cc, network-service/GPU helper crashes),
      // making specs fail at launch with empty logs — not plugin defects.
      // workers:1 is baked into the project (not a CLI flag) so the bucket
      // stays serialized even under CI's e2eWorkers:2 and for a bare local
      // `npx playwright test --project=full-plugins`. playwright.demo.config.ts
      // serializes its specs for the same crashpad exhaustion.
      name: "full-plugins",
      testDir: "./e2e/full/plugins",
      timeout: coreTimeout,
      workers: 1,
      retries: isCI ? 2 : 0,
    },
    {
      name: "nightly",
      testDir: "./e2e/nightly",
      timeout: 600_000,
      retries: 0,
    },
    {
      // Design-review captures and the theme tour — run locally on demand.
      // Each spec self-skips unless its env var is set. 1800s because the
      // tour is interactive and some captures cold-launch several times;
      // we'd rather wait long than capture a half-painted panel.
      name: "screenshots",
      testDir: "./e2e/screenshots",
      timeout: 1_800_000,
      retries: 0,
    },
  ],
});
