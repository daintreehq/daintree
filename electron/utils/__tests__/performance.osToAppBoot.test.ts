import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function importPerformanceWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  return await import("../performance.js");
}

describe("osToAppBootMs", () => {
  beforeEach(() => {
    delete process.env.DAINTREE_PERF_SPAWN_WALL_MS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("returns null when DAINTREE_PERF_SPAWN_WALL_MS is missing", async () => {
    const mod = await importPerformanceWithEnv({ DAINTREE_PERF_SPAWN_WALL_MS: undefined });
    expect(mod.osToAppBootMs).toBeNull();
    expect(mod.getOsToAppBootMs()).toBeNull();
  });

  it("returns null when DAINTREE_PERF_SPAWN_WALL_MS is non-numeric", async () => {
    const mod = await importPerformanceWithEnv({ DAINTREE_PERF_SPAWN_WALL_MS: "not-a-number" });
    expect(mod.osToAppBootMs).toBeNull();
  });

  it("returns null when DAINTREE_PERF_SPAWN_WALL_MS is negative", async () => {
    const mod = await importPerformanceWithEnv({ DAINTREE_PERF_SPAWN_WALL_MS: "-1" });
    expect(mod.osToAppBootMs).toBeNull();
  });

  it("computes the wall-clock gap as (mainTimeOrigin + APP_BOOT_T0) - SPAWN_WALL_MS", async () => {
    // Anchor a synthetic spawn well in the past so the result must be a large
    // positive number — the precise value depends on `performance.timeOrigin`
    // captured at module load, which we inspect via the exported constants.
    const spawnWallMs = Date.now() - 5000;
    const mod = await importPerformanceWithEnv({
      DAINTREE_PERF_SPAWN_WALL_MS: String(spawnWallMs),
    });

    expect(mod.osToAppBootMs).not.toBeNull();
    const expected = mod.mainTimeOrigin + mod.APP_BOOT_T0 - spawnWallMs;
    expect(mod.osToAppBootMs).toBeCloseTo(expected, 6);
    // Sanity: the spawn was 5s ago so the gap must be at least ~5s.
    expect(mod.osToAppBootMs!).toBeGreaterThan(4000);
  });
});
