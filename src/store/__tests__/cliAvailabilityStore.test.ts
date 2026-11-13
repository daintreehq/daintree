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
import { whenCliHostSynced } from "../cliHostSync";

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

  describe("recheck", () => {
    const rechecked = { ...installedAvail, gemini: "ready" };

    function deferProbe() {
      let resolve!: (value: typeof installedAvail) => void;
      refreshMock.mockReturnValueOnce(
        new Promise<typeof installedAvail>((r) => {
          resolve = r;
        })
      );
      return (value: typeof installedAvail) => resolve(value);
    }

    it("probes at once when no probe is running", async () => {
      refreshMock.mockResolvedValueOnce(rechecked);

      await useCliAvailabilityStore.getState().recheck();

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(useCliAvailabilityStore.getState().availability).toEqual(rechecked);
    });

    it("probes again after a refresh already running instead of taking its answer", async () => {
      const finishRunning = deferProbe();
      refreshMock.mockResolvedValueOnce(rechecked);
      const running = useCliAvailabilityStore.getState().refresh(true);

      const recheck = useCliAvailabilityStore.getState().recheck();
      await Promise.resolve();
      expect(refreshMock).toHaveBeenCalledTimes(1);

      finishRunning(installedAvail);
      await Promise.all([running, recheck]);

      expect(refreshMock).toHaveBeenCalledTimes(2);
      expect(useCliAvailabilityStore.getState().availability).toEqual(rechecked);
    });

    it("probes again after a running initialize", async () => {
      const finishInit = deferProbe();
      refreshMock.mockResolvedValueOnce(rechecked);
      const init = useCliAvailabilityStore.getState().initialize();

      const recheck = useCliAvailabilityStore.getState().recheck();
      finishInit(installedAvail);
      await Promise.all([init, recheck]);

      expect(refreshMock).toHaveBeenCalledTimes(2);
      expect(useCliAvailabilityStore.getState().availability).toEqual(rechecked);
    });

    it("still probes again when the running probe fails", async () => {
      refreshMock.mockRejectedValueOnce(new Error("probe failed"));
      refreshMock.mockResolvedValueOnce(rechecked);
      const running = useCliAvailabilityStore.getState().refresh(true);

      const recheck = useCliAvailabilityStore.getState().recheck();
      await expect(running).rejects.toThrow("probe failed");
      await recheck;

      expect(refreshMock).toHaveBeenCalledTimes(2);
      expect(useCliAvailabilityStore.getState().availability).toEqual(rechecked);
    });

    it("shares one probe among calls made while it waits", async () => {
      const finishRunning = deferProbe();
      refreshMock.mockResolvedValueOnce(rechecked);
      const running = useCliAvailabilityStore.getState().refresh(true);

      const first = useCliAvailabilityStore.getState().recheck();
      const second = useCliAvailabilityStore.getState().recheck();
      expect(second).toBe(first);

      finishRunning(installedAvail);
      await Promise.all([running, first, second]);

      expect(refreshMock).toHaveBeenCalledTimes(2);
    });

    it("waits out its own probe for a call made once that probe has started", async () => {
      const finishRunning = deferProbe();
      const finishRecheck = deferProbe();
      const later = { ...rechecked, opencode: "ready" };
      refreshMock.mockResolvedValueOnce(later);
      const running = useCliAvailabilityStore.getState().refresh(true);
      const first = useCliAvailabilityStore.getState().recheck();

      finishRunning(installedAvail);
      await running;
      await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2));

      const second = useCliAvailabilityStore.getState().recheck();
      expect(second).not.toBe(first);
      finishRecheck(rechecked);
      await Promise.all([first, second]);

      expect(refreshMock).toHaveBeenCalledTimes(3);
      expect(useCliAvailabilityStore.getState().availability).toEqual(later);
    });

    it("doesn't probe once the store is cleaned up while it waits", async () => {
      const finishRunning = deferProbe();
      const running = useCliAvailabilityStore.getState().refresh(true);
      const recheck = useCliAvailabilityStore.getState().recheck();

      cleanupCliAvailabilityStore();
      finishRunning(installedAvail);
      await Promise.all([running, recheck]);

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(useCliAvailabilityStore.getState().hasRealData).toBe(false);
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

  describe("syncFromHost (#16399)", () => {
    const chosenAvail = { ...installedAvail, claude: "missing" };
    const chosenDetails = {
      claude: {
        state: "missing",
        resolvedPath: null,
        via: null,
        chosenPath: "/gone/claude",
      },
    };

    it("takes the host's latest check without probing again", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();
      getMock.mockResolvedValueOnce(chosenAvail);
      getDetailsMock.mockResolvedValueOnce(chosenDetails);

      await useCliAvailabilityStore.getState().syncFromHost();

      const state = useCliAvailabilityStore.getState();
      expect(state.availability).toEqual(chosenAvail);
      expect(state.details).toEqual(chosenDetails);
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("lets a refresh begun before the change finish first, so its older answer can't land last", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();

      let finishRefresh!: (value: unknown) => void;
      refreshMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finishRefresh = resolve;
        })
      );
      const refreshing = useCliAvailabilityStore.getState().refresh(true);
      getMock.mockResolvedValueOnce(chosenAvail);
      getDetailsMock.mockResolvedValueOnce({}).mockResolvedValueOnce(chosenDetails);
      const syncing = useCliAvailabilityStore.getState().syncFromHost();

      finishRefresh(installedAvail);
      await refreshing;
      await syncing;

      expect(useCliAvailabilityStore.getState().availability).toEqual(chosenAvail);
      expect(useCliAvailabilityStore.getState().details).toEqual(chosenDetails);
    });

    it("keeps the latest of two syncs, whichever answers last", async () => {
      let answerFirst!: (value: unknown) => void;
      getMock
        .mockReturnValueOnce(
          new Promise((resolve) => {
            answerFirst = resolve;
          })
        )
        .mockResolvedValueOnce(chosenAvail);
      getDetailsMock.mockResolvedValue(chosenDetails);

      const first = useCliAvailabilityStore.getState().syncFromHost();
      await vi.waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
      const second = useCliAvailabilityStore.getState().syncFromHost();
      await second;
      answerFirst(installedAvail);
      await first;

      expect(useCliAvailabilityStore.getState().availability).toEqual(chosenAvail);
    });

    it("holds a launch that asks after the change was heard until the reread lands", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();
      let answer!: (value: unknown) => void;
      getMock.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      getDetailsMock.mockResolvedValueOnce(chosenDetails);

      const syncing = useCliAvailabilityStore.getState().syncFromHost();
      let landed = false;
      const waiting = whenCliHostSynced().then(() => {
        landed = true;
      });
      await vi.waitFor(() => expect(getMock).toHaveBeenCalled());
      expect(landed).toBe(false);

      answer(chosenAvail);
      await waiting;
      // The launch reads what the host launches now, not what this view held.
      expect(useCliAvailabilityStore.getState().details).toEqual(chosenDetails);
      await syncing;
      await expect(whenCliHostSynced()).resolves.toBeUndefined();
    });

    it("starts a launch read after the change with the copy the host launches now", async () => {
      const { getCurrentLaunchCliDetail } = await import("@/utils/agentLaunchCommand");
      refreshMock.mockResolvedValueOnce(installedAvail);
      getDetailsMock.mockResolvedValueOnce({
        claude: { state: "ready", resolvedPath: "/a/claude", via: "which" },
      });
      await useCliAvailabilityStore.getState().initialize();
      let answer!: (value: unknown) => void;
      getMock.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      getDetailsMock.mockResolvedValueOnce({
        claude: {
          state: "ready",
          resolvedPath: "/b/claude",
          via: "chosen",
          chosenPath: "/b/claude",
        },
      });

      void useCliAvailabilityStore.getState().syncFromHost();
      const detail = getCurrentLaunchCliDetail("claude");
      answer(installedAvail);

      expect((await detail)?.resolvedPath).toBe("/b/claude");
    });

    it("holds a waiting launch through a reread that a later one superseded", async () => {
      const answers: Array<(value: unknown) => void> = [];
      getMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            answers.push(resolve);
          })
      );
      getDetailsMock.mockResolvedValue(chosenDetails);

      void useCliAvailabilityStore.getState().syncFromHost();
      let landed = false;
      const waiting = whenCliHostSynced().then(() => {
        landed = true;
      });
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      void useCliAvailabilityStore.getState().syncFromHost();
      await vi.waitFor(() => expect(answers).toHaveLength(2));

      answers[0]!(installedAvail);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(landed).toBe(false);

      answers[1]!(chosenAvail);
      await waiting;
      expect(useCliAvailabilityStore.getState().availability).toEqual(chosenAvail);
      getMock.mockReset();
    });

    it("keeps what the view had when the host can't be read", async () => {
      refreshMock.mockResolvedValueOnce(installedAvail);
      await useCliAvailabilityStore.getState().initialize();
      getMock.mockRejectedValueOnce(new Error("Host disconnected"));

      await expect(useCliAvailabilityStore.getState().syncFromHost()).resolves.toBeUndefined();

      expect(useCliAvailabilityStore.getState().availability).toEqual(installedAvail);
    });
  });
});
