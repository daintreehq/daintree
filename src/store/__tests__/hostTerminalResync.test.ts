// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, setAgentState, reportLost, fetchAndRestore } = vi.hoisted(() => {
  const store = {
    panelsById: {} as Record<string, Record<string, unknown>>,
    panelIds: [] as string[],
    watchedPanels: new Set<string>(),
    updateAgentState: vi.fn(),
    addPanel: vi.fn(async (args: { existingId?: string }) => args.existingId ?? null),
    setRuntimeStatus: vi.fn(),
    removePanel: vi.fn(),
  };
  return {
    store,
    setAgentState: vi.fn(),
    reportLost: vi.fn(),
    fetchAndRestore: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => store,
    setState: (update: (state: typeof store) => Partial<typeof store>) => {
      Object.assign(store, update(store));
    },
  },
}));
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = { setAgentState, reportLost, fetchAndRestore };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});
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
import { markSpawnUnconfirmed } from "../slices/panelRegistry/unconfirmedSpawn";
import {
  holdForDriveLease,
  isHeldForDriveLease,
  resetDriveLeaseHoldsForTesting,
} from "../driveLeaseWaitStore";
import {
  resetStoreAccessorsForTesting,
  setWorktreePathIndexAccessor,
  setWorktreeSelectionAccessor,
} from "../storeAccessors";
import {
  __testing as terminalServiceTesting,
  load as loadTerminalService,
  peek as peekTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";

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
  resetDriveLeaseHoldsForTesting();
});

const current = { isCurrent: () => true };

describe("resyncHostTerminals", () => {
  describe("in a view whose terminal service hasn't loaded", () => {
    beforeEach(() => {
      terminalServiceTesting.reset();
    });

    it("leaves it unloaded when the view has no terminals", async () => {
      panel("b-1", { kind: "browser" });
      getForProject.mockResolvedValue([]);

      await resyncHostTerminals("proj-1", current);

      expect(peekTerminalService()).toBeNull();
    });

    it("hands the host's state to the service the first terminal brings", async () => {
      getForProject.mockImplementation(async () => {
        // Opened while the host's answer was in flight.
        panel("t-1", { agentState: "idle", lastStateChange: 100, agentIncarnation: 1 });
        return [{ id: "t-1", agentState: "working", lastStateChange: 200, agentIncarnation: 1 }];
      });

      await resyncHostTerminals("proj-1", current);
      expect(peekTerminalService()).toBeNull();
      expect(setAgentState).not.toHaveBeenCalled();

      await loadTerminalService();
      expect(setAgentState).toHaveBeenCalledWith("t-1", "working");
    });
  });

  it("keeps a directing pane directing over a newer waiting report", async () => {
    panel("t-draft", { agentState: "directing", lastStateChange: 100, agentIncarnation: 1 });
    panel("t-run", { agentState: "directing", lastStateChange: 100, agentIncarnation: 1 });
    getForProject.mockResolvedValue([
      { id: "t-draft", agentState: "waiting", lastStateChange: 200, agentIncarnation: 1 },
      { id: "t-run", agentState: "working", lastStateChange: 200, agentIncarnation: 1 },
    ]);

    await resyncHostTerminals("proj-1", current);

    // The controller still learns the canonical state; only the store write is held back.
    expect(setAgentState).toHaveBeenCalledWith("t-draft", "waiting");
    expect(store.updateAgentState.mock.calls.map((call) => call[0])).toEqual(["t-run"]);
    expect(store.updateAgentState).toHaveBeenCalledWith(
      "t-run",
      "working",
      undefined,
      200,
      undefined,
      undefined,
      undefined
    );
  });

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

  it("names each pane it reports gone, under its restart key, for a host restart to relaunch (#14184)", async () => {
    panel("t-agent", { launchAgentId: "claude", restartKey: 3 });
    panel("t-shell");
    // The shell the agent ran in was still up, but the agent had already quit.
    panel("t-quit", { launchAgentId: "claude", agentState: "exited" });
    panel("t-trashed", { location: "trash" });
    panel("t-unsure");
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockResolvedValue({
      "t-agent": { exists: false },
      "t-shell": { exists: false },
      "t-quit": { exists: false },
      "t-trashed": { exists: false },
      "t-unsure": { exists: false, conflict: true },
    });
    const lost = new Map<string, number>();

    await resyncHostTerminals("proj-1", {
      ...current,
      onLost: (id, restartKey) => lost.set(id, restartKey),
    });

    expect([...lost]).toEqual([
      ["t-agent", 3],
      ["t-shell", 0],
    ]);
    expect(store.setRuntimeStatus).toHaveBeenCalledWith("t-quit", "exited");
  });

  it("never calls a pane that is still starting gone: its own spawn settles it (#13915)", async () => {
    panel("t-starting", { spawnStatus: "spawning" });
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockResolvedValue({ "t-starting": { exists: false } });

    await resyncHostTerminals("proj-1", current);

    expect(reconnectBulk).not.toHaveBeenCalled();
    expect(store.setRuntimeStatus).not.toHaveBeenCalled();
    expect(reportLost).not.toHaveBeenCalled();
  });

  it("leaves a terminal alone whose launch from this view is still being checked (#13915)", async () => {
    // Its pane was closed while the link was down: the check ends the
    // terminal, so adopting it would bring the closed pane back.
    const settle = markSpawnUnconfirmed("t-lost");
    try {
      getForProject.mockResolvedValue([{ id: "t-lost", cwd: "/repo", spawnedAt: 1 }]);

      await resyncHostTerminals("proj-1", current);

      expect(store.addPanel).not.toHaveBeenCalled();
    } finally {
      settle();
    }
  });

  it("never calls the assistant's own pane gone: its probe says so even while it runs (#13392)", async () => {
    panel("t-assistant", { location: "overlay", removeOnExit: true });
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockResolvedValue({ "t-assistant": { exists: false } });

    await resyncHostTerminals("proj-1", current);

    expect(reconnectBulk).not.toHaveBeenCalled();
    expect(store.setRuntimeStatus).not.toHaveBeenCalled();
    expect(store.removePanel).not.toHaveBeenCalled();
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
    const reported = { agentState: "working", at: 50 };
    panel("t-1", { lastStateChange: 50, lastAgentObservation: reported, agentIncarnation: 1 });
    panel("t-2", { lastStateChange: 50, lastAgentObservation: reported, agentIncarnation: 1 });
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

  it("takes a host report newer than its last one over this machine's later overlay (#16062)", async () => {
    // The host's clock runs a minute behind this one: the pane's own revert
    // from directing is stamped ahead of anything the host can report.
    panel("t-1", {
      agentState: "waiting",
      lastStateChange: 160_000,
      lastAgentObservation: { agentState: "waiting", at: 90_000 },
      agentIncarnation: 1,
    });
    getForProject.mockResolvedValue([
      { id: "t-1", cwd: "/", agentState: "working", lastStateChange: 100_000, agentIncarnation: 1 },
    ]);

    await resyncHostTerminals("proj-1", current);

    expect(setAgentState).toHaveBeenCalledWith("t-1", "working");
    expect(store.updateAgentState).toHaveBeenCalledWith(
      "t-1",
      "working",
      undefined,
      100_000,
      undefined,
      undefined,
      undefined
    );
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

describe("resyncHostTerminals following the driver (#13280)", () => {
  const following = { isCurrent: () => true, follow: true };

  it("takes a terminal the driver trashed out of this view's layout", async () => {
    // The host's list leaves trashed terminals out, while the PTY is still there.
    panel("t-trashed");
    panel("t-listed-trashed");
    panel("t-gone");
    // Between its kill and its spawn: off the list, but not trashed.
    panel("t-restarting-there");
    getForProject.mockResolvedValue([
      { id: "t-listed-trashed", cwd: "/repo", spawnedAt: 1, isTrashed: true },
    ]);
    reconnectBulk.mockResolvedValue({
      "t-trashed": { exists: true, isTrashed: true },
      "t-gone": { exists: false },
      "t-restarting-there": { exists: true },
    });

    await resyncHostTerminals("proj-1", following);

    expect(store.removePanel.mock.calls).toEqual([
      ["t-listed-trashed", { backendAlreadyClosed: true }],
      ["t-trashed", { backendAlreadyClosed: true }],
    ]);
    // Gone from the host: shown exited, for the layout to remove if the driver closed it.
    expect(store.setRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(store.setRuntimeStatus).toHaveBeenCalledWith("t-gone", "exited");
  });

  it("leaves this screen's own panes and held panes alone", async () => {
    panel("assistant", { excludeFromPersistence: true, location: "dock" });
    panel("t-help", { removeOnExit: true });
    panel("t-dialog", { location: "dialog" });
    getForProject.mockResolvedValue([]);
    // The host never lists the assistant, and won't hand it over either.
    reconnectBulk.mockResolvedValue({
      "t-help": { exists: true, isTrashed: true },
      "t-dialog": { exists: true, isTrashed: true },
    });

    await resyncHostTerminals("proj-1", following);

    expect(reconnectBulk).not.toHaveBeenCalled();
    expect(store.removePanel).not.toHaveBeenCalled();
    expect(store.setRuntimeStatus).not.toHaveBeenCalled();
    expect(reportLost).not.toHaveBeenCalled();
  });

  it("keeps a trashed terminal's pane when not following", async () => {
    panel("t-trashed");
    getForProject.mockResolvedValue([]);
    reconnectBulk.mockResolvedValue({ "t-trashed": { exists: true, isTrashed: true } });

    await resyncHostTerminals("proj-1", current);

    expect(store.removePanel).not.toHaveBeenCalled();
  });

  it("shows a terminal the driver restarted as running again, remounting its pane", async () => {
    panel("t-restarted", { exitCode: 1, runtimeStatus: "exited", restartKey: 2, isVisible: true });
    panel("t-docked", { exitCode: 1, runtimeStatus: "exited", location: "dock", isVisible: false });
    panel("t-dead", { exitCode: 1, runtimeStatus: "exited" });
    getForProject.mockResolvedValue([
      { id: "t-restarted", cwd: "/repo", spawnedAt: 2 },
      { id: "t-docked", cwd: "/repo", spawnedAt: 2 },
      { id: "t-dead", cwd: "/repo", spawnedAt: 1, hasPty: false },
    ]);

    await resyncHostTerminals("proj-1", following);

    expect(store.panelsById["t-restarted"]).toMatchObject({
      runtimeStatus: "running",
      restartKey: 3,
    });
    expect(store.panelsById["t-restarted"]!.exitCode).toBeUndefined();
    expect(store.panelsById["t-docked"]).toMatchObject({ runtimeStatus: "background" });
    expect(store.panelsById["t-dead"]).toMatchObject({ exitCode: 1, runtimeStatus: "exited" });
    expect(store.removePanel).not.toHaveBeenCalled();
  });

  it("leaves an exit that landed while the list was read alone", async () => {
    panel("t-live");
    getForProject.mockImplementation(async () => {
      store.panelsById["t-live"] = { ...store.panelsById["t-live"]!, runtimeStatus: "exited" };
      return [{ id: "t-live", cwd: "/repo", spawnedAt: 1 }];
    });

    await resyncHostTerminals("proj-1", following);

    expect(store.panelsById["t-live"]).toMatchObject({ runtimeStatus: "exited" });
  });

  describe("a pane waiting for control of the project (#13913)", () => {
    function waitingPane(id: string) {
      panel(id, { spawnStatus: "spawning", runtimeStatus: "running" });
      const resume = vi.fn();
      holdForDriveLease(id, { projectId: "proj-1", resume });
      return resume;
    }

    it("isn't reported lost for a terminal it hasn't started yet", async () => {
      waitingPane("t-wait");
      getForProject.mockResolvedValue([]);
      reconnectBulk.mockResolvedValue({ "t-wait": { exists: false } });

      await resyncHostTerminals("proj-1", following);

      expect(store.setRuntimeStatus).not.toHaveBeenCalled();
      expect(reportLost).not.toHaveBeenCalled();
      expect(store.panelsById["t-wait"]).toMatchObject({ spawnStatus: "spawning" });
    });

    it("isn't reported lost when it starts waiting while the probe is out", async () => {
      panel("t-refused", { spawnStatus: "spawning", runtimeStatus: "running" });
      getForProject.mockResolvedValue([]);
      reconnectBulk.mockImplementation(async () => {
        holdForDriveLease("t-refused", { projectId: "proj-1", resume: vi.fn() });
        return { "t-refused": { exists: false } };
      });

      await resyncHostTerminals("proj-1", following);

      expect(store.setRuntimeStatus).not.toHaveBeenCalled();
      expect(reportLost).not.toHaveBeenCalled();
    });

    it("attaches to the terminal the host now runs under its id, once", async () => {
      const resume = waitingPane("t-wait");
      getForProject.mockResolvedValue([{ id: "t-wait", cwd: "/repo", spawnedAt: 2 }]);

      await resyncHostTerminals("proj-1", following);
      await resyncHostTerminals("proj-1", following);

      expect(store.panelsById["t-wait"]).toMatchObject({ spawnStatus: "ready" });
      expect(isHeldForDriveLease("t-wait")).toBe(false);
      expect(store.addPanel).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(fetchAndRestore).toHaveBeenCalledTimes(1);
      expect(fetchAndRestore).toHaveBeenCalledWith("t-wait");
    });

    it("keeps waiting when the host's terminal under its id is gone or trashed", async () => {
      waitingPane("t-dead");
      waitingPane("t-trash");
      getForProject.mockResolvedValue([
        { id: "t-dead", cwd: "/repo", spawnedAt: 1, hasPty: false },
        { id: "t-trash", cwd: "/repo", spawnedAt: 1, isTrashed: true },
      ]);

      await resyncHostTerminals("proj-1", current);

      expect(isHeldForDriveLease("t-dead")).toBe(true);
      expect(isHeldForDriveLease("t-trash")).toBe(true);
      expect(fetchAndRestore).not.toHaveBeenCalled();
    });
  });
});
