import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
    setInputLocked: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("../../persistence/terminalPersistence", () => ({
  terminalPersistence: {
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

const { useTerminalStore } = await import("../terminalStore");
const { useWorktreeSelectionStore, persistMruList } = await import("../worktreeStore");
const { useTerminalInputStore } = await import("../terminalInputStore");
const { useConsoleCaptureStore } = await import("../consoleCaptureStore");
const { useVoiceRecordingStore } = await import("../voiceRecordingStore");
const { unregisterInputController } = await import("../terminalInputStore");
const { semanticAnalysisService } = await import("@/services/SemanticAnalysisService");
const { initStoreOrchestrator, destroyStoreOrchestrator } =
  await import("../rendererStoreOrchestrator");

describe("rendererStoreOrchestrator", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    destroyStoreOrchestrator();
    initStoreOrchestrator();
    await useTerminalStore.getState().reset();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    useWorktreeSelectionStore.getState().reset();
    useConsoleCaptureStore.setState({ messages: new Map() });
    useVoiceRecordingStore.setState({ panelBuffers: {} });
  });

  afterEach(() => {
    destroyStoreOrchestrator();
  });

  it("tracks terminal focus in worktree store when focusedId changes", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-1" });

    const lastFocused = useWorktreeSelectionStore
      .getState()
      .lastFocusedTerminalByWorktree.get("wt-1");
    expect(lastFocused).toBe("term-1");
  });

  it("switches worktree when focusing a terminal in a different worktree", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-2",
          type: "terminal",
          title: "T2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-2",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-2" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("does not switch worktree when focusing a terminal in the same worktree", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-1" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("cleans up console capture store when terminal is removed", () => {
    const panelId = "browser-1";

    useTerminalStore.setState({
      terminals: [
        {
          id: panelId,
          type: "terminal",
          kind: "browser",
          title: "Browser",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
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

    useTerminalStore.getState().removeTerminal(panelId);

    expect(useConsoleCaptureStore.getState().messages.has(panelId)).toBe(false);
  });

  it("cleans up input store when terminal is removed", () => {
    const clearSpy = vi.spyOn(useTerminalInputStore.getState(), "clearTerminalState");

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    useTerminalStore.getState().removeTerminal("term-1");

    expect(clearSpy).toHaveBeenCalledWith("term-1");
  });

  it("clears worktree focus tracking when last-focused terminal is removed", () => {
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-1", "term-1");

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
    });

    useTerminalStore.getState().removeTerminal("term-1");

    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.has("wt-1")).toBe(
      false
    );
  });

  it("records terminal MRU on focus change", () => {
    const recordMruSpy = vi.spyOn(useTerminalStore.getState(), "recordMru");

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-1" });

    expect(recordMruSpy).toHaveBeenCalledWith("terminal:term-1");
  });

  it("does not fire side effects when focusedId is set to the same value", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
      focusedId: "term-1",
    });

    const trackSpy = vi.spyOn(useWorktreeSelectionStore.getState(), "trackTerminalFocus");

    // Set focusedId to the same value — should not fire
    useTerminalStore.setState({ focusedId: "term-1" });

    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("handles rapid A→B focus changes correctly", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "T2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-2",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-1" });
    useTerminalStore.setState({ focusedId: "term-2" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.get("wt-2")).toBe(
      "term-2"
    );
  });

  it("does not switch worktree when terminal has no worktreeId", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-1" });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("cleans up multiple terminals removed in one batch", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "t-1",
          type: "terminal",
          kind: "browser",
          title: "B1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "t-2",
          type: "terminal",
          kind: "browser",
          title: "B2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
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
    useTerminalStore.setState({ terminals: [] });

    expect(useConsoleCaptureStore.getState().messages.has("t-1")).toBe(false);
    expect(useConsoleCaptureStore.getState().messages.has("t-2")).toBe(false);
  });

  it("does not clear worktree focus tracking when removed terminal is not last-focused", () => {
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-1", "term-other");

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
    });

    useTerminalStore.getState().removeTerminal("term-1");

    // term-other is still tracked as last-focused for wt-1
    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.get("wt-1")).toBe(
      "term-other"
    );
  });

  it("auto-restores background panel when focused", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "bg-1",
          type: "terminal",
          title: "BG",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "background",
          worktreeId: "wt-1",
        },
      ],
    });

    const restoreSpy = vi.spyOn(useTerminalStore.getState(), "restoreBackgroundTerminal");

    useTerminalStore.setState({ focusedId: "bg-1" });

    expect(restoreSpy).toHaveBeenCalledWith("bg-1");
  });

  it("sets activeDockTerminalId when restoring a background panel to dock", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "dock-bg-1",
          type: "terminal",
          title: "Dock BG",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "background",
          worktreeId: "wt-1",
        },
      ],
      backgroundedTerminals: new Map([
        ["dock-bg-1", { id: "dock-bg-1", originalLocation: "dock" as const }],
      ]),
    });

    useTerminalStore.setState({ focusedId: "dock-bg-1" });

    expect(useTerminalStore.getState().activeDockTerminalId).toBe("dock-bg-1");
  });

  it("does not restore non-background panel when focused", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "grid-1",
          type: "terminal",
          title: "Grid",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-1",
        },
      ],
    });

    const restoreSpy = vi.spyOn(useTerminalStore.getState(), "restoreBackgroundTerminal");

    useTerminalStore.setState({ focusedId: "grid-1" });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it("cleans up voice recording store buffer when terminal is removed", () => {
    const panelId = "term-voice-1";

    useTerminalStore.setState({
      terminals: [
        {
          id: panelId,
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    useVoiceRecordingStore.getState().beginSession({ panelId });
    useVoiceRecordingStore.getState().appendDelta("test transcript");
    expect(useVoiceRecordingStore.getState().panelBuffers[panelId]).toBeDefined();

    useTerminalStore.getState().removeTerminal(panelId);

    expect(useVoiceRecordingStore.getState().panelBuffers[panelId]).toBeUndefined();
  });

  it("does not error when removing terminal without voice buffer", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-no-voice",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    expect(useVoiceRecordingStore.getState().panelBuffers["term-no-voice"]).toBeUndefined();

    useTerminalStore.getState().removeTerminal("term-no-voice");

    expect(useVoiceRecordingStore.getState().panelBuffers).toEqual({});
  });

  it("calls unregisterInputController when terminal is removed", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    useTerminalStore.getState().removeTerminal("term-1");

    expect(unregisterInputController).toHaveBeenCalledWith("term-1");
  });

  it("calls semanticAnalysisService.unregisterTerminal when terminal is removed", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    useTerminalStore.getState().removeTerminal("term-1");

    expect(semanticAnalysisService.unregisterTerminal).toHaveBeenCalledWith("term-1");
  });

  it("calls both new cleanup hooks for each terminal in batch removal", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "t-a",
          type: "terminal",
          title: "A",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "t-b",
          type: "terminal",
          title: "B",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
    });

    useTerminalStore.setState({ terminals: [] });

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
      useTerminalStore.setState({
        terminals: [
          {
            id: "t-1",
            type: "terminal",
            title: "T1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
          {
            id: "t-2",
            type: "terminal",
            title: "T2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
          {
            id: "t-3",
            type: "terminal",
            title: "T3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        ],
      });

      useTerminalStore.setState({ focusedId: "t-1" });
      useTerminalStore.setState({ focusedId: "t-2" });
      useTerminalStore.setState({ focusedId: "t-3" });

      expect(persistMruList).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);
      await Promise.resolve();

      expect(persistMruList).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls persistMruList after debounce delay on single focus change", async () => {
    vi.useFakeTimers();
    try {
      useTerminalStore.setState({
        terminals: [
          {
            id: "t-1",
            type: "terminal",
            title: "T1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        ],
      });

      useTerminalStore.setState({ focusedId: "t-1" });

      expect(persistMruList).not.toHaveBeenCalled();

      vi.advanceTimersByTime(149);
      await Promise.resolve();
      expect(persistMruList).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(persistMruList).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending persistMruList on destroy", async () => {
    vi.useFakeTimers();
    try {
      useTerminalStore.setState({
        terminals: [
          {
            id: "t-1",
            type: "terminal",
            title: "T1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
            worktreeId: "wt-1",
          },
        ],
      });

      useTerminalStore.setState({ focusedId: "t-1" });
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
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "T1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-2",
        },
      ],
    });

    useTerminalStore.setState({ focusedId: "term-1" });

    // Worktree should NOT have been switched since orchestrator is destroyed
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });
});
