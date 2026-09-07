import { describe, expect, it } from "vitest";
import { idleWindowScenarios } from "../scenarios/idleWindow";
import {
  createProcessTreeHarness,
  closeIdleWindow,
  installProcessProbeFault,
  openIdleWindow,
  processProbeSpawnCount,
  processProbeWorks,
  removeProcessProbeFault,
  spawnProbeChild,
  waitForProcessDiscovery,
} from "../lib/idleFixture";
import { sleep } from "../lib/gitPipelineFixture";
import { classifyMetric, isMachineIndependent } from "../lib/comparability";

/** Wait for one more completed poll, i.e. drain whatever is in flight. */
async function waitForRefresh(harness: { refreshCount: () => number }): Promise<boolean> {
  const before = harness.refreshCount();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && harness.refreshCount() === before) {
    await sleep(25);
  }
  return harness.refreshCount() > before;
}

/**
 * These scenarios idle real services for 15-25s each, so running them here
 * would make the unit suite a perf run. What the suite guards instead is the
 * apparatus: that the fixture drives real product code, that the fault
 * injection genuinely breaks the probe, and that every count metric is named
 * so `comparability` reads it as a count rather than a duration — a naming
 * slip is silent at runtime and costs the metric its cross-machine
 * comparison.
 */

const COUNT_METRICS = [
  "idleProbeSpawns",
  "idleSubprocessSpawns",
  "idleRefreshCallbacks",
  "idleGitSpawns",
  "idleSnapshotEvents",
  "monitorCount",
  "faultProbeSpawns",
  "faultSubprocessSpawns",
  "healedProbeSpawns",
  "healedSubprocessSpawns",
  "residualProbeSpawns",
  "residualSubprocessSpawns",
  "residualGitSpawns",
  "discoveryMisses",
  "detectionMisses",
  "refreshMisses",
  "recoveryMisses",
  "postHealDiscoveryMisses",
  "preFaultRefreshMisses",
  "faultInjectionMisses",
  "faultStateMisses",
  "pollTickMisses",
  "warmMisses",
  "populationMisses",
  "settleMisses",
];

const RATIO_METRICS = ["gitSpawnsPerMonitor"];

// Event-loop utilization over a wall-clock window, however it is spelled. A
// slower CPU raises it for identical work, so it is a reading about this
// machine and comparing it to another machine's is not a finding.
const DERIVED_RATIO_METRICS = ["idleEluPct", "healedEluPct"];

const DURATION_METRICS = [
  "idleCpuMs",
  "faultCpuMs",
  "healedCpuMs",
  "cpuMsPerIdleSec",
  "backoffIntervalMs",
  "faultBackoffIntervalMs",
  "healedBackoffIntervalMs",
  "discoveryMs",
  "detectionMs",
  "recoveryMs",
  "postHealDiscoveryMs",
];

describe("idleWindow scenario declarations", () => {
  it("declares PERF-092/093/094 and nothing else", () => {
    expect(idleWindowScenarios.map((s) => s.id)).toEqual(["PERF-092", "PERF-093", "PERF-094"]);
  });

  it("reports counts as the headline, so durationMs is the self-timed sentinel", () => {
    for (const scenario of idleWindowScenarios) {
      expect(scenario.tier).toBe("heavy");
      expect(scenario.warmups).toBe(1);
    }
  });
});

describe("idleWindow metric naming", () => {
  it("classifies every count metric as machine-independent", () => {
    for (const name of COUNT_METRICS) {
      expect(`${name}:${classifyMetric(name)}`).toBe(`${name}:count`);
      expect(isMachineIndependent(classifyMetric(name))).toBe(true);
    }
  });

  it("classifies the normalised metrics as ratios", () => {
    for (const name of RATIO_METRICS) {
      expect(`${name}:${classifyMetric(name)}`).toBe(`${name}:ratio`);
      expect(isMachineIndependent(classifyMetric(name))).toBe(true);
    }
  });

  it("keeps event-loop utilization machine-dependent under either spelling", () => {
    for (const name of DERIVED_RATIO_METRICS) {
      expect(`${name}:${classifyMetric(name)}`).toBe(`${name}:derived-ratio`);
      expect(isMachineIndependent(classifyMetric(name))).toBe(false);
    }
  });

  it("classifies every time reading as a duration, never a count", () => {
    for (const name of DURATION_METRICS) {
      expect(`${name}:${classifyMetric(name)}`).toBe(`${name}:duration`);
      expect(isMachineIndependent(classifyMetric(name))).toBe(false);
    }
  });
});

describe("idleFixture drives the real ProcessTreeCache", () => {
  it("spawns real probes over an idle window, discovers a live child, and stops cleanly", async () => {
    // Include startup: Windows reuses its census helper after the first spawn.
    const window = openIdleWindow();
    const harness = await createProcessTreeHarness(300);
    let child: ReturnType<typeof spawnProbeChild> | null = null;
    try {
      expect(await waitForRefresh(harness)).toBe(true);

      // Wait for product work rather than assuming two PowerShell probes fit
      // inside a 1.5s wall-clock sleep on a loaded Windows runner.
      expect(await waitForRefresh(harness)).toBe(true);
      const reading = closeIdleWindow(window);

      // Real work happened — the counters see the product's own `ps` /
      // `powershell` starts and the refresh callback sees the parse complete.
      // Windows accounts process CPU in coarse ticks, so this short apparatus
      // window can honestly round the in-process parse cost down to zero. The
      // 15-second benchmark windows retain the useful CPU reading; this guard
      // checks that the short reading is valid rather than setting a timing
      // threshold on a shared runner.
      expect(processProbeSpawnCount(reading.byExecutable)).toBeGreaterThan(0);
      expect(Number.isFinite(reading.cpuMs)).toBe(true);
      expect(reading.cpuMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(reading.cpuMsPerIdleSec)).toBe(true);
      expect(harness.refreshCount()).toBeGreaterThan(1);

      // The paired reading the scenarios depend on: a real subprocess started
      // AFTER the window is still found, so the poller is alive rather than
      // sitting on a stale snapshot.
      child = spawnProbeChild(20_000);
      expect(child.pid).not.toBeNull();
      expect(await waitForProcessDiscovery(harness.cache, child.pid!, 20_000)).not.toBeNull();

      harness.stop();
      const after = openIdleWindow();
      await sleep(1500);
      expect(processProbeSpawnCount(closeIdleWindow(after).byExecutable)).toBe(0);
    } finally {
      harness.stop();
      child?.kill();
    }
  }, 90_000);
});

describe("idleFixture probe fault", () => {
  it("breaks the probe the product resolves, then heals it", () => {
    expect(processProbeWorks()).toBe(true);
    const fault = installProcessProbeFault();
    try {
      expect(processProbeWorks()).toBe(false);
    } finally {
      removeProcessProbeFault(fault);
    }
    expect(processProbeWorks()).toBe(true);
  }, 60_000);

  it("blinds the real cache while it is live, and the cache recovers when it heals", async () => {
    const harness = await createProcessTreeHarness(300);
    let fault: ReturnType<typeof installProcessProbeFault> | null = null;
    let child: ReturnType<typeof spawnProbeChild> | null = null;
    try {
      expect(await waitForRefresh(harness)).toBe(true);
      expect(harness.isHealthy()).toBe(true);
      fault = installProcessProbeFault(harness.cache.getCensusHelperPid());
      // A poll that started before the shim went in resolves against a healthy
      // `ps`, and `ps` enumerates when it actually execs — late enough to list
      // a child spawned microseconds after the shim. Draining that poll first
      // is what makes the blindness assertion below mean anything, and is why
      // PERF-093 does the same before it spawns its probe.
      expect(await waitForRefresh(harness)).toBe(true);
      child = spawnProbeChild(20_000);

      // Long enough for several poll attempts against the failing shim.
      await sleep(2000);
      expect(harness.cache.getProcess(child.pid!)).toBeUndefined();
      // Blindness alone is also what a poller that simply stopped looks like.
      // The service's own error record is what separates the two, and is the
      // reading PERF-093 folds into `faultStateMisses`.
      expect(harness.hasObservedFailure()).toBe(true);
      expect(harness.isHealthy()).toBe(false);

      removeProcessProbeFault(fault);
      expect(await waitForProcessDiscovery(harness.cache, child.pid!, 20_000)).not.toBeNull();
    } finally {
      if (fault) removeProcessProbeFault(fault);
      harness.stop();
      child?.kill();
    }
  }, 60_000);
});
