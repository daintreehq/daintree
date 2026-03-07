import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refreshMock, getMock, isElectronAvailableMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  getMock: vi.fn(),
  isElectronAvailableMock: vi.fn(() => true),
}));

vi.mock("@/clients", () => ({
  cliAvailabilityClient: {
    get: getMock,
    refresh: refreshMock,
  },
}));

vi.mock("@/hooks/useElectron", () => ({
  isElectronAvailable: isElectronAvailableMock,
}));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude", "gemini", "codex", "opencode"],
}));

import { useCliAvailabilityStore, cleanupCliAvailabilityStore } from "../cliAvailabilityStore";

const defaultAvail = { claude: false, gemini: false, codex: false, opencode: false };
const installedAvail = { claude: true, gemini: false, codex: true, opencode: false };

describe("cliAvailabilityStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  describe("cleanupCliAvailabilityStore", () => {
    it("resets store to initial state and clears in-flight promise", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();

      cleanupCliAvailabilityStore();

      const state = useCliAvailabilityStore.getState();
      expect(state.isInitialized).toBe(false);
      expect(state.isLoading).toBe(true);
      expect(state.availability).toEqual(defaultAvail);

      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();
      expect(refreshMock).toHaveBeenCalledTimes(2);
    });
  });
});
