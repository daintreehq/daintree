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
