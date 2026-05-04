import { describe, it, expect, vi, beforeEach } from "vitest";

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
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("propagates initialize() rejections and clears the singleton", async () => {
    initializeMock.mockRejectedValueOnce(new Error("init fail"));

    await expect(ensureHydrationBootstrap()).rejects.toThrow("init fail");

    initializeMock.mockResolvedValueOnce(undefined);
    await ensureHydrationBootstrap();

    expect(loadOverridesMock).toHaveBeenCalledTimes(2);
    expect(initializeMock).toHaveBeenCalledTimes(2);
  });
});
