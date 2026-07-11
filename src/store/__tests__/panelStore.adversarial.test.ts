// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/controllers", () => ({
  terminalRegistryController: {
    kill: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    detachForProjectSwitch: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
  },
}));

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelSnapshotOptions: vi.fn((p: { id: string }) => ({ id: p.id })),
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(() => "mock-notification-id"),
}));

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: {
    getState: () => ({ clearAllDraftInputs: vi.fn() }),
  },
}));

// Mock window.electron so terminalClient methods in trash/reset paths don't
// blow up on `window.electron.terminal.*`.
(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  terminal: {
    trash: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
  },
};

const baseWatched = () => new Set<string>();

import { usePanelStore } from "../panelStore";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

function resetStore() {
  usePanelStore.setState((s) => ({
    ...s,
    panelsById: {},
    panelIds: [],
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
    tabGroups: new Map(),
    focusedId: null,
    maximizedId: null,
    maximizeTarget: null,
    preMaximizeLayout: null,
    activeDockTerminalId: null,
    pingedId: null,
    commandQueue: [],
    commandQueueCountById: {},
    mruList: [],
    watchedPanels: baseWatched(),
    backendStatus: "connected",
    lastCrashType: null,
    lastClosedConfig: null,
  }));
}

describe("panelStore adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("clearTerminalStoreForSwitch clears watchedPanels so watches do not leak across project switches", () => {
    usePanelStore.getState().watchPanel("panel-from-project-a");
    expect(usePanelStore.getState().watchedPanels.size).toBe(1);

    usePanelStore.getState().clearTerminalStoreForSwitch();

    expect(usePanelStore.getState().watchedPanels.size).toBe(0);
  });

  it("clearTerminalStoreForSwitch clears maximizeTarget alongside maximizedId (#9935)", () => {
    usePanelStore.setState({
      maximizedId: "panel-1",
      maximizeTarget: { type: "panel", id: "panel-1" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 2, worktreeId: undefined },
    });

    usePanelStore.getState().clearTerminalStoreForSwitch();

    const state = usePanelStore.getState();
    expect(state.maximizedId).toBeNull();
    expect(state.maximizeTarget).toBeNull();
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("reset drains all panel state even when destroy and kill throw", async () => {
    vi.mocked(terminalInstanceService.destroy).mockImplementationOnce(() => {
      throw new Error("destroy failed");
    });
    vi.mocked(terminalRegistryController.kill).mockRejectedValueOnce(new Error("kill failed"));

    usePanelStore.setState({
      panelsById: {
        p1: {
          id: "p1",
          title: "p1",
          cwd: "/a",
          location: "grid",
          createdAt: 1,
          type: "terminal",
          kind: "terminal",
        } as unknown as never,
        p2: {
          id: "p2",
          title: "p2",
          cwd: "/b",
          location: "grid",
          createdAt: 2,
          type: "terminal",
          kind: "terminal",
        } as unknown as never,
      },
      panelIds: ["p1", "p2"],
      focusedId: "p1",
      maximizedId: "p1",
      maximizeTarget: { type: "panel", id: "p1" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 2, worktreeId: undefined },
      commandQueue: [
        {
          id: "q1",
          terminalId: "p1",
          payload: "x",
          description: "x",
          queuedAt: 0,
          origin: "user",
        },
      ],
      commandQueueCountById: { p1: 1 },
      mruList: ["p1", "p2"],
      backendStatus: "disconnected",
      lastCrashType: "UNKNOWN_CRASH",
    });

    await usePanelStore.getState().reset();

    const s = usePanelStore.getState();
    expect(s.panelIds).toEqual([]);
    expect(s.panelsById).toEqual({});
    expect(s.focusedId).toBeNull();
    expect(s.maximizedId).toBeNull();
    expect(s.maximizeTarget).toBeNull();
    expect(s.preMaximizeLayout).toBeNull();
    expect(s.commandQueue).toEqual([]);
    expect(s.commandQueueCountById).toEqual({});
    expect(s.mruList).toEqual([]);
    expect(s.backendStatus).toBe("connected");
    expect(s.lastCrashType).toBeNull();

    expect(terminalInstanceService.destroy).toHaveBeenCalledTimes(2);
    expect(terminalRegistryController.kill).toHaveBeenCalledTimes(2);
  });

  it("clearTerminalStoreForSwitch clears command queues so no stale commands replay into new project", () => {
    usePanelStore.setState({
      commandQueue: [
        {
          id: "q1",
          terminalId: "p1",
          payload: "x",
          description: "x",
          queuedAt: 0,
          origin: "user",
        },
      ],
      commandQueueCountById: { p1: 1 },
    });

    usePanelStore.getState().clearTerminalStoreForSwitch();

    expect(usePanelStore.getState().commandQueue).toEqual([]);
    expect(usePanelStore.getState().commandQueueCountById).toEqual({});
  });

  it("watchPanel + unwatchPanel round-trip is idempotent and does not leak references", () => {
    const state = usePanelStore.getState();
    state.watchPanel("p1");
    state.watchPanel("p1");
    state.watchPanel("p2");
    expect(usePanelStore.getState().watchedPanels.size).toBe(2);

    state.unwatchPanel("p1");
    state.unwatchPanel("p1");
    expect(usePanelStore.getState().watchedPanels.has("p1")).toBe(false);
    expect(usePanelStore.getState().watchedPanels.has("p2")).toBe(true);

    state.unwatchPanel("nonexistent");
    expect(usePanelStore.getState().watchedPanels.size).toBe(1);
  });

  it("clearTerminalStoreForSwitch replaces watchedPanels with a new Set instance", () => {
    usePanelStore.getState().watchPanel("p1");
    usePanelStore.getState().watchPanel("p2");
    const pre = usePanelStore.getState().watchedPanels;

    usePanelStore.getState().clearTerminalStoreForSwitch();

    const post = usePanelStore.getState().watchedPanels;
    expect(post).not.toBe(pre);
    expect(post.size).toBe(0);
  });

  it("trashPanel does not emit a toast notification", async () => {
    // The undo toast was removed — the trash flow + reopen-last-closed
    // keybinding cover recovery without adding visual noise on every close.
    const { notify } = await import("@/lib/notify");
    const notifyMock = vi.mocked(notify);

    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "agent-foo",
          cwd: "/a",
          location: "grid",
          createdAt: 1,
          type: "claude",
          kind: "terminal",
        } as unknown as never,
      },
      panelIds: ["term-1"],
    });

    usePanelStore.getState().trashPanel("term-1");
    usePanelStore.getState().trashPanelGroup("term-1");

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("trashPanel preserves existing lastClosedConfig when snapshot returns null", async () => {
    // Regression guard for #5211: if buildPanelSnapshotOptions returns null
    // (broken agent panel), we must NOT overwrite lastClosedConfig with null —
    // otherwise a later reopen would lose a valid prior snapshot and could
    // resurrect the bare-shell agent bug.
    const { buildPanelSnapshotOptions } =
      await import("@/services/terminal/panelDuplicationService");
    vi.mocked(buildPanelSnapshotOptions).mockReturnValueOnce(null);

    const priorSnapshot = { kind: "terminal", command: "bash" } as never;
    usePanelStore.setState({
      panelsById: {
        agent1: {
          id: "agent1",
          title: "Broken Agent",
          cwd: "/a",
          location: "grid",
          createdAt: 1,
          type: "claude",
          kind: "terminal",
        } as unknown as never,
      },
      panelIds: ["agent1"],
      lastClosedConfig: priorSnapshot,
    });

    usePanelStore.getState().trashPanel("agent1");

    expect(usePanelStore.getState().lastClosedConfig).toBe(priorSnapshot);
  });

  describe("maximize state cleared on out-of-grid moves (#9936)", () => {
    function makePanel(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        title: id,
        cwd: "/a",
        location: "grid",
        createdAt: 1,
        type: "terminal",
        kind: "terminal",
        worktreeId: "wt-1",
        ...overrides,
      } as unknown as never;
    }

    function makeGroup() {
      return {
        id: "g1",
        location: "grid",
        activeTabId: "p1",
        panelIds: ["p1", "p2"],
        worktreeId: "wt-1",
      };
    }

    function seedMaximizedPanel() {
      usePanelStore.setState({
        panelsById: { p1: makePanel("p1"), p2: makePanel("p2") },
        panelIds: ["p1", "p2"],
        panelIdsByWorktreeId: { "wt-1": ["p1", "p2"] },
        maximizedId: "p1",
        maximizeTarget: { type: "panel", id: "p1" },
        preMaximizeLayout: { kind: "snapshot" } as unknown as never,
      });
    }

    function seedMaximizedGroup() {
      usePanelStore.setState({
        panelsById: { p1: makePanel("p1"), p2: makePanel("p2") },
        panelIds: ["p1", "p2"],
        panelIdsByWorktreeId: { "wt-1": ["p1", "p2"] },
        tabGroups: new Map([["g1", makeGroup()]]) as never,
        // Group-maximize tracks the triggering PANEL in maximizedId; the group
        // id lives in maximizeTarget.id.
        maximizedId: "p1",
        maximizeTarget: { type: "group", id: "g1" },
        preMaximizeLayout: { kind: "snapshot" } as unknown as never,
      });
    }

    function expectMaximizeCleared() {
      const s = usePanelStore.getState();
      expect(s.maximizedId).toBeNull();
      expect(s.maximizeTarget).toBeNull();
      expect(s.preMaximizeLayout).toBeNull();
    }

    it("backgroundTerminal clears maximize when the maximized panel is sent to background", () => {
      seedMaximizedPanel();
      usePanelStore.getState().backgroundTerminal("p1");
      expectMaximizeCleared();
    });

    it("backgroundTerminal clears maximize when a sibling of the maximized group is backgrounded", () => {
      seedMaximizedGroup();
      // Background p2 — not the tracking panel (p1) but a member of the
      // maximized group, so maximize must still clear.
      usePanelStore.getState().backgroundTerminal("p2");
      expectMaximizeCleared();
    });

    it("backgroundPanelGroup clears maximize when the maximized group is backgrounded", () => {
      seedMaximizedGroup();
      usePanelStore.getState().backgroundPanelGroup("p1");
      expectMaximizeCleared();
    });

    it("moveTerminalToWorktree clears maximize when the maximized panel changes worktree", () => {
      seedMaximizedPanel();
      usePanelStore.getState().moveTerminalToWorktree("p1", "wt-2");
      expectMaximizeCleared();
    });

    it("moveTabGroupToWorktree clears maximize when the maximized group changes worktree", () => {
      seedMaximizedGroup();
      usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-2");
      expectMaximizeCleared();
    });

    it("moveTabGroupToLocation clears maximize when the maximized group is dragged into the dock", () => {
      seedMaximizedGroup();
      usePanelStore.getState().moveTabGroupToLocation("g1", "dock");
      expectMaximizeCleared();
    });

    it("moveTerminalToDock clears maximize when a sibling of the maximized group is docked", () => {
      seedMaximizedGroup();
      // p2 is in the maximized group; p1 is the tracking panel. Docking p2
      // routes through moveTabGroupToLocation internally.
      usePanelStore.getState().moveTerminalToDock("p2");
      expectMaximizeCleared();
    });

    it("backgroundPanelGroup clears maximize for an ungrouped maximized panel via delegation", () => {
      seedMaximizedPanel();
      usePanelStore.getState().backgroundPanelGroup("p1");
      expectMaximizeCleared();
    });

    it("moveTerminalToPosition clears maximize when the maximized panel is dragged into the dock", () => {
      seedMaximizedPanel();
      usePanelStore.getState().moveTerminalToPosition("p1", 0, "dock");
      expectMaximizeCleared();
    });

    it("leaves maximize untouched when an unrelated panel is moved out of grid scope", () => {
      seedMaximizedPanel();
      // p2 is neither the maximized panel nor in its group.
      usePanelStore.getState().backgroundTerminal("p2");
      const s = usePanelStore.getState();
      expect(s.maximizedId).toBe("p1");
      expect(s.maximizeTarget).toEqual({ type: "panel", id: "p1" });
      expect(s.preMaximizeLayout).not.toBeNull();
    });

    it("leaves maximize untouched on a within-grid reposition (location stays grid)", () => {
      seedMaximizedPanel();
      usePanelStore.getState().moveTerminalToPosition("p1", 1, "grid");
      const s = usePanelStore.getState();
      expect(s.maximizedId).toBe("p1");
      expect(s.maximizeTarget).toEqual({ type: "panel", id: "p1" });
    });

    it("leaves maximize untouched on a same-worktree no-op move", () => {
      seedMaximizedPanel();
      usePanelStore.getState().moveTerminalToWorktree("p1", "wt-1");
      const s = usePanelStore.getState();
      expect(s.maximizedId).toBe("p1");
      expect(s.maximizeTarget).toEqual({ type: "panel", id: "p1" });
    });

    describe("addPanel leaves fullscreen so the new panel is visible (#11060)", () => {
      // `review` has no PTY and is not dockable, so it always commits to the
      // grid without touching the terminal client. `browser` is the non-PTY
      // kind that IS dockable — the dock branch below needs it.
      const gridAdd = { kind: "review", worktreeId: "wt-1" } as const;

      it("exits fullscreen and focuses the new panel, keeping the layout snapshot", async () => {
        seedMaximizedPanel();
        const snapshot = usePanelStore.getState().preMaximizeLayout;

        const id = await usePanelStore.getState().addPanel(gridAdd);

        const s = usePanelStore.getState();
        expect(id).not.toBeNull();
        expect(s.focusedId).toBe(id);
        expect(s.maximizedId).toBeNull();
        expect(s.maximizeTarget).toBeNull();
        // The distinction from clearMaximize: the user is returning to the grid,
        // not destroying the panel, so the column count still restores.
        expect(s.preMaximizeLayout).toBe(snapshot);
      });

      it("exits a group target whose group has dissolved instead of re-maximizing", async () => {
        // maximizeTarget points at g1, but no such group exists. toggleMaximize
        // cannot resolve it, treats the call as a fresh maximize, and would
        // re-maximize p1 — the exact misfire exitMaximize exists to avoid.
        usePanelStore.setState({
          panelsById: { p1: makePanel("p1") },
          panelIds: ["p1"],
          panelIdsByWorktreeId: { "wt-1": ["p1"] },
          tabGroups: new Map(),
          maximizedId: "p1",
          maximizeTarget: { type: "group", id: "g1" },
        });

        await usePanelStore.getState().addPanel(gridAdd);

        const s = usePanelStore.getState();
        expect(s.maximizedId).toBeNull();
        expect(s.maximizeTarget).toBeNull();
      });

      it("stays fullscreen for a preserve-policy spawn, which never takes focus", async () => {
        seedMaximizedPanel();
        usePanelStore.setState({ focusedId: "p1" });

        const id = await usePanelStore.getState().addPanel({
          ...gridAdd,
          focusPolicy: "preserve",
        });

        const s = usePanelStore.getState();
        expect(id).not.toBeNull();
        expect(s.focusedId).toBe("p1");
        expect(s.maximizedId).toBe("p1");
        expect(s.maximizeTarget).toEqual({ type: "panel", id: "p1" });
      });

      it("stays fullscreen when preserveMaximize opts the tab-strip add out", async () => {
        // The tab-strip "+" adds the panel first and groups it second, so at
        // commit time it looks like a plain new grid cell. It still takes focus.
        seedMaximizedGroup();

        const id = await usePanelStore.getState().addPanel({
          ...gridAdd,
          preserveMaximize: true,
        });

        const s = usePanelStore.getState();
        expect(s.focusedId).toBe(id);
        expect(s.maximizedId).toBe("p1");
        expect(s.maximizeTarget).toEqual({ type: "group", id: "g1" });
      });

      it("leaves the grid's fullscreen view alone for a panel committed to the dock", async () => {
        seedMaximizedPanel();

        await usePanelStore
          .getState()
          .addPanel({ kind: "browser", worktreeId: "wt-1", location: "dock" });

        const s = usePanelStore.getState();
        expect(s.maximizedId).toBe("p1");
        expect(s.maximizeTarget).toEqual({ type: "panel", id: "p1" });
      });
    });

    describe("restore leaves fullscreen so the restored panel is visible (#11060)", () => {
      it("exits fullscreen when a trashed panel is restored to the grid", () => {
        seedMaximizedPanel();
        usePanelStore.getState().trashPanel("p2");
        // Trashing p2 (unrelated to the maximized p1) must not have cleared it.
        expect(usePanelStore.getState().maximizedId).toBe("p1");

        usePanelStore.getState().restoreTerminal("p2");

        const s = usePanelStore.getState();
        expect(s.focusedId).toBe("p2");
        expect(s.maximizedId).toBeNull();
        expect(s.maximizeTarget).toBeNull();
      });

      it("stays fullscreen when the restored panel lands back in the dock", () => {
        usePanelStore.setState({
          panelsById: {
            p1: makePanel("p1"),
            d1: makePanel("d1", { location: "dock", kind: "terminal" }),
          },
          panelIds: ["p1", "d1"],
          panelIdsByWorktreeId: { "wt-1": ["p1", "d1"] },
          maximizedId: "p1",
          maximizeTarget: { type: "panel", id: "p1" },
        });
        usePanelStore.getState().trashPanel("d1");

        usePanelStore.getState().restoreTerminal("d1");

        const s = usePanelStore.getState();
        // The dock popover reveals it; the grid's fullscreen view is untouched.
        expect(s.activeDockTerminalId).toBe("d1");
        expect(s.maximizedId).toBe("p1");
      });
    });
  });
});
