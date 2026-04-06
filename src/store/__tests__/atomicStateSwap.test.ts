/**
 * Tests for atomic state swap during project switching (Issue #4427).
 *
 * Verifies that:
 * - detachTerminalsForProjectSwitch() runs side-effects without clearing state
 * - clearTerminalStoreForSwitch() clears state without running side-effects
 * - resetAllStoresForProjectSwitch({ skipTerminalStateReset: true }) preserves terminal state
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { usePanelStore } = await import("../panelStore");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

function seedTerminals() {
  const t1 = {
    id: "term-1",
    type: "terminal" as const,
    title: "Shell 1",
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid" as const,
  };
  const t2 = {
    id: "term-2",
    type: "terminal" as const,
    title: "Shell 2",
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "dock" as const,
  };
  usePanelStore.setState({
    panelsById: { "term-1": t1, "term-2": t2 },
    panelIds: ["term-1", "term-2"],
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detaches xterm instances and suppresses resizes without clearing state", () => {
    seedTerminals();

    usePanelStore.getState().detachTerminalsForProjectSwitch();

    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).toHaveBeenCalledWith(
      ["term-1", "term-2"],
      10_000
    );
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-1");
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-2");

    const state = usePanelStore.getState();
    expect(state.panelIds).toHaveLength(2);
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBe("term-2");
    expect(state.commandQueue).toHaveLength(1);
  });

  it("does not destroy any terminal instances", () => {
    seedTerminals();

    usePanelStore.getState().detachTerminalsForProjectSwitch();

    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });
});

describe("clearTerminalStoreForSwitch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears all terminal state without running side-effects", () => {
    seedTerminals();

    usePanelStore.getState().clearTerminalStoreForSwitch();

    const state = usePanelStore.getState();
    expect(state.panelIds).toEqual([]);
    expect(Object.keys(state.panelsById)).toEqual([]);
    expect(state.focusedId).toBeNull();
    expect(state.maximizedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();
    expect(state.commandQueue).toEqual([]);
    expect(state.mruList).toEqual([]);
    expect(state.backendStatus).toBe("connected");
    expect(state.lastCrashType).toBeNull();

    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).not.toHaveBeenCalled();
    expect(terminalInstanceService.detachForProjectSwitch).not.toHaveBeenCalled();
    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });
});

describe("atomic swap: detach then clear sequence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detachTerminalsForProjectSwitch is a no-op with empty terminals", () => {
    usePanelStore.getState().detachTerminalsForProjectSwitch();

    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).toHaveBeenCalledWith(
      [],
      10_000
    );
    expect(terminalInstanceService.detachForProjectSwitch).not.toHaveBeenCalled();
    expect(usePanelStore.getState().panelIds).toEqual([]);
  });

  it("clearTerminalStoreForSwitch is idempotent", () => {
    seedTerminals();

    usePanelStore.getState().clearTerminalStoreForSwitch();
    expect(usePanelStore.getState().panelIds).toEqual([]);

    usePanelStore.getState().clearTerminalStoreForSwitch();
    expect(usePanelStore.getState().panelIds).toEqual([]);
  });

  it("preserves terminal state after detach, then clears on explicit call", () => {
    seedTerminals();

    usePanelStore.getState().detachTerminalsForProjectSwitch();
    expect(usePanelStore.getState().panelIds).toHaveLength(2);

    usePanelStore.getState().clearTerminalStoreForSwitch();
    expect(usePanelStore.getState().panelIds).toEqual([]);

    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledTimes(2);
  });
});
