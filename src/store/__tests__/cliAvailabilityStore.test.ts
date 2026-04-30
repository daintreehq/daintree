import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refreshMock, getMock, getDetailsMock, isElectronAvailableMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  getMock: vi.fn(),
  getDetailsMock: vi.fn().mockResolvedValue({}),
  isElectronAvailableMock: vi.fn(() => true),
}));

vi.mock("@/clients", () => ({
  cliAvailabilityClient: {
    get: getMock,
    refresh: refreshMock,
    getDetails: getDetailsMock,
  },
}));

vi.mock("@/hooks/useElectron", () => ({
  isElectronAvailable: isElectronAvailableMock,
}));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude", "gemini", "codex", "opencode", "cursor"],
}));

import { useCliAvailabilityStore, cleanupCliAvailabilityStore } from "../cliAvailabilityStore";

const defaultAvail = {
  claude: "missing",
  gemini: "missing",
  codex: "missing",
  opencode: "missing",
  cursor: "missing",
};
const installedAvail = {
  claude: "ready",
  gemini: "missing",
  codex: "ready",
  opencode: "missing",
  cursor: "installed",
};

describe("cliAvailabilityStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getDetails defaults to an empty map; tests that care about details
    // override this with mockResolvedValueOnce.
    getDetailsMock.mockResolvedValue({});
    cleanupCliAvailabilityStore();
  });

  afterEach(() => {
    cleanupCliAvailabilityStore();
  });

  describe("initialize", () => {
    it("performs a refresh on first init and sets availability", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);

      await useCliAvailabilityStore.getState().initialize();

      const state = useCliAvailabilityStore.getState();
      expect(state.availability).toEqual(installedAvail);
      expect(state.isLoading).toBe(false);
      expect(state.isInitialized).toBe(true);
      expect(state.error).toBeNull();
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("does not call refresh again when already initialized", async () => {
      refreshMock.mockResolvedValue(installedAvail);

      await useCliAvailabilityStore.getState().initialize();
      await useCliAvailabilityStore.getState().initialize();

      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent initialize calls", async () => {
      refreshMock.mockResolvedValue(installedAvail);

      await Promise.all([
        useCliAvailabilityStore.getState().initialize(),
        useCliAvailabilityStore.getState().initialize(),
        useCliAvailabilityStore.getState().initialize(),
      ]);

      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("sets lastCheckedAt on successful initialize", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      const before = Date.now();

      await useCliAvailabilityStore.getState().initialize();

      const state = useCliAvailabilityStore.getState();
      expect(state.lastCheckedAt).toBeGreaterThanOrEqual(before);
      expect(state.lastCheckedAt).toBeLessThanOrEqual(Date.now());
    });

    it("does not set lastCheckedAt on failed initialize", async () => {
      refreshMock.mockRejectedValueOnce(new Error("IPC failed"));

      await useCliAvailabilityStore.getState().initialize();

      expect(useCliAvailabilityStore.getState().lastCheckedAt).toBeNull();
    });

    it("sets error state when refresh fails", async () => {
      refreshMock.mockRejectedValueOnce(new Error("IPC failed"));

      await useCliAvailabilityStore.getState().initialize();

      const state = useCliAvailabilityStore.getState();
      expect(state.error).toBe("IPC failed");
      expect(state.isLoading).toBe(false);
      expect(state.isInitialized).toBe(true);
      expect(state.availability).toEqual(defaultAvail);
    });

    it("skips refresh when electron is not available", async () => {
      isElectronAvailableMock.mockReturnValueOnce(false);

      await useCliAvailabilityStore.getState().initialize();

      const state = useCliAvailabilityStore.getState();
      expect(refreshMock).not.toHaveBeenCalled();
      expect(state.isLoading).toBe(false);
      expect(state.isInitialized).toBe(true);
    });
  });

  describe("refresh", () => {
    it("updates availability on successful refresh", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);

      await useCliAvailabilityStore.getState().refresh();

      const state = useCliAvailabilityStore.getState();
      expect(state.availability).toEqual(installedAvail);
      expect(state.isRefreshing).toBe(false);
      expect(state.error).toBeNull();
    });

    it("sets lastCheckedAt on successful refresh", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      const before = Date.now();

      await useCliAvailabilityStore.getState().refresh();

      const state = useCliAvailabilityStore.getState();
      expect(state.lastCheckedAt).toBeGreaterThanOrEqual(before);
      expect(state.lastCheckedAt).toBeLessThanOrEqual(Date.now());
    });

    it("does not set lastCheckedAt on failed refresh", async () => {
      refreshMock.mockRejectedValueOnce(new Error("Network error"));

      await useCliAvailabilityStore
        .getState()
        .refresh()
        .catch(() => {});

      expect(useCliAvailabilityStore.getState().lastCheckedAt).toBeNull();
    });

    it("deduplicates concurrent refresh calls", async () => {
      let resolve: (v: typeof installedAvail) => void;
      const deferred = new Promise<typeof installedAvail>((r) => {
        resolve = r;
      });
      refreshMock.mockReturnValueOnce(deferred);

      const p1 = useCliAvailabilityStore.getState().refresh();
      const p2 = useCliAvailabilityStore.getState().refresh();

      resolve!(installedAvail);
      await Promise.all([p1, p2]);

      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("sets error and re-throws when refresh fails", async () => {
      refreshMock.mockRejectedValueOnce(new Error("Network error"));

      await expect(useCliAvailabilityStore.getState().refresh()).rejects.toThrow("Network error");

      const state = useCliAvailabilityStore.getState();
      expect(state.error).toBe("Network error");
      expect(state.isRefreshing).toBe(false);
    });

    it("allows subsequent refresh after failure", async () => {
      refreshMock.mockRejectedValueOnce(new Error("Network error"));
      await useCliAvailabilityStore
        .getState()
        .refresh()
        .catch(() => {});

      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().refresh();

      expect(useCliAvailabilityStore.getState().availability).toEqual(installedAvail);
      expect(useCliAvailabilityStore.getState().error).toBeNull();
    });

    it("skips refresh when electron is not available", async () => {
      isElectronAvailableMock.mockReturnValueOnce(false);

      await useCliAvailabilityStore.getState().refresh();

      expect(refreshMock).not.toHaveBeenCalled();
    });

    it("throttles a second refresh within 30s of a successful one", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_000_000);

      await useCliAvailabilityStore.getState().refresh();
      expect(refreshMock).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000_000 + 10_000);
      await useCliAvailabilityStore.getState().refresh();
      expect(refreshMock).toHaveBeenCalledTimes(1);

      nowSpy.mockRestore();
    });

    it("does not throttle after 30s have elapsed", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(2_000_000);

      await useCliAvailabilityStore.getState().refresh();
      expect(refreshMock).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(2_000_000 + 31_000);
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().refresh();
      expect(refreshMock).toHaveBeenCalledTimes(2);

      nowSpy.mockRestore();
    });

    it("does not throttle after a failed refresh (lastCheckedAt stays null)", async () => {
      refreshMock.mockRejectedValueOnce(new Error("boom"));
      await useCliAvailabilityStore
        .getState()
        .refresh()
        .catch(() => {});
      expect(refreshMock).toHaveBeenCalledTimes(1);

      // Failed refresh should not have set lastCheckedAt, so the throttle
      // should not fire and this call should go through.
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().refresh();
      expect(refreshMock).toHaveBeenCalledTimes(2);
    });

    it("force: true bypasses the 30s throttle", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(3_000_000);

      await useCliAvailabilityStore.getState().refresh();
      expect(refreshMock).toHaveBeenCalledTimes(1);

      // Within the throttle window; without force this would be skipped.
      nowSpy.mockReturnValue(3_000_000 + 5_000);
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().refresh(true);
      expect(refreshMock).toHaveBeenCalledTimes(2);

      nowSpy.mockRestore();
    });

    it("does not seed the throttle from cached lastCheckedAt on hydrate", async () => {
      // Arrange: a recent cache (inside the 30s throttle window if it were honoured).
      const fakeCache = {
        availability: installedAvail,
        lastCheckedAt: Date.now() - 1_000,
      };

      // Vitest runs this file under the Node environment, so there's no
      // browser `Storage` global to spy on. Stub `window.localStorage`
      // directly — the store loads the cache via `window.localStorage.getItem`.
      const getItem = vi.fn().mockReturnValueOnce(JSON.stringify(fakeCache));
      const setItem = vi.fn();
      vi.stubGlobal("window", { localStorage: { getItem, setItem } });

      try {
        // Init will hydrate from the cache but then fail the live probe, so
        // lastCheckedAt should remain null — any future refresh must still run.
        refreshMock.mockRejectedValueOnce(new Error("transient"));
        await useCliAvailabilityStore.getState().initialize();

        expect(useCliAvailabilityStore.getState().lastCheckedAt).toBeNull();
        // Cached availability should still have hydrated (hasRealData proves it).
        expect(useCliAvailabilityStore.getState().hasRealData).toBe(true);

        // The next refresh must not be throttled by the (stale) cache timestamp.
        refreshMock.mockResolvedValueOnce(installedAvail);
        await useCliAvailabilityStore.getState().refresh();
        expect(refreshMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("details", () => {
    it("populates details alongside availability on initialize", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockResolvedValueOnce({
        claude: { state: "ready", resolvedPath: "/usr/local/bin/claude", via: "which" },
        cursor: {
          state: "ready",
          resolvedPath: "/usr/local/bin/cursor-agent",
          via: "which",
          authConfirmed: false,
        },
      });

      await useCliAvailabilityStore.getState().initialize();

      const state = useCliAvailabilityStore.getState();
      expect(state.details.claude?.resolvedPath).toBe("/usr/local/bin/claude");
      expect(state.details.cursor?.authConfirmed).toBe(false);
    });

    it("leaves details as an empty map when getDetails IPC rejects on first init", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockRejectedValueOnce(new Error("ipc failed"));

      await useCliAvailabilityStore.getState().initialize();

      const state = useCliAvailabilityStore.getState();
      // Availability must still land; details failure is best-effort.
      expect(state.availability).toEqual(installedAvail);
      expect(state.details).toEqual({});
      expect(state.error).toBeNull();
    });

    it("preserves previous details when a subsequent getDetails IPC fails", async () => {
      // First refresh populates details.
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockResolvedValueOnce({
        claude: { state: "ready", resolvedPath: "/a", via: "which", authConfirmed: false },
      });
      await useCliAvailabilityStore.getState().initialize();
      expect(useCliAvailabilityStore.getState().details.claude?.authConfirmed).toBe(false);

      // Second refresh: availability ok, getDetails throws. Stale authConfirmed
      // must survive so a transient error doesn't suppress the sign-in nudge.
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockRejectedValueOnce(new Error("ipc blip"));
      await useCliAvailabilityStore.getState().refresh(true);

      const state = useCliAvailabilityStore.getState();
      expect(state.details.claude?.authConfirmed).toBe(false);
      expect(state.error).toBeNull();
    });

    it("refreshes details when refresh() is called", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockResolvedValueOnce({
        claude: { state: "ready", resolvedPath: "/a", via: "which", authConfirmed: false },
      });

      await useCliAvailabilityStore.getState().initialize();
      expect(useCliAvailabilityStore.getState().details.claude?.authConfirmed).toBe(false);

      // Force past the throttle so refresh actually re-runs.
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockResolvedValueOnce({
        claude: { state: "ready", resolvedPath: "/a", via: "which", authConfirmed: true },
      });
      await useCliAvailabilityStore.getState().refresh(true);

      expect(useCliAvailabilityStore.getState().details.claude?.authConfirmed).toBe(true);
    });
  });

  describe("cleanupCliAvailabilityStore", () => {
    it("resets store to initial state and clears in-flight promise", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();

      cleanupCliAvailabilityStore();

      const state = useCliAvailabilityStore.getState();
      expect(state.isInitialized).toBe(false);
      expect(state.isLoading).toBe(true);
      expect(state.lastCheckedAt).toBeNull();
      expect(state.availability).toEqual(defaultAvail);
      expect(state.details).toEqual({});

      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();
      expect(refreshMock).toHaveBeenCalledTimes(2);
    });
  });
});
