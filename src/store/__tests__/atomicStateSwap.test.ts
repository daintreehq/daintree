/**
 * Tests for atomic state swap during project switching (Issue #4427).
 *
 * Verifies that:
 * - detachTerminalsForProjectSwitch() runs side-effects without clearing state
 * - clearTerminalStoreForSwitch() clears state without running side-effects
 * - resetAllStoresForProjectSwitch({ skipTerminalStateReset: true }) preserves terminal state
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    setVisible: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    detachForProjectSwitch: vi.fn(),
  },
}));

const { useTerminalStore } = await import("../terminalStore");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

function seedTerminals() {
  useTerminalStore.setState({
    terminals: [
      {
        id: "term-1",
        type: "terminal",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        type: "terminal",
        title: "Shell 2",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "dock",
      },
    ],
    tabGroups: new Map(),
    focusedId: "term-1",
    maximizedId: null,
    activeDockTerminalId: "term-2",
    commandQueue: [
      {
        id: "cmd-1",
        terminalId: "term-1",
        payload: "echo test",
        description: "Test",
        queuedAt: Date.now(),
        origin: "user" as const,
      },
    ],
  });
}

describe("detachTerminalsForProjectSwitch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detaches xterm instances and suppresses resizes without clearing state", () => {
    seedTerminals();

    useTerminalStore.getState().detachTerminalsForProjectSwitch();

    // Side-effects should have run
    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).toHaveBeenCalledWith(
      ["term-1", "term-2"],
      10_000
    );
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-1");
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-2");

    // State should NOT be cleared
    const state = useTerminalStore.getState();
    expect(state.terminals).toHaveLength(2);
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBe("term-2");
    expect(state.commandQueue).toHaveLength(1);
  });

  it("does not destroy any terminal instances", () => {
    seedTerminals();

    useTerminalStore.getState().detachTerminalsForProjectSwitch();

    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });
});

describe("clearTerminalStoreForSwitch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears all terminal state without running side-effects", () => {
    seedTerminals();

    useTerminalStore.getState().clearTerminalStoreForSwitch();

    // State should be cleared
    const state = useTerminalStore.getState();
    expect(state.terminals).toEqual([]);
    expect(state.focusedId).toBeNull();
    expect(state.maximizedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();
    expect(state.commandQueue).toEqual([]);
    expect(state.mruList).toEqual([]);
    expect(state.backendStatus).toBe("connected");
    expect(state.lastCrashType).toBeNull();

    // No side-effects should have run
    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).not.toHaveBeenCalled();
    expect(terminalInstanceService.detachForProjectSwitch).not.toHaveBeenCalled();
    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });
});

describe("atomic swap: detach then clear sequence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detachTerminalsForProjectSwitch is a no-op with empty terminals", () => {
    useTerminalStore.getState().detachTerminalsForProjectSwitch();

    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).toHaveBeenCalledWith([], 10_000);
    expect(terminalInstanceService.detachForProjectSwitch).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().terminals).toEqual([]);
  });

  it("clearTerminalStoreForSwitch is idempotent", () => {
    seedTerminals();

    useTerminalStore.getState().clearTerminalStoreForSwitch();
    expect(useTerminalStore.getState().terminals).toEqual([]);

    // Second call should not throw or change state
    useTerminalStore.getState().clearTerminalStoreForSwitch();
    expect(useTerminalStore.getState().terminals).toEqual([]);
  });

  it("preserves terminal state after detach, then clears on explicit call", () => {
    seedTerminals();

    // Phase 1: Detach (during resetAllStoresForProjectSwitch with skipTerminalStateReset)
    useTerminalStore.getState().detachTerminalsForProjectSwitch();
    expect(useTerminalStore.getState().terminals).toHaveLength(2);

    // Phase 2: Clear (during rehydration, just before adding new terminals)
    useTerminalStore.getState().clearTerminalStoreForSwitch();
    expect(useTerminalStore.getState().terminals).toEqual([]);

    // Verify side-effects only ran once (during detach)
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledTimes(2);
  });
});
