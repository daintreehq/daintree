import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/packagedLaunch", () => ({
  findPackagedExecutable: vi.fn(() => null),
  launchPackagedAndMeasure: vi.fn(),
}));

import { startupScenarios } from "../scenarios/startup";

describe("PERF-004 fail-closed behavior", () => {
  it("throws when no packaged binary is found instead of returning a sentinel", async () => {
    // Returning durationMs: -1 here let run.ts substitute wall-clock (~0ms)
    // and report PASS without ever launching a binary (#10068).
    const perf004 = startupScenarios.find((s) => s.id === "PERF-004");
    expect(perf004).toBeDefined();

    await expect(Promise.resolve(perf004!.run({ mode: "nightly", now: () => 0 }))).rejects.toThrow(
      /packaged binary not found/i
    );
  });
});
