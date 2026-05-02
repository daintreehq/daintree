/**
 * Tests for atomic dock activation on panel create (#6590).
 *
 * Before this fix, `addPanel` committed `panelsById`/`panelIds` synchronously,
 * then a follow-up `openDockTerminal()` call from the dock-create call site
 * fired a SECOND `set()` for `activeDockTerminalId` after a microtask boundary.
 * The watchdog `useEffect` in `DockPanelOffscreenContainer` could observe an
 * intermediate state and call `closeDockTerminal()`, collapsing the
 * just-created panel.
 *
 * The fix folds the dock activation into the same `set()` that commits the
 * panel when `activateDockOnCreate: true` and `location === "dock"`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

const acknowledgeWaitingMock = vi.fn();
const acknowledgeWorkingPulseMock = vi.fn();

// Set up window.electron globally before any module imports
(globalThis as any).window = {
  electron: {
    globalEnv: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    notification: {
      updateBadge: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
      setSettings: vi.fn().mockResolvedValue(undefined),
      playSound: vi.fn().mockResolvedValue(undefined),
      playUiEvent: vi.fn().mockResolvedValue(undefined),
      showNative: vi.fn(),
      showWatchNotification: vi.fn(),
      onShowToast: vi.fn(() => () => {}),
      onWatchNavigate: vi.fn(() => () => {}),
      syncWatchedPanels: vi.fn(),
      acknowledgeData: vi.fn(),
      acknowledgeWaiting: acknowledgeWaitingMock,
      acknowledgeWorkingPulse: acknowledgeWorkingPulseMock,
      setSessionMuteUntil: vi.fn(),
    },
  },
} as unknown as typeof globalThis.window;

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue("spawn-id"),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

beforeEach(() => {
  acknowledgeWaitingMock.mockReset();
  acknowledgeWorkingPulseMock.mockReset();
});

const { usePanelStore } = await import("../../../panelStore");

async function drainMicrotasks(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

describe("atomic dock activation on create (#6590)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();
  });

  it("activates the new panel in the same state snapshot that adds it", async () => {
    // Capture every state snapshot where panelIds includes the new panel.
    // If activation is atomic, the FIRST snapshot containing the new panel id
    // also has activeDockTerminalId set to that id.
    const snapshotsWithPanel: Array<{
      hasPanelInList: boolean;
      hasPanelInById: boolean;
      activeDockTerminalId: string | null;
      focusedId: string | null;
    }> = [];
    const targetId = "dock-atomic-1";

    const unsubscribe = usePanelStore.subscribe((state) => {
      const hasPanelInList = state.panelIds.includes(targetId);
      const hasPanelInById = Boolean(state.panelsById[targetId]);
      if (hasPanelInList || hasPanelInById) {
        snapshotsWithPanel.push({
          hasPanelInList,
          hasPanelInById,
          activeDockTerminalId: state.activeDockTerminalId,
          focusedId: state.focusedId,
        });
      }
    });

    try {
      const { addPanel } = usePanelStore.getState();
      await addPanel({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude",
        requestedId: targetId,
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
      });

      // The very first snapshot containing the panel must already have it
      // active in the dock — no intermediate render where the watchdog could
      // fire `closeDockTerminal()` because it sees the active id without the
      // panel in `dockTerminals`.
      expect(snapshotsWithPanel.length).toBeGreaterThan(0);
      const firstSnapshot = snapshotsWithPanel[0]!;
      expect(firstSnapshot.hasPanelInList).toBe(true);
      expect(firstSnapshot.hasPanelInById).toBe(true);
      expect(firstSnapshot.activeDockTerminalId).toBe(targetId);
      expect(firstSnapshot.focusedId).toBe(targetId);
    } finally {
      unsubscribe();
    }
  });

  it("does not activate when activateDockOnCreate is false", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "no-activate-1",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
    });

    expect(id).toBe("no-activate-1");
    const state = usePanelStore.getState();
    expect(state.panelsById[id!]).toBeDefined();
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("does not activate when location is grid even with the flag set", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "grid-with-flag",
      cwd: "/",
      location: "grid",
      bypassLimits: true,
      activateDockOnCreate: true,
    });

    expect(id).toBe("grid-with-flag");
    const state = usePanelStore.getState();
    expect(state.panelsById[id!]).toBeDefined();
    // Grid panels never set activeDockTerminalId regardless of the flag.
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("two rapid dock creates leave both panels and the second active", async () => {
    const { addPanel } = usePanelStore.getState();
    const [firstId, secondId] = await Promise.all([
      addPanel({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude",
        requestedId: "rapid-1",
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
      }),
      addPanel({
        kind: "terminal",
        launchAgentId: "codex",
        command: "codex",
        requestedId: "rapid-2",
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
      }),
    ]);

    expect(firstId).toBe("rapid-1");
    expect(secondId).toBe("rapid-2");

    await drainMicrotasks();

    const state = usePanelStore.getState();
    expect(state.panelsById["rapid-1"]).toBeDefined();
    expect(state.panelsById["rapid-2"]).toBeDefined();
    expect(state.panelIds).toContain("rapid-1");
    expect(state.panelIds).toContain("rapid-2");
    // Whichever second `addPanel` call commits last wins as the active dock
    // panel — both panels remain in dockTerminals (location: dock, not trashed).
    expect(state.activeDockTerminalId).toBe("rapid-2");
    expect(state.focusedId).toBe("rapid-2");
  });

  it("preserves previousFocusedId when activating dock from a focused grid panel", async () => {
    const { addPanel } = usePanelStore.getState();

    const gridId = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "grid-focus-1",
      cwd: "/",
      location: "grid",
      bypassLimits: true,
    });
    expect(gridId).toBe("grid-focus-1");
    expect(usePanelStore.getState().focusedId).toBe("grid-focus-1");

    const dockId = await addPanel({
      kind: "terminal",
      launchAgentId: "codex",
      command: "codex",
      requestedId: "dock-focus-1",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
      activateDockOnCreate: true,
    });
    expect(dockId).toBe("dock-focus-1");

    const state = usePanelStore.getState();
    expect(state.focusedId).toBe("dock-focus-1");
    expect(state.previousFocusedId).toBe("grid-focus-1");
    expect(state.activeDockTerminalId).toBe("dock-focus-1");
  });

  it("calls wake() and acknowledgeWorkingPulse for an active dock agent", async () => {
    const wake = vi.mocked(terminalInstanceService.wake);
    wake.mockReset();

    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "wake-1",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
      activateDockOnCreate: true,
      // explicit "working" agentState (default for new agent panels)
      agentState: "working",
    });
    expect(id).toBe("wake-1");
    expect(wake).toHaveBeenCalledWith("wake-1");
    expect(acknowledgeWorkingPulseMock).toHaveBeenCalledWith("wake-1");
  });

  it("calls wake() and acknowledgeWaiting for a waiting active dock agent", async () => {
    const wake = vi.mocked(terminalInstanceService.wake);
    wake.mockReset();

    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "waiting-1",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
      activateDockOnCreate: true,
      agentState: "waiting",
    });
    expect(id).toBe("waiting-1");
    expect(wake).toHaveBeenCalledWith("waiting-1");
    expect(acknowledgeWaitingMock).toHaveBeenCalledWith("waiting-1");
  });

  it("does not call wake() when activateDockOnCreate is omitted", async () => {
    const wake = vi.mocked(terminalInstanceService.wake);
    wake.mockReset();

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "no-wake-1",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
      agentState: "working",
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("activates a non-PTY (browser) panel in the dock atomically", async () => {
    const targetId = "browser-dock-1";
    const snapshotsWithPanel: Array<{
      hasPanelInById: boolean;
      activeDockTerminalId: string | null;
    }> = [];

    const unsubscribe = usePanelStore.subscribe((state) => {
      if (state.panelsById[targetId]) {
        snapshotsWithPanel.push({
          hasPanelInById: true,
          activeDockTerminalId: state.activeDockTerminalId,
        });
      }
    });

    try {
      const { addPanel } = usePanelStore.getState();
      await addPanel({
        kind: "browser",
        requestedId: targetId,
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
      });

      expect(snapshotsWithPanel.length).toBeGreaterThan(0);
      expect(snapshotsWithPanel[0]!.activeDockTerminalId).toBe(targetId);
    } finally {
      unsubscribe();
    }
  });
});
