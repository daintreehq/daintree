// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, setAgentState, reportLost } = vi.hoisted(() => {
  const store = {
    panelsById: {} as Record<string, Record<string, unknown>>,
    panelIds: [] as string[],
    watchedPanels: new Set<string>(),
    updateAgentState: vi.fn(),
    addPanel: vi.fn(async (args: { existingId?: string }) => args.existingId ?? null),
    setRuntimeStatus: vi.fn(),
    removePanel: vi.fn(),
  };
  return { store, setAgentState: vi.fn(), reportLost: vi.fn() };
});

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => store } }));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { setAgentState, reportLost },
}));
vi.mock("@/utils/stateHydration/statePatcher", () => ({
  buildArgsForOrphanedTerminal: (info: { id: string; cwd: string; kind?: string }) => ({
    kind: info.kind ?? "terminal",
    cwd: info.cwd,
    existingId: info.id,
    location: "grid",
  }),
  inferWorktreeIdFromCwd: (cwd: string, worktrees: Array<{ id: string; path: string }>) =>
    worktrees.find((w) => cwd.startsWith(w.path))?.id,
}));

import { resyncHostTerminals } from "../hostTerminalResync";
import {
  resetStoreAccessorsForTesting,
  setWorktreePathIndexAccessor,
  setWorktreeSelectionAccessor,
} from "../storeAccessors";

const getForProject = vi.fn();
const reconnectBulk = vi.fn();
const syncWatchedPanels = vi.fn();

function panel(id: string, extra: Record<string, unknown> = {}) {
  store.panelsById[id] = { id, kind: "terminal", location: "grid", ...extra };
  store.panelIds.push(id);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.panelsById = {};
  store.panelIds = [];
  store.watchedPanels = new Set();
  resetStoreAccessorsForTesting();
  Object.defineProperty(window, "electron", {
    value: {
      terminal: { getForProject, reconnectBulk },
      notification: { syncWatchedPanels },
    },
    writable: true,
    configurable: true,
  });
  reconnectBulk.mockResolvedValue({});
});

const current = { isCurrent: () => true };

describe("resyncHostTerminals", () => {
  it("adopts a terminal the host started while this view was away", async () => {
    setWorktreePathIndexAccessor(() => new Map([["wt-feature", "/repo/feature"]]));
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: "wt-main", restoreWorktreeId: null }));
    getForProject.mockResolvedValue([
      { id: "t-new", cwd: "/repo/feature/src", spawnedAt: 1 },
      { id: "t-dead", cwd: "/repo", spawnedAt: 1, hasPty: false },
      { id: "t-trash", cwd: "/repo", spawnedAt: 1, isTrashed: true },
      { id: "t-preview", cwd: "/repo", spawnedAt: 1, kind: "dev-preview" },
    ]);

    await resyncHostTerminals("proj-1", current);

    expect(store.addPanel).toHaveBeenCalledTimes(1);
    expect(store.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        existingId: "t-new",
        worktreeId: "wt-feature",
        worktreeIdSource: "inferred",
        bypassLimits: true,
      })
    );
  });

  it("reports a vanished terminal as exited once the host confirms it is gone", async () => {
    panel("t-gone");
    panel("t-spawning");
    panel("t-trashed", { location: "trash" });
    panel("t-exited", { runtimeStatus: "exited" });
    panel("t-held", { restoreRecovery: { reason: "manual" } });
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockResolvedValue({
      "t-gone": { exists: false },
      "t-spawning": { exists: true },
      "t-trashed": { exists: false },
    });

    await resyncHostTerminals("proj-1", current);

    expect(reconnectBulk).toHaveBeenCalledWith(["t-gone", "t-spawning", "t-trashed"]);
    expect(store.setRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(store.setRuntimeStatus).toHaveBeenCalledWith("t-gone", "exited");
    // The pane itself has to show it: the store status alone never reaches it.
    expect(reportLost).toHaveBeenCalledTimes(1);
    expect(reportLost).toHaveBeenCalledWith("t-gone", expect.any(String));
    expect(store.removePanel).toHaveBeenCalledWith("t-trashed", { backendAlreadyClosed: true });
  });

  it("ignores an answer about a terminal that restarted or exited while it was being asked", async () => {
    panel("t-restarted", { restartKey: 0 });
    panel("t-exited-meanwhile");
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockImplementation(async () => {
      // Both land while the probe is out: a respawn, and the real exit event.
      store.panelsById["t-restarted"] = { ...store.panelsById["t-restarted"], restartKey: 1 };
      store.panelsById["t-exited-meanwhile"] = {
        ...store.panelsById["t-exited-meanwhile"],
        exitCode: 3,
        runtimeStatus: "exited",
      };
      return { "t-restarted": { exists: false }, "t-exited-meanwhile": { exists: false } };
    });

    await resyncHostTerminals("proj-1", current);

    expect(store.setRuntimeStatus).not.toHaveBeenCalled();
    expect(reportLost).not.toHaveBeenCalled();
  });

  it("changes nothing about vanished terminals when the host can't confirm", async () => {
    panel("t-gone");
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockRejectedValue(new Error("[AppError|HOST_DISCONNECTED] down"));

    await resyncHostTerminals("proj-1", current);

    expect(store.setRuntimeStatus).not.toHaveBeenCalled();
    expect(reportLost).not.toHaveBeenCalled();
    expect(store.removePanel).not.toHaveBeenCalled();
  });

  it("adopts a new agent incarnation's state even when it looks older", async () => {
    panel("t-1", { lastStateChange: 50, agentIncarnation: 1 });
    panel("t-2", { lastStateChange: 50, agentIncarnation: 1 });
    getForProject.mockResolvedValue([
      {
        id: "t-1",
        cwd: "/",
        spawnedAt: 1,
        agentState: "idle",
        lastStateChange: 40,
        agentIncarnation: 2,
      },
      {
        id: "t-2",
        cwd: "/",
        spawnedAt: 1,
        agentState: "idle",
        lastStateChange: 40,
        agentIncarnation: 1,
      },
    ]);

    await resyncHostTerminals("proj-1", current);

    expect(store.updateAgentState).toHaveBeenCalledTimes(1);
    expect(store.updateAgentState.mock.calls[0]![0]).toBe("t-1");
    expect(setAgentState).toHaveBeenCalledWith("t-1", "idle");
  });

  it("replays this view's watched panes to the fresh session", async () => {
    panel("t-1");
    store.watchedPanels = new Set(["t-1", "t-closed"]);
    getForProject.mockResolvedValue([{ id: "t-1", cwd: "/", spawnedAt: 1 }]);

    await resyncHostTerminals("proj-1", current);

    expect(syncWatchedPanels).toHaveBeenCalledWith(["t-1"]);
  });

  it("drops a snapshot a newer resync has overtaken", async () => {
    panel("t-1", { lastStateChange: 10 });
    getForProject.mockResolvedValue([
      { id: "t-1", cwd: "/", spawnedAt: 1, agentState: "idle", lastStateChange: 20 },
      { id: "t-new", cwd: "/", spawnedAt: 1 },
    ]);

    await resyncHostTerminals("proj-1", { isCurrent: () => false });

    expect(store.updateAgentState).not.toHaveBeenCalled();
    expect(store.addPanel).not.toHaveBeenCalled();
    expect(syncWatchedPanels).not.toHaveBeenCalled();
  });
});
