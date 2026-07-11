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
import type { PtyPanelData } from "@shared/types/panel";

const acknowledgeWaitingMock = vi.fn();
const acknowledgeWorkingPulseMock = vi.fn();

// Set up window.electron globally before any module imports
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
(globalThis as typeof globalThis & { window?: typeof window }).window = {
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
} as unknown as typeof window;

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
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
    get: vi.fn(() => null),
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
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
const { useWorktreeSelectionStore } = await import("../../../worktreeStore");

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

  it("adds MCP-created dock panels without opening the dock popover", async () => {
    const wake = vi.mocked(terminalInstanceService.wake);
    wake.mockReset();
    const snapshotsWithPanel: Array<{
      hasPanelInById: boolean;
      activeDockTerminalId: string | null;
      focusedId: string | null;
    }> = [];
    const targetId = "mcp-dock-no-open";

    const unsubscribe = usePanelStore.subscribe((state) => {
      if (state.panelsById[targetId]) {
        snapshotsWithPanel.push({
          hasPanelInById: true,
          activeDockTerminalId: state.activeDockTerminalId,
          focusedId: state.focusedId,
        });
      }
    });

    try {
      const { addPanel } = usePanelStore.getState();
      const id = await addPanel({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude",
        requestedId: targetId,
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
        focusPolicy: "preserve",
        spawnedBy: "mcp",
      });

      expect(id).toBe(targetId);
      expect(snapshotsWithPanel.length).toBeGreaterThan(0);
      expect(snapshotsWithPanel[0]!.hasPanelInById).toBe(true);
      expect(snapshotsWithPanel[0]!.activeDockTerminalId).toBeNull();
      expect(snapshotsWithPanel[0]!.focusedId).toBeNull();
      expect(wake).not.toHaveBeenCalled();
      expect(acknowledgeWorkingPulseMock).not.toHaveBeenCalled();
      expect(acknowledgeWaitingMock).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
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

  it("activates a non-PTY (file) panel in the dock atomically", async () => {
    // `file` is a dockable non-PTY kind, so it reaches the dock-activation path.
    // A non-dockable kind (e.g. dev-preview) would be redirected to the grid by
    // addPanel since #11054 and never activate the dock.
    const targetId = "file-dock-1";
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
        kind: "file",
        filePath: "/readme.md",
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

describe("dockPopoverOnSpawn policy gate (#8946)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();
  });

  it("kind with dockPopoverOnSpawn: false skips the popover even when activateDockOnCreate is true", async () => {
    const { registerPanelKind, unregisterPanelKind } =
      await import("@shared/config/panelKindRegistry");
    registerPanelKind({
      id: "quiet-dock-kind",
      name: "Quiet Dock",
      iconId: "test",
      color: "#000",
      hasPty: false,
      // Must be dockable, or the #11054 guard redirects the dock request to the
      // grid and the popover assertion below becomes vacuous.
      dockable: true,
      canRestart: false,
      canConvert: false,
      usesTerminalUi: false,
      extensionId: "test-policy-plugin",
      policy: { dockPopoverOnSpawn: false },
    });

    try {
      const { addPanel } = usePanelStore.getState();
      // Extension kinds widen via explicit cast at the integration boundary
      // — see ExtensionPanelOptions note in shared/types/addPanelOptions.ts.
      const id = await addPanel({
        kind: "quiet-dock-kind",
        requestedId: "quiet-dock-1",
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(id).toBe("quiet-dock-1");
      const state = usePanelStore.getState();
      // Panel committed to dock but popover NOT opened — activeDockTerminalId stays null.
      expect(state.panelsById[id!]).toBeDefined();
      expect(state.activeDockTerminalId).toBeNull();
      expect(state.focusedId).toBeNull();
    } finally {
      unregisterPanelKind("quiet-dock-kind");
    }
  });

  it("MCP suppression still wins over kind policy (both gates lead to suppressed popover)", async () => {
    const { registerPanelKind, unregisterPanelKind } =
      await import("@shared/config/panelKindRegistry");
    // Even with dockPopoverOnSpawn: true (default), the MCP bridge stamps
    // `focusPolicy: "preserve"` alongside `spawnedBy: "mcp"` (see
    // `useMcpBridge.ts`), so the popover stays suppressed. Provenance no
    // longer carries focus semantics — the explicit policy does.
    registerPanelKind({
      id: "opt-in-popover-kind",
      name: "Opt-In",
      iconId: "test",
      color: "#000",
      hasPty: false,
      // Must be dockable, or the #11054 guard redirects the dock request to the
      // grid and the suppression assertion below becomes vacuous.
      dockable: true,
      canRestart: false,
      canConvert: false,
      usesTerminalUi: false,
      extensionId: "test-policy-plugin",
      policy: { dockPopoverOnSpawn: true },
    });

    try {
      const { addPanel } = usePanelStore.getState();
      const id = await addPanel({
        kind: "opt-in-popover-kind",
        requestedId: "opt-in-1",
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
        spawnedBy: "mcp",
        focusPolicy: "preserve",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(id).toBe("opt-in-1");
      const state = usePanelStore.getState();
      expect(state.panelsById[id!]).toBeDefined();
      // MCP-paired preserve policy suppresses regardless of kind policy.
      expect(state.activeDockTerminalId).toBeNull();
    } finally {
      unregisterPanelKind("opt-in-popover-kind");
    }
  });

  it("kind without a dockPopoverOnSpawn override (default true) still opens the popover", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      // browser only overrides dockFallbackTarget — dockPopoverOnSpawn stays the
      // default true. It is dockable (#11058), so the popover path runs.
      kind: "browser",
      requestedId: "browser-default-popover",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
      activateDockOnCreate: true,
    });

    expect(id).toBe("browser-default-popover");
    const state = usePanelStore.getState();
    expect(state.panelsById[id!]).toBeDefined();
    expect(state.activeDockTerminalId).toBe("browser-default-popover");
  });

  it("PTY extension kind honors dockPopoverOnSpawn: false (resolved from requestedKind, not collapsed kind)", async () => {
    // Regression guard: previously the PTY path resolved policy from the
    // collapsed `kind` ("terminal" | "dev-preview"), silently dropping any
    // PTY extension kind's policy. Resolution now uses `requestedKind`.
    const wake = vi.mocked(terminalInstanceService.wake);
    wake.mockReset();

    const { registerPanelKind, unregisterPanelKind } =
      await import("@shared/config/panelKindRegistry");
    registerPanelKind({
      id: "pty-quiet-kind",
      name: "PTY Quiet",
      iconId: "test",
      color: "#000",
      hasPty: true,
      canRestart: true,
      canConvert: true,
      usesTerminalUi: true,
      extensionId: "test-policy-plugin",
      policy: { dockPopoverOnSpawn: false },
    });

    try {
      const { addPanel } = usePanelStore.getState();
      const id = await addPanel({
        kind: "pty-quiet-kind",
        requestedId: "pty-quiet-1",
        cwd: "/",
        location: "dock",
        bypassLimits: true,
        activateDockOnCreate: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(id).toBe("pty-quiet-1");
      const state = usePanelStore.getState();
      expect(state.panelsById[id!]).toBeDefined();
      // Popover suppressed by policy.
      expect(state.activeDockTerminalId).toBeNull();
      // Side-effect block also suppressed.
      expect(wake).not.toHaveBeenCalledWith("pty-quiet-1");
    } finally {
      unregisterPanelKind("pty-quiet-kind");
    }
  });
});

describe("defaultFocusOnCreate policy gate (#8946)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();
  });

  it("kind with defaultFocusOnCreate: false does not steal focus on grid spawn", async () => {
    const { registerPanelKind, unregisterPanelKind } =
      await import("@shared/config/panelKindRegistry");
    registerPanelKind({
      id: "no-focus-steal-kind",
      name: "No Focus Steal",
      iconId: "test",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      usesTerminalUi: false,
      extensionId: "test-policy-plugin",
      policy: { defaultFocusOnCreate: false },
    });

    try {
      const { addPanel } = usePanelStore.getState();
      // Seed an existing focused grid panel.
      const firstId = await addPanel({
        kind: "browser",
        requestedId: "anchor-focus",
        cwd: "/",
        location: "grid",
        bypassLimits: true,
      });
      expect(firstId).toBe("anchor-focus");
      expect(usePanelStore.getState().focusedId).toBe("anchor-focus");

      // Spawn the policy-gated kind into the grid — should NOT steal focus.
      const id = await addPanel({
        kind: "no-focus-steal-kind",
        requestedId: "quiet-grid-1",
        cwd: "/",
        location: "grid",
        bypassLimits: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(id).toBe("quiet-grid-1");
      const state = usePanelStore.getState();
      expect(state.panelsById[id!]).toBeDefined();
      // Anchor still holds focus, previousFocusedId is unchanged.
      expect(state.focusedId).toBe("anchor-focus");
    } finally {
      unregisterPanelKind("no-focus-steal-kind");
    }
  });

  it("kind without a defaultFocusOnCreate override (default true) does steal focus on grid spawn", async () => {
    const { addPanel } = usePanelStore.getState();
    const firstId = await addPanel({
      kind: "browser",
      requestedId: "anchor-2",
      cwd: "/",
      location: "grid",
      bypassLimits: true,
    });
    expect(firstId).toBe("anchor-2");
    expect(usePanelStore.getState().focusedId).toBe("anchor-2");

    const secondId = await addPanel({
      // browser only overrides dockFallbackTarget → defaultFocusOnCreate stays the default true.
      kind: "browser",
      requestedId: "stealer-2",
      cwd: "/",
      location: "grid",
      bypassLimits: true,
    });
    expect(secondId).toBe("stealer-2");
    expect(usePanelStore.getState().focusedId).toBe("stealer-2");
  });
});

describe("dock watchdog hardening (#7278)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();
  });

  it("spares activeDockTerminalId when panel exists in panelsById but would be filtered from dock view", async () => {
    const { closeDockTerminal } = usePanelStore.getState();
    expect(closeDockTerminal).toBeDefined();

    const targetId = "spared-by-panelsById";

    // Set the active worktree to a known value so we can create a
    // genuine worktree mismatch. The dockTerminals selector filters on
    // `worktreeId == null || worktreeId === activeWorktreeId`.
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a" });

    // Create a panel that WOULD be filtered out of dockTerminals due
    // to worktree mismatch (wt-b != wt-a), but still exists in the
    // canonical panelsById store. The panelsById guard in the watchdog
    // should spare it.
    usePanelStore.setState({
      panelsById: {
        [targetId]: {
          id: targetId,
          kind: "terminal" as const,
          title: "Test",
          location: "dock" as const,
          worktreeId: "wt-b",
        } as PtyPanelData,
      },
      panelIds: [targetId],
      activeDockTerminalId: targetId,
    });

    const state = usePanelStore.getState();
    expect(state.panelsById[targetId]).toBeDefined();
    expect(state.activeDockTerminalId).toBe(targetId);

    // The dockTerminals selector would NOT include this panel (wt-b != active wt-a),
    // but the panelsById guard should still spare it.
    const shouldSkipClose = Boolean(
      !state.activeDockTerminalId || state.panelsById[state.activeDockTerminalId]
    );
    expect(shouldSkipClose).toBe(true);

    // Call closeDockTerminal anyway to verify it works (the actual
    // watchdog would not call this).
    closeDockTerminal();
    expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
  });

  it("closes dock when panel is absent from both dockTerminals and panelsById", () => {
    const { closeDockTerminal } = usePanelStore.getState();

    // Set activeDockTerminalId to a non-existent panel ID (simulating
    // stale state after a panel was deleted without clearing the dock).
    usePanelStore.setState({ activeDockTerminalId: "phantom-id" });

    const state = usePanelStore.getState();
    expect(state.activeDockTerminalId).toBe("phantom-id");
    expect(state.panelsById["phantom-id"]).toBeUndefined();

    // The watchdog should close the dock — neither the filtered
    // dockTerminals view nor panelsById contains this ID.
    const shouldSkipClose = Boolean(
      !state.activeDockTerminalId || state.panelsById[state.activeDockTerminalId]
    );
    if (!shouldSkipClose) {
      closeDockTerminal();
    }
    expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
  });
});
