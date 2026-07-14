import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PtyPanelData, PanelInstance } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    onBroadcastResult: vi.fn().mockReturnValue(() => {}),
    setFocusedTerminal: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({ agents: {} }),
    invalidate: vi.fn(),
    set: vi.fn(),
    reset: vi.fn(),
    stampVersion: vi.fn(),
  },
  cliAvailabilityClient: {
    refresh: vi.fn(),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    setInputLocked: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/services/SemanticAnalysisService", () => ({
  semanticAnalysisService: {
    unregisterTerminal: vi.fn(),
  },
}));

vi.mock("../terminalInputStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminalInputStore")>();
  return {
    ...actual,
    unregisterInputController: vi.fn(),
  };
});

vi.mock("../worktreeStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktreeStore")>();
  return {
    ...actual,
    persistMruList: vi.fn(),
  };
});

const { usePanelStore } = await import("../panelStore");
const { useWorktreeSelectionStore, persistMruList, suppressMruRecording } =
  await import("../worktreeStore");
const { useTerminalInputStore } = await import("../terminalInputStore");
const { useConsoleCaptureStore } = await import("../consoleCaptureStore");
const { useResourceMonitoringStore } = await import("../resourceMonitoringStore");
const { useVoiceRecordingStore } = await import("../voiceRecordingStore");
const { usePluginPanelBadgeStore } = await import("../pluginPanelBadgeStore");
const { unregisterInputController } = await import("../terminalInputStore");
const { semanticAnalysisService } = await import("@/services/SemanticAnalysisService");
const { useCliAvailabilityStore, cleanupCliAvailabilityStore } =
  await import("../cliAvailabilityStore");
const { useAgentSettingsStore, cleanupAgentSettingsStore } = await import("../agentSettingsStore");
const { agentSettingsClient } = await import("@/clients");
const { DEFAULT_AGENT_SETTINGS } = await import("@shared/types");
const { initStoreOrchestrator, destroyStoreOrchestrator } =
  await import("../rendererStoreOrchestrator");

describe("rendererStoreOrchestrator", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    destroyStoreOrchestrator();
    initStoreOrchestrator();
    await usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    useWorktreeSelectionStore.getState().reset();
    useConsoleCaptureStore.setState({ messages: new Map() });
    useResourceMonitoringStore.setState({ metrics: new Map() });
    useVoiceRecordingStore.setState({ panelBuffers: {} });
    usePluginPanelBadgeStore.setState({ badgesByPanelId: {} });
  });

  afterEach(() => {
    destroyStoreOrchestrator();
  });

  it("tracks terminal focus in worktree store when focusedId changes", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.setState({ focusedId: "term-1" });

    const lastFocused = useWorktreeSelectionStore
      .getState()
      .lastFocusedTerminalByWorktree.get("wt-1");
    expect(lastFocused).toBe("term-1");
  });

  it("switches worktree when focusing a terminal in a different worktree", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "term-2": {
          id: "term-2",
          title: "T2",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-2",
        },
      },
      panelIds: ["term-2"],
    });

    usePanelStore.setState({ focusedId: "term-2" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("does not switch worktree when focusing a terminal in the same worktree", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.setState({ focusedId: "term-1" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("cleans up console capture store when terminal is removed", () => {
    const panelId = "browser-1";

    usePanelStore.setState({
      panelsById: {
        [panelId]: {
          id: panelId,
          kind: "browser",
          title: "Browser",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        } as PanelInstance,
      },
      panelIds: [panelId],
    });

    useConsoleCaptureStore.getState().addStructuredMessage({
      id: 1,
      paneId: panelId,
      level: "log",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "test" }],
      summaryText: "test",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });

    expect(useConsoleCaptureStore.getState().messages.has(panelId)).toBe(true);

    usePanelStore.getState().removePanel(panelId);

    expect(useConsoleCaptureStore.getState().messages.has(panelId)).toBe(false);
  });

  it("prunes plugin panel badges when a terminal is removed", () => {
    const panelId = "term-badge";

    usePanelStore.setState({
      panelsById: {
        [panelId]: {
          id: panelId,
          title: "T",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: [panelId],
    });
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        [panelId]: { "plugin-1": { kind: "dot" } },
        keep: { "plugin-1": { kind: "dot" } },
      },
    });

    usePanelStore.getState().removePanel(panelId);

    const badges = usePluginPanelBadgeStore.getState().badgesByPanelId;
    expect(badges[panelId]).toBeUndefined();
    // Unrelated panels' badges survive the prune.
    expect(badges.keep).toEqual({ "plugin-1": { kind: "dot" } });
  });

  it("prunes plugin panel badges for every terminal removed in one batch", () => {
    usePanelStore.setState({
      panelsById: {
        a: {
          id: "a",
          title: "A",
          kind: "terminal" as const,
          cwd: "/",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        b: {
          id: "b",
          title: "B",
          kind: "terminal" as const,
          cwd: "/",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["a", "b"],
    });
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        a: { "plugin-1": { kind: "dot" } },
        b: { "plugin-1": { kind: "dot" } },
      },
    });

    usePanelStore.setState({ panelsById: {}, panelIds: [] });

    expect(usePluginPanelBadgeStore.getState().badgesByPanelId).toEqual({});
  });

  it("cleans up input store when terminal is removed", () => {
    const clearSpy = vi.spyOn(useTerminalInputStore.getState(), "clearTerminalState");

    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.getState().removePanel("term-1");

    expect(clearSpy).toHaveBeenCalledWith("term-1");
  });

  it("clears worktree focus tracking when last-focused terminal is removed", () => {
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-1", "term-1");

    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.getState().removePanel("term-1");

    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.has("wt-1")).toBe(
      false
    );
  });

  describe("stashed maximize cleanup (#11183)", () => {
    /** An inactive worktree whose maximized panel is `panelId`. */
    function stashMaximize(worktreeId: string, panelId: string) {
      useWorktreeSelectionStore.setState({
        maximizeByWorktree: new Map([
          [
            worktreeId,
            {
              maximizedId: panelId,
              maximizeTarget: { type: "panel" as const, id: panelId },
              preMaximizeLayout: null,
            },
          ],
        ]),
      });
    }
    function seedPanels(panels: { id: string; worktreeId: string }[]) {
      usePanelStore.setState({
        panelsById: Object.fromEntries(
          panels.map((p) => [
            p.id,
            {
              id: p.id,
              title: p.id,
              kind: "terminal" as const,
              cwd: "/test",
              cols: 80,
              rows: 24,
              location: "grid" as const,
              worktreeId: p.worktreeId,
            },
          ])
        ),
        panelIds: panels.map((p) => p.id),
      });
    }
    const stashedIds = () => useWorktreeSelectionStore.getState().maximizeByWorktree;

    it("drops the stash when the maximized panel of an inactive worktree is removed", () => {
      seedPanels([{ id: "term-1", worktreeId: "wt-1" }]);
      stashMaximize("wt-1", "term-1");

      usePanelStore.getState().removePanel("term-1");

      expect(stashedIds().has("wt-1")).toBe(false);
    });

    it("drops the stash when the maximized panel of an inactive worktree is trashed", () => {
      seedPanels([{ id: "term-1", worktreeId: "wt-1" }]);
      stashMaximize("wt-1", "term-1");

      usePanelStore.getState().trashPanel("term-1");

      // `trashPanel` flips `location` without shrinking `panelIds`, so the
      // removal subscriber never sees this — it needs the trash listener.
      expect(usePanelStore.getState().panelIds).toContain("term-1");
      expect(stashedIds().has("wt-1")).toBe(false);
    });

    it("keeps a stash when an unrelated panel in the same worktree is removed", () => {
      seedPanels([
        { id: "term-1", worktreeId: "wt-1" },
        { id: "term-2", worktreeId: "wt-1" },
      ]);
      stashMaximize("wt-1", "term-1");

      usePanelStore.getState().removePanel("term-2");

      expect(stashedIds().get("wt-1")?.maximizedId).toBe("term-1");
    });
  });

  it("records terminal MRU on focus change", () => {
    const recordMruSpy = vi.spyOn(usePanelStore.getState(), "recordMru");

    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.setState({ focusedId: "term-1" });

    expect(recordMruSpy).toHaveBeenCalledWith("terminal:term-1");
  });

  it("does not fire side effects when focusedId is set to the same value", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
      focusedId: "term-1",
    });

    const trackSpy = vi.spyOn(useWorktreeSelectionStore.getState(), "trackTerminalFocus");

    // Set focusedId to the same value — should not fire
    usePanelStore.setState({ focusedId: "term-1" });

    expect(trackSpy).not.toHaveBeenCalled();
  });

  // Issue #9933 — boot focus and suppression-window tests. Placed AFTER
  // the existing "does not fire side effects" test because
  // `vi.spyOn(useWorktreeSelectionStore.getState(), "trackTerminalFocus")`
  // wraps the underlying StateCreator function (which is shared by every
  // state object via the closure), so a spy installed in one test keeps
  // receiving calls from later tests that re-install on the same function
  // — Vitest returns the existing spy on re-wrap, and its mock state
  // carries over. Running these after the existing side-effect test
  // keeps the order predictable without requiring `vi.restoreAllMocks`.
  it("skips MRU recording for boot focus when suppressMruRecording is on (issue #9933)", () => {
    // Boot-time focus (post-hydration) must NOT prepend the panel to
    // `mruList` — that would silently demote the user's actual
    // last-focused terminal on every cold boot. The L1c subscription
    // checks `isMruRecordingSuppressed()` and bails; the L1a (focus
    // tracking) and L1b (worktree switch) subscriptions still fire so
    // the boot pick correctly seeds `lastFocusedTerminalByWorktree`
    // (which is runtime-only and has no other writer).
    const recordMruSpy = vi.spyOn(usePanelStore.getState(), "recordMru");
    const trackSpy = vi.spyOn(useWorktreeSelectionStore.getState(), "trackTerminalFocus");
    trackSpy.mockClear();
    recordMruSpy.mockClear();

    usePanelStore.setState({
      panelsById: {
        "term-boot": {
          id: "term-boot",
          title: "T-boot",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-boot"],
    });

    suppressMruRecording(true);
    try {
      usePanelStore.setState({ focusedId: "term-boot" });
    } finally {
      suppressMruRecording(false);
    }

    // L1c: MRU recording gated.
    expect(recordMruSpy).not.toHaveBeenCalled();
    // L1a: focus tracking still fires — seeds `lastFocusedTerminalByWorktree`
    // so future worktree switches can restore last-focus (#9512).
    expect(trackSpy).toHaveBeenCalledWith("wt-1", "term-boot");
  });

  it("MRU recording resumes immediately after suppressMruRecording is lifted (issue #9933)", () => {
    // Verifies the suppression window is correctly scoped to the boot pick
    // and doesn't leak into subsequent user focus changes.
    const recordMruSpy = vi.spyOn(usePanelStore.getState(), "recordMru");
    recordMruSpy.mockClear();

    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
    });

    // Suppress window for the boot pick — a null→"term-1" change is
    // gated, so no recordMru.
    suppressMruRecording(true);
    usePanelStore.setState({ focusedId: "term-1" });
    suppressMruRecording(false);
    recordMruSpy.mockClear();

    // A subsequent user focus on a DIFFERENT panel (after suppress is
    // lifted) MUST record. Using a different id is necessary because
    // `subscribeWithSelector` compares with `Object.is` — a same-value
    // set wouldn't fire the subscription at all.
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
        "term-2": {
          id: "term-2",
          title: "T2",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1", "term-2"],
      focusedId: "term-2",
    });
    expect(recordMruSpy).toHaveBeenCalledWith("terminal:term-2");
  });

  it("handles rapid A→B focus changes correctly", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
        "term-2": {
          id: "term-2",
          title: "T2",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-2",
        },
      },
      panelIds: ["term-1", "term-2"],
    });

    usePanelStore.setState({ focusedId: "term-1" });
    usePanelStore.setState({ focusedId: "term-2" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.get("wt-2")).toBe(
      "term-2"
    );
  });

  it("does not switch worktree when terminal has no worktreeId", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.setState({ focusedId: "term-1" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("cleans up multiple terminals removed in one batch", () => {
    usePanelStore.setState({
      panelsById: {
        "t-1": {
          id: "t-1",
          kind: "browser",
          title: "B1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        } as PanelInstance,
        "t-2": {
          id: "t-2",
          kind: "browser",
          title: "B2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        } as PanelInstance,
      },
      panelIds: ["t-1", "t-2"],
    });

    useConsoleCaptureStore.getState().addStructuredMessage({
      id: 1,
      paneId: "t-1",
      level: "log",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "a" }],
      summaryText: "a",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });
    useConsoleCaptureStore.getState().addStructuredMessage({
      id: 2,
      paneId: "t-2",
      level: "log",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "b" }],
      summaryText: "b",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });

    // Remove both terminals at once
    usePanelStore.setState({ panelsById: {}, panelIds: [] });

    expect(useConsoleCaptureStore.getState().messages.has("t-1")).toBe(false);
    expect(useConsoleCaptureStore.getState().messages.has("t-2")).toBe(false);
  });

  it("does not clear worktree focus tracking when removed terminal is not last-focused", () => {
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-1", "term-other");

    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.getState().removePanel("term-1");

    // term-other is still tracked as last-focused for wt-1
    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.get("wt-1")).toBe(
      "term-other"
    );
  });

  it("auto-restores background panel when focused", () => {
    usePanelStore.setState({
      panelsById: {
        "bg-1": {
          id: "bg-1",
          title: "BG",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "background",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["bg-1"],
    });

    const restoreSpy = vi.spyOn(usePanelStore.getState(), "restoreBackgroundTerminal");

    usePanelStore.setState({ focusedId: "bg-1" });

    expect(restoreSpy).toHaveBeenCalledWith("bg-1");
  });

  it("sets activeDockTerminalId when restoring a background panel to dock", () => {
    usePanelStore.setState({
      panelsById: {
        "dock-bg-1": {
          id: "dock-bg-1",
          title: "Dock BG",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "background",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["dock-bg-1"],
      backgroundedTerminals: new Map([
        ["dock-bg-1", { id: "dock-bg-1", originalLocation: "dock" as const }],
      ]),
    });

    usePanelStore.setState({ focusedId: "dock-bg-1" });

    expect(usePanelStore.getState().activeDockTerminalId).toBe("dock-bg-1");
  });

  it("does not restore non-background panel when focused", () => {
    usePanelStore.setState({
      panelsById: {
        "grid-1": {
          id: "grid-1",
          title: "Grid",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      },
      panelIds: ["grid-1"],
    });

    const restoreSpy = vi.spyOn(usePanelStore.getState(), "restoreBackgroundTerminal");

    usePanelStore.setState({ focusedId: "grid-1" });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it("cleans up voice recording store buffer when terminal is removed", () => {
    const panelId = "term-voice-1";

    usePanelStore.setState({
      panelsById: {
        [panelId]: {
          id: panelId,
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: [panelId],
    });

    useVoiceRecordingStore.getState().beginSession({ panelId });
    useVoiceRecordingStore.getState().appendDelta("test transcript");
    expect(useVoiceRecordingStore.getState().panelBuffers[panelId]).toBeDefined();

    usePanelStore.getState().removePanel(panelId);

    expect(useVoiceRecordingStore.getState().panelBuffers[panelId]).toBeUndefined();
  });

  it("prunes resource-monitoring metrics for the removed panel only", () => {
    usePanelStore.setState({
      panelsById: {
        "term-a": {
          id: "term-a",
          title: "A",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        "term-b": {
          id: "term-b",
          title: "B",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-a", "term-b"],
    });

    useResourceMonitoringStore.getState().updateMetrics({
      "term-a": { cpuPercent: 5, memoryKb: 1000, breakdown: [] },
      "term-b": { cpuPercent: 7, memoryKb: 2000, breakdown: [] },
    });
    expect(useResourceMonitoringStore.getState().metrics.has("term-a")).toBe(true);
    expect(useResourceMonitoringStore.getState().metrics.has("term-b")).toBe(true);

    usePanelStore.getState().removePanel("term-a");

    expect(useResourceMonitoringStore.getState().metrics.has("term-a")).toBe(false);
    expect(useResourceMonitoringStore.getState().metrics.has("term-b")).toBe(true);
  });

  it("does not error when removing a panel without resource metrics", () => {
    usePanelStore.setState({
      panelsById: {
        "term-no-metrics": {
          id: "term-no-metrics",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-no-metrics"],
    });

    expect(useResourceMonitoringStore.getState().metrics.has("term-no-metrics")).toBe(false);

    expect(() => usePanelStore.getState().removePanel("term-no-metrics")).not.toThrow();
    expect(useResourceMonitoringStore.getState().metrics.size).toBe(0);
  });

  it("prunes metrics for every panel in a bulk removal, keeping survivors", () => {
    usePanelStore.setState({
      panelsById: {
        "m-1": {
          id: "m-1",
          title: "1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        "m-2": {
          id: "m-2",
          title: "2",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        "m-3": {
          id: "m-3",
          title: "3",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["m-1", "m-2", "m-3"],
    });

    useResourceMonitoringStore.getState().updateMetrics({
      "m-1": { cpuPercent: 1, memoryKb: 100, breakdown: [] },
      "m-2": { cpuPercent: 2, memoryKb: 200, breakdown: [] },
      "m-3": { cpuPercent: 3, memoryKb: 300, breakdown: [] },
    });

    // Shrink to a single survivor in one setState (e.g. worktree teardown).
    usePanelStore.setState({
      panelsById: { "m-3": usePanelStore.getState().panelsById["m-3"]! },
      panelIds: ["m-3"],
    });

    expect(useResourceMonitoringStore.getState().metrics.has("m-1")).toBe(false);
    expect(useResourceMonitoringStore.getState().metrics.has("m-2")).toBe(false);
    expect(useResourceMonitoringStore.getState().metrics.has("m-3")).toBe(true);
  });

  it("removePanel stays a no-op when metrics were already pruned (onExit + force-removal)", () => {
    usePanelStore.setState({
      panelsById: {
        "dup-1": {
          id: "dup-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["dup-1"],
    });

    useResourceMonitoringStore.getState().updateMetrics({
      "dup-1": { cpuPercent: 5, memoryKb: 1000, breakdown: [] },
    });

    // Simulate the PTY onExit path (lifecycle.ts) pruning first.
    useResourceMonitoringStore.getState().removePanel("dup-1");
    expect(useResourceMonitoringStore.getState().metrics.has("dup-1")).toBe(false);

    // Then the orchestrator's force-removal path fires for the same id.
    expect(() => usePanelStore.getState().removePanel("dup-1")).not.toThrow();
    expect(useResourceMonitoringStore.getState().metrics.has("dup-1")).toBe(false);
  });

  it("does not error when removing terminal without voice buffer", () => {
    usePanelStore.setState({
      panelsById: {
        "term-no-voice": {
          id: "term-no-voice",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-no-voice"],
    });

    expect(useVoiceRecordingStore.getState().panelBuffers["term-no-voice"]).toBeUndefined();

    usePanelStore.getState().removePanel("term-no-voice");

    expect(useVoiceRecordingStore.getState().panelBuffers).toEqual({});
  });

  it("calls unregisterInputController when terminal is removed", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.getState().removePanel("term-1");

    expect(unregisterInputController).toHaveBeenCalledWith("term-1");
  });

  it("calls semanticAnalysisService.unregisterTerminal when terminal is removed", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.getState().removePanel("term-1");

    expect(semanticAnalysisService.unregisterTerminal).toHaveBeenCalledWith("term-1");
  });

  it("calls both new cleanup hooks for each terminal in batch removal", () => {
    usePanelStore.setState({
      panelsById: {
        "t-a": {
          id: "t-a",
          title: "A",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        "t-b": {
          id: "t-b",
          title: "B",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["t-a", "t-b"],
    });

    usePanelStore.setState({ panelsById: {}, panelIds: [] });

    expect(unregisterInputController).toHaveBeenCalledTimes(2);
    expect(unregisterInputController).toHaveBeenCalledWith("t-a");
    expect(unregisterInputController).toHaveBeenCalledWith("t-b");
    expect(semanticAnalysisService.unregisterTerminal).toHaveBeenCalledTimes(2);
    expect(semanticAnalysisService.unregisterTerminal).toHaveBeenCalledWith("t-a");
    expect(semanticAnalysisService.unregisterTerminal).toHaveBeenCalledWith("t-b");
  });

  it("debounces persistMruList during rapid focus changes", async () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({
        panelsById: {
          "t-1": {
            id: "t-1",
            title: "T1",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
          "t-2": {
            id: "t-2",
            title: "T2",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
          "t-3": {
            id: "t-3",
            title: "T3",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        },
        panelIds: ["t-1", "t-2", "t-3"],
      });

      usePanelStore.setState({ focusedId: "t-1" });
      usePanelStore.setState({ focusedId: "t-2" });
      usePanelStore.setState({ focusedId: "t-3" });

      expect(persistMruList).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(persistMruList).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls persistMruList after debounce delay on single focus change", async () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({
        panelsById: {
          "t-1": {
            id: "t-1",
            title: "T1",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        },
        panelIds: ["t-1"],
      });

      usePanelStore.setState({ focusedId: "t-1" });

      expect(persistMruList).not.toHaveBeenCalled();

      vi.advanceTimersByTime(999);
      await Promise.resolve();
      expect(persistMruList).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(persistMruList).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record or persist MRU when a non-PTY panel is focused (#9922)", async () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({
        panelsById: {
          "br-1": {
            id: "br-1",
            title: "Browser",
            kind: "browser" as const,
            location: "grid",
          } as PanelInstance,
        },
        panelIds: ["br-1"],
        mruList: [],
      });

      usePanelStore.setState({ focusedId: "br-1" });

      vi.advanceTimersByTime(150);
      await Promise.resolve();

      expect(persistMruList).not.toHaveBeenCalled();
      expect(usePanelStore.getState().mruList).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record MRU for excludeFromPersistence terminals (help/overlay) (#9922)", async () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({
        panelsById: {
          "help-1": {
            id: "help-1",
            title: "Help",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            excludeFromPersistence: true,
          },
        },
        panelIds: ["help-1"],
        mruList: [],
      });

      usePanelStore.setState({ focusedId: "help-1" });

      vi.advanceTimersByTime(150);
      await Promise.resolve();

      expect(persistMruList).not.toHaveBeenCalled();
      expect(usePanelStore.getState().mruList).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounced persist reads the live mruList at fire time, not schedule time (#9922)", async () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({
        panelsById: {
          "t-1": {
            id: "t-1",
            title: "T1",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        },
        panelIds: ["t-1"],
      });

      // Focusing schedules the debounced persist and records terminal:t-1.
      usePanelStore.setState({ focusedId: "t-1" });

      // Simulate a deliberate worktree selection updating the live MRU list
      // before the debounce fires. The stale-args bug would persist the list
      // captured at schedule time and clobber this promotion.
      usePanelStore.setState({ mruList: ["worktree:wt-9", "terminal:t-1"] });

      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(persistMruList).toHaveBeenCalledTimes(1);
      expect(persistMruList).toHaveBeenLastCalledWith(["worktree:wt-9", "terminal:t-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending persistMruList on destroy", async () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({
        panelsById: {
          "t-1": {
            id: "t-1",
            title: "T1",
            kind: "terminal" as const,
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        },
        panelIds: ["t-1"],
      });

      usePanelStore.setState({ focusedId: "t-1" });
      destroyStoreOrchestrator();

      vi.advanceTimersByTime(150);
      await Promise.resolve();

      expect(persistMruList).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup function prevents further reactions", () => {
    destroyStoreOrchestrator();

    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          title: "T1",
          kind: "terminal" as const,
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-2",
        },
      },
      panelIds: ["term-1"],
    });

    usePanelStore.setState({ focusedId: "term-1" });

    // Worktree should NOT have been switched since orchestrator is destroyed
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  describe("availability → agent-settings sync (issue #5158)", () => {
    beforeEach(() => {
      cleanupCliAvailabilityStore();
      cleanupAgentSettingsStore();
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockReset();
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ agents: {} });
    });

    afterEach(() => {
      cleanupCliAvailabilityStore();
      cleanupAgentSettingsStore();
    });

    it("re-runs agentSettings normalization when hasRealData transitions false → true", async () => {
      useAgentSettingsStore.setState({
        settings: { agents: {} },
        isInitialized: true,
        isLoading: false,
        error: null,
      });
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockClear();

      useCliAvailabilityStore.setState({ hasRealData: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(agentSettingsClient.get).toHaveBeenCalledTimes(1);
    });

    it("does not fire on unrelated cliAvailabilityStore updates", () => {
      useCliAvailabilityStore.setState({ hasRealData: true });

      useAgentSettingsStore.setState({
        settings: { agents: {} },
        isInitialized: true,
        isLoading: false,
        error: null,
      });
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockClear();

      // Mutate a sibling flag without changing `availability` or the
      // `hasRealData` transition — must NOT trigger a re-normalize.
      useCliAvailabilityStore.setState({ isRefreshing: true });

      expect(agentSettingsClient.get).not.toHaveBeenCalled();
    });

    it("re-runs normalization when availability ref changes after initial boot", async () => {
      useCliAvailabilityStore.setState({
        availability: { claude: "missing" } as never,
        hasRealData: true,
      });

      useAgentSettingsStore.setState({
        settings: { agents: {} },
        isInitialized: true,
        isLoading: false,
        error: null,
      });
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockClear();

      // Simulate the user installing a CLI outside Daintree: focus listener
      // refreshes cliAvailabilityStore, which swaps the `availability` ref.
      useCliAvailabilityStore.setState({
        availability: { claude: "ready" } as never,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(agentSettingsClient.get).toHaveBeenCalledTimes(1);
    });

    it("skips refresh when agentSettingsStore is not yet initialized", () => {
      // Not yet initialized — initial store state.
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockClear();

      useCliAvailabilityStore.setState({ hasRealData: true });

      expect(agentSettingsClient.get).not.toHaveBeenCalled();
    });

    it("refreshes after agent settings finishes loading if availability landed during the load", async () => {
      useAgentSettingsStore.setState({
        settings: null,
        isInitialized: false,
        isLoading: true,
        error: null,
      });
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        DEFAULT_AGENT_SETTINGS
      );
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockClear();

      useCliAvailabilityStore.setState({
        availability: { claude: "ready", codex: "installed" } as never,
        hasRealData: true,
      });
      await Promise.resolve();
      expect(agentSettingsClient.get).not.toHaveBeenCalled();

      useAgentSettingsStore.setState({
        settings: { agents: {} },
        isInitialized: true,
        isLoading: false,
        error: null,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(agentSettingsClient.get).toHaveBeenCalledTimes(1);
      const settings = useAgentSettingsStore.getState().settings;
      expect(settings?.settingsVersion).toBe(2);
      expect(settings?.agents.claude?.pinned).toBe(true);
      expect(settings?.agents.codex?.pinned).toBe(true);
    });

    it("stops firing after the orchestrator is destroyed", () => {
      useAgentSettingsStore.setState({
        settings: { agents: {} },
        isInitialized: true,
        isLoading: false,
        error: null,
      });
      destroyStoreOrchestrator();
      (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockClear();

      useCliAvailabilityStore.setState({ hasRealData: true });

      expect(agentSettingsClient.get).not.toHaveBeenCalled();
    });
  });

  describe("storeAccessors wiring", () => {
    it("populates accessor slots so projectStore.switchProject can read panel + worktree state", async () => {
      const { getPanelStoreSnapshot, getWorktreeSelectionSnapshot } =
        await import("../storeAccessors");

      usePanelStore.setState({
        panelsById: {
          "browser-1": {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            location: "grid",
          },
        },
        panelIds: ["browser-1"],
      });
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-real" });

      const panelSnapshot = getPanelStoreSnapshot();
      expect(panelSnapshot?.panelIds).toEqual(["browser-1"]);
      expect(panelSnapshot?.panelsById["browser-1"]?.kind).toBe("browser");

      const worktreeSnapshot = getWorktreeSelectionSnapshot();
      expect(worktreeSnapshot?.activeWorktreeId).toBe("wt-real");
    });

    it("clears accessor slots on destroy so consumers see the null fallback before re-init", async () => {
      const { getPanelStoreSnapshot, getWorktreeSelectionSnapshot, getFleetArmedIds } =
        await import("../storeAccessors");

      // Sanity: init populated slots
      expect(getPanelStoreSnapshot()).not.toBeNull();

      destroyStoreOrchestrator();

      expect(getPanelStoreSnapshot()).toBeNull();
      expect(getWorktreeSelectionSnapshot()).toBeNull();
      expect(getFleetArmedIds()).toBeNull();

      initStoreOrchestrator();

      expect(getPanelStoreSnapshot()).not.toBeNull();
    });
  });

  describe("fleet-arming panel pruning", () => {
    it("does not double-prune after destroy/re-init cycle", async () => {
      const { useFleetArmingStore } = await import("../fleetArmingStore");
      useFleetArmingStore.setState({
        armedIds: new Set<string>(),
        armOrder: [],
        armOrderById: {},
        lastArmedId: null,
        broadcastSignal: 0,
        previewArmedIds: new Set<string>(),
      });

      usePanelStore.setState({
        panelsById: {
          "agent-a": {
            id: "agent-a",
            kind: "terminal",
            title: "A",
            location: "grid",
            worktreeId: "wt-1",
            detectedAgentId: "claude",
            everDetectedAgent: true,
            agentState: "idle",
            hasPty: true,
          } as PtyPanelData,
          "agent-b": {
            id: "agent-b",
            kind: "terminal",
            title: "B",
            location: "grid",
            worktreeId: "wt-1",
            detectedAgentId: "claude",
            everDetectedAgent: true,
            agentState: "idle",
            hasPty: true,
          } as PtyPanelData,
        },
        panelIds: ["agent-a", "agent-b"],
      });
      useFleetArmingStore.getState().armIds(["agent-a", "agent-b"]);

      destroyStoreOrchestrator();
      initStoreOrchestrator();

      const pruneSpy = vi.spyOn(useFleetArmingStore.getState(), "prune");

      // Trigger one panel removal — should fire prune exactly once even though
      // the subscription was disposed and re-registered.
      usePanelStore.setState({
        panelsById: {
          "agent-a": usePanelStore.getState().panelsById["agent-a"]!,
        },
        panelIds: ["agent-a"],
      });

      expect(pruneSpy).toHaveBeenCalledTimes(1);
    });

    it("prunes stale armed ids on re-init when a panel became ineligible while torn down", async () => {
      const { useFleetArmingStore } = await import("../fleetArmingStore");
      useFleetArmingStore.setState({
        armedIds: new Set<string>(),
        armOrder: [],
        armOrderById: {},
        lastArmedId: null,
        broadcastSignal: 0,
        previewArmedIds: new Set<string>(),
      });

      usePanelStore.setState({
        panelsById: {
          "agent-a": {
            id: "agent-a",
            kind: "terminal",
            title: "A",
            location: "grid",
            worktreeId: "wt-1",
            detectedAgentId: "claude",
            everDetectedAgent: true,
            agentState: "idle",
            hasPty: true,
          } as PtyPanelData,
        },
        panelIds: ["agent-a"],
      });
      useFleetArmingStore.getState().armIds(["agent-a"]);

      // Subscription torn down while panel state mutates underneath.
      destroyStoreOrchestrator();
      usePanelStore.setState({
        panelsById: {
          "agent-a": {
            ...usePanelStore.getState().panelsById["agent-a"]!,
            location: "trash",
          },
        },
        panelIds: ["agent-a"],
      });

      // Re-init triggers the initial reconciliation pass.
      initStoreOrchestrator();

      expect([...useFleetArmingStore.getState().armedIds]).toEqual([]);
    });
  });

  describe("fleet failure auto-clear (issue #9923)", () => {
    type FleetStores = {
      useFleetArmingStore: typeof import("../fleetArmingStore").useFleetArmingStore;
      useFleetFailureStore: typeof import("../fleetFailureStore").useFleetFailureStore;
    };

    async function loadStores(): Promise<FleetStores> {
      const { useFleetArmingStore } = await import("../fleetArmingStore");
      const { useFleetFailureStore } = await import("../fleetFailureStore");
      return { useFleetArmingStore, useFleetFailureStore };
    }

    function seedFleetPanels(): void {
      usePanelStore.setState({
        panelsById: {
          "agent-a": {
            id: "agent-a",
            kind: "terminal",
            title: "A",
            location: "grid",
            worktreeId: "wt-1",
            detectedAgentId: "claude",
            everDetectedAgent: true,
            agentState: "idle",
            hasPty: true,
          } as PtyPanelData,
          "agent-b": {
            id: "agent-b",
            kind: "terminal",
            title: "B",
            location: "grid",
            worktreeId: "wt-1",
            detectedAgentId: "claude",
            everDetectedAgent: true,
            agentState: "idle",
            hasPty: true,
          } as PtyPanelData,
        },
        panelIds: ["agent-a", "agent-b"],
      });
    }

    function resetFleetStores(stores: FleetStores): void {
      stores.useFleetArmingStore.setState({
        armedIds: new Set<string>(),
        armOrder: [],
        armOrderById: {},
        lastArmedId: null,
        broadcastSignal: 0,
        previewArmedIds: new Set<string>(),
      });
      stores.useFleetFailureStore.setState({ failedIds: new Set(), payload: null });
    }

    it("halts auto-clear after destroy — fleet drain during torn-down does not clear", async () => {
      const stores = await loadStores();
      resetFleetStores(stores);
      seedFleetPanels();
      stores.useFleetArmingStore.getState().armIds(["agent-a", "agent-b"]);
      stores.useFleetFailureStore.getState().recordFailure("p", ["agent-a", "agent-b"]);

      // Subscription torn down; the next armed-set change has no listener.
      destroyStoreOrchestrator();
      stores.useFleetArmingStore.getState().clear();

      // The drain happened, but failures persist because the subscription
      // is gone. Initial reconciliation runs on the NEXT re-init.
      expect(stores.useFleetFailureStore.getState().failedIds).toEqual(
        new Set(["agent-a", "agent-b"])
      );
      expect(stores.useFleetFailureStore.getState().payload).toBe("p");
    });

    it("reconciles drained fleet on re-init (initial pass picks up the missed clear)", async () => {
      const stores = await loadStores();
      resetFleetStores(stores);
      seedFleetPanels();
      stores.useFleetArmingStore.getState().armIds(["agent-a", "agent-b"]);
      stores.useFleetFailureStore.getState().recordFailure("p", ["agent-a", "agent-b"]);

      // Tear down, drain the fleet while the subscription is gone, confirm
      // the failures are still present (no auto-clear fired).
      destroyStoreOrchestrator();
      stores.useFleetArmingStore.getState().clear();
      expect(stores.useFleetFailureStore.getState().failedIds.size).toBe(2);

      // Re-init: the initial reconciliation pass sees the drained armed
      // set and clears the stale failures without needing a fresh event.
      initStoreOrchestrator();
      expect(stores.useFleetFailureStore.getState().failedIds.size).toBe(0);
      expect(stores.useFleetFailureStore.getState().payload).toBeNull();
    });

    it("reconciles partial disarm on re-init (initial pass dismisses stale per-pane)", async () => {
      const stores = await loadStores();
      resetFleetStores(stores);
      seedFleetPanels();
      stores.useFleetArmingStore.getState().armIds(["agent-a", "agent-b"]);
      stores.useFleetFailureStore.getState().recordFailure("p", ["agent-a", "agent-b"]);

      // Tear down, disarm one pane while the subscription is gone.
      destroyStoreOrchestrator();
      stores.useFleetArmingStore.getState().disarmId("agent-a");

      // Re-init: the initial pass sees `failedIds = {a, b}` but
      // `armedIds = {b}`, and dismisses just the stale `a`.
      initStoreOrchestrator();
      expect(stores.useFleetFailureStore.getState().failedIds).toEqual(new Set(["agent-b"]));
      expect(stores.useFleetFailureStore.getState().payload).toBe("p");
    });

    it("listener continues to fire for post-re-init armed-set changes", async () => {
      const stores = await loadStores();
      resetFleetStores(stores);
      seedFleetPanels();

      destroyStoreOrchestrator();
      // Re-init with a non-empty armed set already in place.
      stores.useFleetArmingStore.getState().armIds(["agent-a", "agent-b"]);
      initStoreOrchestrator();
      stores.useFleetFailureStore.getState().recordFailure("p", ["agent-a", "agent-b"]);

      // Listener should still fire on a drain that happens AFTER re-init.
      stores.useFleetArmingStore.getState().clear();
      expect(stores.useFleetFailureStore.getState().failedIds.size).toBe(0);
      expect(stores.useFleetFailureStore.getState().payload).toBeNull();
    });
  });
});
