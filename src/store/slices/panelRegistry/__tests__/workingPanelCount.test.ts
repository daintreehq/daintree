import { describe, it, expect, beforeEach, vi } from "vitest";

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
    setActivityTier: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

type StoreTerminal = Parameters<typeof usePanelStore.setState>[0] extends infer S
  ? S extends { panelsById: Record<string, infer T> }
    ? T
    : never
  : never;

function terminal(id: string, overrides: Partial<StoreTerminal> = {}): StoreTerminal {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid",
    isVisible: true,
    ...overrides,
  } as StoreTerminal;
}

describe("workingPanelCount maintenance (#8596)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
  });

  it("starts at 0 when the store has no panels", () => {
    expect(usePanelStore.getState().workingPanelCount).toBe(0);
  });

  it("increments when updateAgentState transitions a panel to working", () => {
    usePanelStore.setState({
      panelsById: { "t-1": terminal("t-1", { agentState: "idle" }) },
      panelIds: ["t-1"],
    });

    usePanelStore.getState().updateAgentState("t-1", "working");

    expect(usePanelStore.getState().workingPanelCount).toBe(1);
  });

  it("decrements when a working panel transitions away from working", () => {
    usePanelStore.setState({
      panelsById: { "t-1": terminal("t-1", { agentState: "working" }) },
      panelIds: ["t-1"],
      workingPanelCount: 1,
    });

    usePanelStore.getState().updateAgentState("t-1", "waiting");

    expect(usePanelStore.getState().workingPanelCount).toBe(0);
  });

  it("does not change when transitioning between two non-working states", () => {
    usePanelStore.setState({
      panelsById: { "t-1": terminal("t-1", { agentState: "idle" }) },
      panelIds: ["t-1"],
      workingPanelCount: 0,
    });

    usePanelStore.getState().updateAgentState("t-1", "waiting");

    expect(usePanelStore.getState().workingPanelCount).toBe(0);
  });

  it("counts multiple working panels independently", () => {
    usePanelStore.setState({
      panelsById: {
        "t-1": terminal("t-1", { agentState: "idle" }),
        "t-2": terminal("t-2", { agentState: "idle" }),
        "t-3": terminal("t-3", { agentState: "idle" }),
      },
      panelIds: ["t-1", "t-2", "t-3"],
    });

    usePanelStore.getState().updateAgentState("t-1", "working");
    usePanelStore.getState().updateAgentState("t-2", "working");

    expect(usePanelStore.getState().workingPanelCount).toBe(2);

    usePanelStore.getState().updateAgentState("t-3", "working");
    expect(usePanelStore.getState().workingPanelCount).toBe(3);

    usePanelStore.getState().updateAgentState("t-1", "waiting");
    expect(usePanelStore.getState().workingPanelCount).toBe(2);
  });

  it("decrements when a working panel is removed", () => {
    usePanelStore.setState({
      panelsById: {
        "t-1": terminal("t-1", { agentState: "working", hasPty: false }),
        "t-2": terminal("t-2", { agentState: "working", hasPty: false }),
      },
      panelIds: ["t-1", "t-2"],
      workingPanelCount: 2,
    });

    usePanelStore.getState().removePanel("t-1");

    expect(usePanelStore.getState().workingPanelCount).toBe(1);
  });

  it("does not change when a non-working panel is removed", () => {
    usePanelStore.setState({
      panelsById: {
        "t-1": terminal("t-1", { agentState: "working", hasPty: false }),
        "t-2": terminal("t-2", { agentState: "idle", hasPty: false }),
      },
      panelIds: ["t-1", "t-2"],
      workingPanelCount: 1,
    });

    usePanelStore.getState().removePanel("t-2");

    expect(usePanelStore.getState().workingPanelCount).toBe(1);
  });

  it("resets workingPanelCount to 0 on reset()", async () => {
    usePanelStore.setState({
      panelsById: { "t-1": terminal("t-1", { agentState: "working", hasPty: false }) },
      panelIds: ["t-1"],
      workingPanelCount: 1,
    });

    await usePanelStore.getState().reset();

    expect(usePanelStore.getState().workingPanelCount).toBe(0);
  });
});
