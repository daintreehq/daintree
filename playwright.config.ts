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
// launchOpenCodeReady can run its ready-wait twice (the CLI self-updates and
// asks for a restart), so the per-test budget has to clear two cold starts at
// the platform's ready-state deadline — see waitForOpenCodeReady.
const onlineTimeout = isWindowsCI ? 480_000 : isCI ? 420_000 : 300_000;

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
const reporter: ReporterDescription[] | undefined =
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
  // FAIL_ON_FLAKY_TESTS so only release-gating suites (core, online) enable
  // it in CI. full-* buckets keep retries without a flake gate for PR velocity.
  failOnFlakyTests: process.env.FAIL_ON_FLAKY_TESTS === "true",
  expect: { timeout: isWindowsCI ? 15_000 : isCI ? 10_000 : 5_000 },
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
      // `npx playwright test --project=full-plugins`. Mirrors the `demo`
      // bucket's mitigation for the same crashpad exhaustion.
      name: "full-plugins",
      testDir: "./e2e/full/plugins",
      timeout: coreTimeout,
      workers: 1,
      retries: isCI ? 2 : 0,
    },
    {
      // Real agent CLIs read and write runner-global configuration under the
      // user's home directory. Concurrent online specs can overlap app
      // shutdown with the next CLI launch and leave that shared state unusable
      // for the rest of the job, so keep the release-gating online surface
      // serial on every platform.
      name: "online",
      testDir: "./e2e/online",
      timeout: onlineTimeout,
      workers: 1,
      retries: isCI ? 1 : 0,
    },
    {
      name: "nightly",
      testDir: "./e2e/nightly",
      timeout: 600_000,
      retries: 0,
    },
    {
      // Marketing screenshot pipeline — runs on demand via
      // .github/workflows/screenshots.yml. Each spec opens a separate demo
      // repo, drives a deterministic UI state, and writes a PNG to
      // artifacts/screenshots/. Real Anthropic API calls happen for the
      // agent-state shots, so flake is non-zero; we surface failures rather
      // than retry them (the workflow is manually rerun).
      //
      // 1800s (30 min) per scene — multi-agent + heavy fixed waits eat
      // budget on Windows cold launches. We'd rather wait long than
      // ship a screenshot of a half-painted panel.
      name: "screenshots",
      testDir: "./e2e/screenshots",
      timeout: 1_800_000,
      retries: 0,
    },
    {
      // Demo-engine pipeline — exercises the in-app demo automation API
      // (window.electron.demo) to record screencasts and drive scripted
      // terminal input. Runs on demand via the `demo` suite in
      // .github/workflows/e2e.yml; not a release gate.
      //
      // workers:1 is mandatory and baked into the project (not a CLI flag):
      // these specs cold-launch Electron and record at 4K, so parallel
      // workers contend on the crashpad Mach port and the shared demo repo
      // fixtures. Keeping it here guarantees serialization even for a bare
      // local `npx playwright test --project=demo`.
      //
      // 1800s (30 min) — demo recording choreography plus Electron cold
      // launch on Windows justifies the same budget as `screenshots`.
      name: "demo",
      testDir: "./e2e/demo",
      timeout: 1_800_000,
      workers: 1,
      retries: 0,
    },
  ],
});
