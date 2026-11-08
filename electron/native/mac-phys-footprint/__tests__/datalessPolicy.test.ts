import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Drives the compiled addon against the real kernel (#16361). The binary only
// exists on macOS after a native build, so elsewhere this skips.
const BINARY = path.resolve(__dirname, "../build/Release/mac_phys_footprint.node");
// A custom pool size would change how many workers there are to reach.
const canRun =
  process.platform === "darwin" &&
  existsSync(BINARY) &&
  process.env.UV_THREADPOOL_SIZE === undefined;

interface Addon {
  disableThreadPoolDatalessMaterialization(
    threads: number,
    timeoutMs: number
  ): Promise<{ requested: number; applied: number; errors: number[] }>;
}

describe.skipIf(!canRun)("disableThreadPoolDatalessMaterialization", () => {
  const addon = (canRun ? createRequire(__filename)(BINARY) : null) as Addon;

  it("reaches every libuv worker, one rendezvous each", async () => {
    const result = await addon.disableThreadPoolDatalessMaterialization(4, 1_000);
    expect(result).toEqual({ requested: 4, applied: 4, errors: [] });
  });

  it("stops at the barrier timeout when asked for more threads than the pool has", async () => {
    const startedAt = performance.now();
    const result = await addon.disableThreadPoolDatalessMaterialization(5, 200);
    expect(result.applied).toBe(4);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it("rejects arguments libuv could never satisfy", () => {
    expect(() => addon.disableThreadPoolDatalessMaterialization(0, 100)).toThrow(RangeError);
    expect(() => addon.disableThreadPoolDatalessMaterialization(2.5, 100)).toThrow(RangeError);
    expect(() => addon.disableThreadPoolDatalessMaterialization(4, -1)).toThrow(RangeError);
  });
});
