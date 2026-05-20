// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loadOverridesMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    loadOverrides: () => loadOverridesMock(),
  },
}));

vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: {
    getState: () => ({ initialize: initializeMock }),
  },
}));

const { ensureHydrationBootstrap, __resetBootstrapForTests } = await import("../bootstrapGuard");

beforeEach(() => {
  loadOverridesMock.mockReset();
  initializeMock.mockReset();
  loadOverridesMock.mockResolvedValue(undefined);
  initializeMock.mockResolvedValue(undefined);
  __resetBootstrapForTests();
});

describe("ensureHydrationBootstrap", () => {
  it("invokes the bootstrap once when called concurrently", async () => {
    const calls = await Promise.all([
      ensureHydrationBootstrap(),
      ensureHydrationBootstrap(),
      ensureHydrationBootstrap(),
    ]);
    expect(calls).toEqual([undefined, undefined, undefined]);
    expect(loadOverridesMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the resolved promise on subsequent calls", async () => {
    await ensureHydrationBootstrap();
    await ensureHydrationBootstrap();
    expect(loadOverridesMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("clears the singleton on failure so the next call retries", async () => {
    loadOverridesMock.mockRejectedValueOnce(new Error("boom"));

    await expect(ensureHydrationBootstrap()).rejects.toThrow("boom");

    // Second call should re-attempt
    loadOverridesMock.mockResolvedValueOnce(undefined);
    await ensureHydrationBootstrap();

    expect(loadOverridesMock).toHaveBeenCalledTimes(2);
    // initialize() runs concurrently with loadOverrides() via Promise.all,
    // so it fires on the failing first attempt too: 1 (failed call) + 1 (retry).
    expect(initializeMock).toHaveBeenCalledTimes(2);
  });

  it("propagates initialize() rejections and clears the singleton", async () => {
    initializeMock.mockRejectedValueOnce(new Error("init fail"));

    await expect(ensureHydrationBootstrap()).rejects.toThrow("init fail");

    initializeMock.mockResolvedValueOnce(undefined);
    await ensureHydrationBootstrap();

    expect(loadOverridesMock).toHaveBeenCalledTimes(2);
    expect(initializeMock).toHaveBeenCalledTimes(2);
  });

  describe("perf instrumentation", () => {
    beforeEach(() => {
      window.__DAINTREE_PERF_MARKS__ = [];
    });

    afterEach(() => {
      delete window.__DAINTREE_PERF_MARKS__;
    });

    function bootstrapMarks(): string[] {
      return (window.__DAINTREE_PERF_MARKS__ ?? [])
        .map((entry) => entry.mark)
        .filter(
          (mark) =>
            typeof mark === "string" &&
            (mark.startsWith("hydrate_bootstrap_load_overrides") ||
              mark.startsWith("hydrate_bootstrap_init_user_agents"))
        );
    }

    it("emits start/end spans for both steps on cold start", async () => {
      await ensureHydrationBootstrap();

      const marks = bootstrapMarks();
      // Both steps run concurrently via Promise.all, so start marks fire before
      // either end mark. Assert membership + per-step ordering instead of a
      // single fixed sequence.
      expect(marks).toContain("hydrate_bootstrap_load_overrides:start");
      expect(marks).toContain("hydrate_bootstrap_load_overrides:end");
      expect(marks).toContain("hydrate_bootstrap_init_user_agents:start");
      expect(marks).toContain("hydrate_bootstrap_init_user_agents:end");
      expect(marks.indexOf("hydrate_bootstrap_load_overrides:start")).toBeLessThan(
        marks.indexOf("hydrate_bootstrap_load_overrides:end")
      );
      expect(marks.indexOf("hydrate_bootstrap_init_user_agents:start")).toBeLessThan(
        marks.indexOf("hydrate_bootstrap_init_user_agents:end")
      );
    });

    it("does not re-emit step marks on a cached call", async () => {
      await ensureHydrationBootstrap();
      window.__DAINTREE_PERF_MARKS__ = [];

      await ensureHydrationBootstrap();

      expect(bootstrapMarks()).toEqual([]);
    });

    it("emits start + end for both spans when loadOverrides fails (steps run in parallel)", async () => {
      loadOverridesMock.mockRejectedValueOnce(new Error("boom"));

      await expect(ensureHydrationBootstrap()).rejects.toThrow("boom");

      // init_user_agents() runs concurrently with loadOverrides() via Promise.all,
      // so its span still fires even when loadOverrides rejects.
      const marks = bootstrapMarks();
      expect(marks).toContain("hydrate_bootstrap_load_overrides:start");
      expect(marks).toContain("hydrate_bootstrap_load_overrides:end");
      expect(marks).toContain("hydrate_bootstrap_init_user_agents:start");
      expect(marks).toContain("hydrate_bootstrap_init_user_agents:end");
    });
  });
});
