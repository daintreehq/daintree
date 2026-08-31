import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/packagedLaunch", () => ({
  findPackagedExecutable: vi.fn(() => null),
  launchPackagedAndMeasure: vi.fn(),
}));

import { findPackagedExecutable, launchPackagedAndMeasure } from "../lib/packagedLaunch";
import { startupScenarios } from "../scenarios/startup";
import {
  buildHydrationPlan,
  hydrationRoundTripMisses,
  parseHydrationPanels,
  serializeHydrationPanels,
  withParsedPanels,
} from "../lib/hydrationFixture";

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

/**
 * PERF-001/002 time a deserialize. It used to be discarded — hydration read the
 * in-memory plan — so deleting `JSON.parse` was a free speedup that moved no
 * correctness term. These pin the round trip as load-bearing.
 */
describe("the startup deserialize feeds hydration", () => {
  const plan = buildHydrationPlan("round-trip", 40, 4);

  it("scores zero for a real round trip and feeds hydration the parsed panels", () => {
    const parsed = parseHydrationPanels(serializeHydrationPanels(plan));
    expect(hydrationRoundTripMisses(plan, parsed)).toBe(0);

    const runtime = withParsedPanels(plan, parsed);
    expect(runtime.panels).toHaveLength(plan.panels.length);
    for (let i = 0; i < runtime.panels.length; i += 1) {
      // The subject reads these. They are the parse's objects, not the plan's.
      expect(runtime.panels[i].saved).toBe(parsed[i]);
      expect(runtime.panels[i].saved).not.toBe(plan.panels[i].saved);
    }
  });

  it("scores a parse that was skipped, which is what a deletion leaves behind", () => {
    // Exactly the reviewer's deletion: hydration hands on the in-memory
    // snapshots. Same ids, same count — and the term still has to speak.
    const skipped = plan.panels.map((planned) => planned.saved);
    expect(hydrationRoundTripMisses(plan, skipped)).toBeGreaterThan(0);
  });

  it("scores a clone that kept the in-memory key shape", () => {
    // structuredClone clears the identity half; only the on-disk key shape
    // separates it from a real deserialize, and undefined-valued keys are the
    // difference.
    const cloned = plan.panels.map((planned) => structuredClone(planned.saved));
    expect(hydrationRoundTripMisses(plan, cloned)).toBeGreaterThan(0);
  });

  it("scores a parse that came back short or came back wrong", () => {
    const parsed = parseHydrationPanels(serializeHydrationPanels(plan));
    expect(hydrationRoundTripMisses(plan, parsed.slice(0, 10))).toBeGreaterThan(0);
    expect(hydrationRoundTripMisses(plan, [])).toBe(plan.panels.length);
    // Two panels swapped: both fail the id check, and both fail the key-shape
    // check as well because their snapshots carry different optional fields.
    const shuffled = [parsed[1], parsed[0], ...parsed.slice(2)];
    expect(hydrationRoundTripMisses(plan, shuffled)).toBeGreaterThanOrEqual(2);
  });

  it("PERF-001/002 declare parseMisses and PERF-003 does not", () => {
    const declares = (id: string): boolean =>
      (startupScenarios.find((s) => s.id === id)?.correctness ?? []).includes("parseMisses");
    expect(declares("PERF-001")).toBe(true);
    expect(declares("PERF-002")).toBe(true);
    // PERF-003 is the warm path with the deserialize removed on purpose; a
    // predicate for an operation it does not perform would be a decorative 0.
    expect(declares("PERF-003")).toBe(false);
  });
});
