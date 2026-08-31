import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/packagedLaunch", () => ({
  findPackagedExecutable: vi.fn(() => null),
  launchPackagedAndMeasure: vi.fn(),
}));

import { findPackagedExecutable, launchPackagedAndMeasure } from "../lib/packagedLaunch";
import { startupScenarios } from "../scenarios/startup";

const mockedFind = vi.mocked(findPackagedExecutable);
const mockedLaunch = vi.mocked(launchPackagedAndMeasure);

function getPerf004() {
  const scenario = startupScenarios.find((s) => s.id === "PERF-004");
  expect(scenario).toBeDefined();
  return scenario!;
}

const context = { mode: "nightly" as const, now: () => 0 };

describe("PERF-004 fail-closed behavior", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws when no packaged binary is found instead of returning a sentinel", async () => {
    // Returning durationMs: -1 here let run.ts substitute wall-clock (~0ms)
    // and report PASS without ever launching a binary (#10068).
    mockedFind.mockReturnValue(null);

    await expect(Promise.resolve(getPerf004().run(context))).rejects.toThrow(
      /packaged binary not found/i
    );
  });

  it("throws when the launch succeeded but boot marks were not captured (degraded wall-clock)", async () => {
    // A degraded result means the NDJSON mark pipeline never produced
    // APP_BOOT_START → RENDERER_READY — the wall-clock substitute is not the
    // mark-to-mark cold start this scenario measures, so it must not PASS.
    mockedFind.mockReturnValue("/fake/release/linux-unpacked/daintree");
    mockedLaunch.mockResolvedValue({
      durationMs: 5200,
      metrics: { wallClockMs: 5200 },
      ndjsonPath: "/tmp/perf-metrics.ndjson",
      notes: "RENDERER_READY mark not captured — using wall-clock fallback",
      degraded: true,
      cacheKind: "cold",
    });

    await expect(Promise.resolve(getPerf004().run(context))).rejects.toThrow(
      /boot marks were not captured/i
    );
  });

  it("returns the measured duration for a healthy launch", async () => {
    mockedFind.mockReturnValue("/fake/release/linux-unpacked/daintree");
    mockedLaunch.mockResolvedValue({
      durationMs: 1850,
      metrics: { rendererReadyMs: 1400 },
      ndjsonPath: "/tmp/perf-metrics.ndjson",
      cacheKind: "cold",
    });

    const sample = await getPerf004().run(context);

    expect(sample.durationMs).toBe(1850);
    expect(sample.metrics?.rendererReadyMs).toBe(1400);
  });
});

/**
 * PERF-001..003 used to hydrate through `simulateLayoutHydration` — a `Map.set`
 * loop with a string-length checksum, reaching no product code. These guard
 * that they now drive the real `statePatcher` restore builders, that every
 * restore route is actually taken (an untaken route makes its own predicate
 * term vacuously zero), and that every predicate is emitted on every run.
 */
describe("PERF-001..003 drive the real hydration builders", () => {
  const hydrationContext = { mode: "ci" as const, now: () => performance.now() };

  function startupScenario(id: string) {
    const found = startupScenarios.find((candidate) => candidate.id === id);
    expect(found, `${id} is not registered`).toBeDefined();
    return found!;
  }

  it.each([
    ["PERF-001", 10],
    ["PERF-002", 260],
    ["PERF-003", 260],
  ])(
    "%s restores every planned panel with a clean predicate",
    async (id, expectedPanels) => {
      const scenario = startupScenario(id as string);
      const sample = await scenario.run(hydrationContext);
      const metrics = sample.metrics!;

      expect(metrics.restoredPanels).toBe(expectedPanels);
      expect(metrics.backendRestoreCount).toBeGreaterThan(0);
      expect(metrics.respawnResumeCount).toBeGreaterThan(0);
      expect(metrics.respawnWithheldCount).toBeGreaterThan(0);
      expect(metrics.nonPtyRestoreCount).toBeGreaterThan(0);
      expect(metrics.orphanAdoptionCount).toBeGreaterThan(0);

      for (const name of scenario.correctness!) {
        expect(metrics[name], `${id}.${name}`).toBe(0);
      }
      expect(Number.isFinite(sample.durationMs)).toBe(true);
      expect(sample.durationMs).toBeGreaterThan(0);
    },
    30_000
  );
});
