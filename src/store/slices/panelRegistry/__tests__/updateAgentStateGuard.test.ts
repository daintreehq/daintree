import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

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
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

const baseTerminal = {
  id: "test-terminal-1",
  type: "terminal" as const,
  kind: "terminal" as const,
  title: "Test Agent",
  cwd: "/test",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  agentState: "directing" as const,
};

describe("updateAgentState store action (#3217)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();
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
  });

  it("allows waiting to overwrite directing (clearDirectingState teardown path)", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "waiting");

    expect(
      (usePanelStore.getState().panelsById["test-terminal-1"] as PtyPanelData | undefined)
        ?.agentState
    ).toBe("waiting");
  });

  it("allows working to overwrite directing", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "working");

    expect(
      (usePanelStore.getState().panelsById["test-terminal-1"] as PtyPanelData | undefined)
        ?.agentState
    ).toBe("working");
  });

  it("allows idle to overwrite directing", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "idle");

    expect(
      (usePanelStore.getState().panelsById["test-terminal-1"] as PtyPanelData | undefined)
        ?.agentState
    ).toBe("idle");
  });

  it("allows waiting when current state is not directing", () => {
    const workingTerminal = { ...baseTerminal, agentState: "working" as const };
    usePanelStore.setState({
      panelsById: { [workingTerminal.id]: workingTerminal },
      panelIds: [workingTerminal.id],
    });

    usePanelStore.getState().updateAgentState("test-terminal-1", "waiting");

    expect(
      (usePanelStore.getState().panelsById["test-terminal-1"] as PtyPanelData | undefined)
        ?.agentState
    ).toBe("waiting");
  });

  it("returns unchanged state for nonexistent terminal", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().updateAgentState("nonexistent", "working");

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  // #8592: same-state re-delivery must not bump `lastStateChange` and must
  // preserve `panelsById` reference (so subscribers don't fire).
  it("preserves panelsById ref and lastStateChange when re-delivered with same state", () => {
    const seededTerminal = {
      ...baseTerminal,
      agentState: "working" as const,
      lastStateChange: 12345,
    };
    usePanelStore.setState({
      panelsById: { [seededTerminal.id]: seededTerminal },
      panelIds: [seededTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;
    const terminalBefore = before[seededTerminal.id];

    usePanelStore.getState().updateAgentState(seededTerminal.id, "working");

    const after = usePanelStore.getState().panelsById;
    expect(after).toBe(before);
    expect(after[seededTerminal.id]).toBe(terminalBefore);
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.lastStateChange).toBe(12345);
  });

  it("preserves panelsById ref when re-delivered waiting with the same waitingReason", () => {
    const seededTerminal = {
      ...baseTerminal,
      agentState: "waiting" as const,
      waitingReason: "prompt" as const,
      lastStateChange: 9999,
    };
    usePanelStore.setState({
      panelsById: { [seededTerminal.id]: seededTerminal },
      panelIds: [seededTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateAgentState(
        seededTerminal.id,
        "waiting",
        undefined,
        undefined,
        undefined,
        undefined,
        "prompt"
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).toBe(before);
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.lastStateChange).toBe(9999);
  });

  it("writes when waiting is re-delivered with a different waitingReason", () => {
    const seededTerminal = {
      ...baseTerminal,
      agentState: "waiting" as const,
      waitingReason: "prompt" as const,
      lastStateChange: 100,
    };
    usePanelStore.setState({
      panelsById: { [seededTerminal.id]: seededTerminal },
      panelIds: [seededTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateAgentState(
        seededTerminal.id,
        "waiting",
        undefined,
        undefined,
        undefined,
        undefined,
        "question"
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.waitingReason).toBe("question");
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.lastStateChange).not.toBe(100);
  });

  // #8592: TerminalAgentStateController.onEnterPressed() writes the optimistic
  // `agentState:"working"` with no trigger, and the backend confirmation arrives
  // with `trigger:"input"`. The guard must let that trigger transition through,
  // otherwise HybridInputBar never sees `agentHasLifecycleEvent === true`.
  it("writes through a backend trigger confirmation after an optimistic same-state write", () => {
    const seededTerminal = {
      ...baseTerminal,
      agentState: "working" as const,
      stateChangeTrigger: undefined,
      lastStateChange: 200,
    };
    usePanelStore.setState({
      panelsById: { [seededTerminal.id]: seededTerminal },
      panelIds: [seededTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateAgentState(seededTerminal.id, "working", undefined, 1500, "input", 0.9);

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.stateChangeTrigger).toBe(
      "input"
    );
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.lastStateChange).toBe(1500);
  });

  it("preserves panelsById ref when re-delivered same state + same trigger", () => {
    const seededTerminal = {
      ...baseTerminal,
      agentState: "working" as const,
      stateChangeTrigger: "input" as const,
      lastStateChange: 300,
    };
    usePanelStore.setState({
      panelsById: { [seededTerminal.id]: seededTerminal },
      panelIds: [seededTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateAgentState(seededTerminal.id, "working", undefined, undefined, "input", 0.9);

    const after = usePanelStore.getState().panelsById;
    expect(after).toBe(before);
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.lastStateChange).toBe(300);
  });

  it("writes when the error message differs even though agentState is unchanged", () => {
    const seededTerminal = {
      ...baseTerminal,
      agentState: "exited" as const,
      error: "ECONNRESET",
      lastStateChange: 500,
    };
    usePanelStore.setState({
      panelsById: { [seededTerminal.id]: seededTerminal },
      panelIds: [seededTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().updateAgentState(seededTerminal.id, "exited", "EPIPE");

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect((after[seededTerminal.id] as PtyPanelData | undefined)?.error).toBe("EPIPE");
  });
});

describe("setupTerminalStoreListeners directing guard (#3217)", () => {
  function shouldSuppressBackendState(
    currentState: string | undefined,
    incomingState: string
  ): boolean {
    return currentState === "directing" && incomingState === "waiting";
  }

  it("backend waiting is suppressed when store terminal is in directing state", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const terminal = usePanelStore.getState().panelsById["test-terminal-1"] as
      PtyPanelData | undefined;
    expect(shouldSuppressBackendState(terminal?.agentState, "waiting")).toBe(true);
  });

  it("backend working is not suppressed when store terminal is in directing state", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const terminal = usePanelStore.getState().panelsById["test-terminal-1"] as
      PtyPanelData | undefined;
    expect(shouldSuppressBackendState(terminal?.agentState, "working")).toBe(false);
  });
});
