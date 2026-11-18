import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrateResult } from "../../../shared/types/ipc/app.js";
import {
  prefetchHydrateResult,
  consumePrefetchedHydrateResult,
  invalidatePrefetchCache,
  _resetPrefetchHydrateCacheForTests,
  _peekPrefetchCacheForTests,
} from "../prefetchHydrateCache.js";

function makeHydrate(projectId: string): HydrateResult {
  return {
    appState: {
      terminals: [],
      sidebarWidth: 350,
    } as unknown as HydrateResult["appState"],
    terminalConfig: {} as HydrateResult["terminalConfig"],
    project: {
      id: projectId,
      name: `Project ${projectId}`,
      path: `/p/${projectId}`,
      emoji: "🌲",
      lastOpened: 0,
    } as HydrateResult["project"],
    agentSettings: {} as HydrateResult["agentSettings"],
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    gpuDisabledReason: null,
    gpuAngleFallbackActive: false,
    safeMode: false,
    isWindowsStore: false,
    settingsRecovery: null,
    projectStateRecovery: null,
  };
}

beforeEach(() => {
  _resetPrefetchHydrateCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _resetPrefetchHydrateCacheForTests();
});

describe("prefetchHydrateCache", () => {
  it("singleflights concurrent calls for the same project", async () => {
    let resolve: ((v: HydrateResult) => void) | null = null;
    const build = vi.fn().mockImplementationOnce(
      () =>
        new Promise<HydrateResult>((r) => {
          resolve = r;
        })
    );

    const a = prefetchHydrateResult("p1", build);
    const b = prefetchHydrateResult("p1", build);

    expect(build).toHaveBeenCalledTimes(1);

    resolve!(makeHydrate("p1"));
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe(rb);
  });

  it("consumePrefetchedHydrateResult returns the value once and deletes it", async () => {
    await prefetchHydrateResult("p1", () => Promise.resolve(makeHydrate("p1")));

    const first = consumePrefetchedHydrateResult("p1");
    expect(first?.project?.id).toBe("p1");

    const second = consumePrefetchedHydrateResult("p1");
    expect(second).toBeUndefined();
  });

  it("returns undefined when the cache has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    await prefetchHydrateResult("p1", () => Promise.resolve(makeHydrate("p1")));

    // Advance just past the 30s TTL.
    vi.setSystemTime(new Date("2026-01-01T00:00:31Z"));

    const result = consumePrefetchedHydrateResult("p1");
    expect(result).toBeUndefined();
  });

  it("invalidatePrefetchCache(projectId) removes the entry", async () => {
    await prefetchHydrateResult("p1", () => Promise.resolve(makeHydrate("p1")));

    invalidatePrefetchCache("p1");

    expect(consumePrefetchedHydrateResult("p1")).toBeUndefined();
  });

  it("invalidatePrefetchCache() with no arg clears everything", async () => {
    await prefetchHydrateResult("p1", () => Promise.resolve(makeHydrate("p1")));
    await prefetchHydrateResult("p2", () => Promise.resolve(makeHydrate("p2")));

    invalidatePrefetchCache();

    expect(consumePrefetchedHydrateResult("p1")).toBeUndefined();
    expect(consumePrefetchedHydrateResult("p2")).toBeUndefined();
  });

  it("drops the result of an in-flight prefetch if invalidated mid-flight", async () => {
    let resolve: ((v: HydrateResult) => void) | null = null;
    const build = vi.fn().mockImplementationOnce(
      () =>
        new Promise<HydrateResult>((r) => {
          resolve = r;
        })
    );

    const pending = prefetchHydrateResult("p1", build);
    invalidatePrefetchCache("p1");
    resolve!(makeHydrate("p1"));
    const result = await pending;

    expect(result).toBeNull();
    expect(consumePrefetchedHydrateResult("p1")).toBeUndefined();
  });

  it("returns null and clears in-flight ref when build throws", async () => {
    const build = vi.fn().mockRejectedValueOnce(new Error("boom"));

    const result = await prefetchHydrateResult("p1", build);
    expect(result).toBeNull();
    expect(consumePrefetchedHydrateResult("p1")).toBeUndefined();

    // A second hover should not see a stuck in-flight ref.
    const second = await prefetchHydrateResult("p1", () => Promise.resolve(makeHydrate("p1")));
    expect(second?.project?.id).toBe("p1");
  });

  it("drops the result of an in-flight first-ever prefetch when globally invalidated", async () => {
    // Regression: invalidatePrefetchCache() (no arg) must bump version counters
    // for projects whose first-ever build is still in flight — otherwise that
    // build resolves with versionAtStart === currentVersion === 0 and commits
    // a stale payload even though every other consumer thinks the cache is
    // cleared.
    let resolve: ((v: HydrateResult) => void) | null = null;
    const build = vi.fn().mockImplementationOnce(
      () =>
        new Promise<HydrateResult>((r) => {
          resolve = r;
        })
    );

    const pending = prefetchHydrateResult("p1", build);
    invalidatePrefetchCache();
    resolve!(makeHydrate("p1"));
    const result = await pending;

    expect(result).toBeNull();
    expect(consumePrefetchedHydrateResult("p1")).toBeUndefined();
  });

  it("caches different projects independently", async () => {
    await prefetchHydrateResult("p1", () => Promise.resolve(makeHydrate("p1")));
    await prefetchHydrateResult("p2", () => Promise.resolve(makeHydrate("p2")));

    expect(consumePrefetchedHydrateResult("p1")?.project?.id).toBe("p1");
    expect(consumePrefetchedHydrateResult("p2")?.project?.id).toBe("p2");
  });

  describe("completed entries (#17803)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    it("reuses a still-valid entry instead of rebuilding on a later hover", async () => {
      const build = vi.fn((id: string) => Promise.resolve(makeHydrate(id)));

      const first = await prefetchHydrateResult("p1", build);
      // The switcher allows another hover once its 15s freshness window lapses.
      await vi.advanceTimersByTimeAsync(16_000);
      const second = await prefetchHydrateResult("p1", build);

      expect(build).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(consumePrefetchedHydrateResult("p1")).toBe(first);
    });

    it("rebuilds once the entry has expired", async () => {
      const build = vi.fn((id: string) => Promise.resolve(makeHydrate(id)));

      const first = await prefetchHydrateResult("p1", build);
      await vi.advanceTimersByTimeAsync(31_000);
      const second = await prefetchHydrateResult("p1", build);

      expect(build).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
      expect(consumePrefetchedHydrateResult("p1")).toBe(second);
    });

    it("rebuilds after a save invalidates a completed entry", async () => {
      const build = vi.fn((id: string) => Promise.resolve(makeHydrate(id)));

      const first = await prefetchHydrateResult("p1", build);
      invalidatePrefetchCache("p1");
      const second = await prefetchHydrateResult("p1", build);

      expect(build).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
    });

    it("avoids the redundant build and releases unconsumed payloads without another visit", async () => {
      const build = vi.fn((id: string) => Promise.resolve(makeHydrate(id)));
      const ids = Array.from({ length: 100 }, (_, i) => `p${i}`);

      for (const id of ids) {
        await prefetchHydrateResult(id, build);
      }
      await vi.advanceTimersByTimeAsync(16_000);
      await prefetchHydrateResult("p0", build);

      expect(build).toHaveBeenCalledTimes(100);

      await vi.advanceTimersByTimeAsync(60_000);

      for (const id of ids) {
        expect(_peekPrefetchCacheForTests(id)).toBeUndefined();
      }
    });

    it("does not let an earlier entry's expiry evict the entry that replaced it", async () => {
      const build = vi.fn((id: string) => Promise.resolve(makeHydrate(id)));

      await prefetchHydrateResult("p1", build);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(consumePrefetchedHydrateResult("p1")).toBeDefined();
      const replacement = await prefetchHydrateResult("p1", build);

      // Past the first entry's expiry, well inside the replacement's.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(_peekPrefetchCacheForTests("p1")).toBe(replacement);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(_peekPrefetchCacheForTests("p1")).toBeUndefined();
    });

    it("still drops a build that a save overtook while an older entry was being replaced", async () => {
      let resolve: ((v: HydrateResult) => void) | null = null;
      const build = vi
        .fn((id: string) => Promise.resolve(makeHydrate(id)))
        .mockImplementationOnce(() => Promise.resolve(makeHydrate("p1")))
        .mockImplementationOnce(
          () =>
            new Promise<HydrateResult>((r) => {
              resolve = r;
            })
        );

      await prefetchHydrateResult("p1", build);
      await vi.advanceTimersByTimeAsync(31_000);
      const pending = prefetchHydrateResult("p1", build);
      invalidatePrefetchCache("p1");
      resolve!(makeHydrate("p1"));

      expect(await pending).toBeNull();
      expect(_peekPrefetchCacheForTests("p1")).toBeUndefined();
    });
  });
});
