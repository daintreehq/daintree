import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import { MAX_GRID_TERMINALS, type TerminalInstance } from "../panelRegistrySlice";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
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

const { usePanelStore } = await import("../../panelStore");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { panelPersistence } = await import("../../persistence/panelPersistence");

function setTerminals(terminals: TerminalInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function createMockTerminal(
  id: string,
  worktreeId: string,
  location: "grid" | "dock" | "trash" = "grid"
): TerminalInstance {
  return {
    id,
    type: "terminal",
    title: `Terminal ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    worktreeId,
    location,
    isVisible: location === "grid",
  };
}

describe("moveTerminalToWorktree", () => {
  beforeEach(() => {
    usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a", focusedWorktreeId: "wt-a" });
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("moves terminal to target worktree grid when under capacity", () => {
    const source = createMockTerminal("t1", "wt-a", "dock");
    const targetGridTerminals = Array.from({ length: 3 }, (_, i) =>
      createMockTerminal(`target-${i}`, "wt-b", "grid")
    );

    setTerminals([source, ...targetGridTerminals]);

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const moved = usePanelStore.getState().panelsById["t1"];
    expect(moved?.worktreeId).toBe("wt-b");
    expect(moved?.location).toBe("grid");
    expect(moved?.isVisible).toBe(true);
    expect(panelPersistence.save).toHaveBeenCalledTimes(1);
    // All terminals stay VISIBLE - we don't background for reliability
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.VISIBLE
    );
  });

  it("forces terminal to dock when target worktree grid is full", () => {
    const source = createMockTerminal("t1", "wt-a", "grid");
    const targetGridTerminals = Array.from({ length: MAX_GRID_TERMINALS }, (_, i) =>
      createMockTerminal(`target-${i}`, "wt-b", "grid")
    );

    setTerminals([source, ...targetGridTerminals]);

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const moved = usePanelStore.getState().panelsById["t1"];
    expect(moved?.worktreeId).toBe("wt-b");
    expect(moved?.location).toBe("dock");
    expect(moved?.isVisible).toBe(false);
    expect(panelPersistence.save).toHaveBeenCalledTimes(1);
    // Dock terminals get VISIBLE tier (optimizeForDock)
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.VISIBLE
    );
  });

  it("does nothing when moving to the same worktree", () => {
    const source = createMockTerminal("t1", "wt-a", "grid");
    setTerminals([source]);

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-a");

    const moved = usePanelStore.getState().panelsById["t1"];
    expect(moved?.worktreeId).toBe("wt-a");
    expect(panelPersistence.save).not.toHaveBeenCalled();
    expect(terminalInstanceService.applyRendererPolicy).not.toHaveBeenCalled();
  });

  it("applies VISIBLE tier when moving to any worktree", () => {
    const source = createMockTerminal("t1", "wt-a", "dock");
    setTerminals([source]);

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    // All terminals stay VISIBLE - we don't background for reliability
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.VISIBLE
    );
  });

  it("moves entire group when terminal belongs to a group", () => {
    const t1 = createMockTerminal("t1", "wt-a", "grid");
    const t2 = createMockTerminal("t2", "wt-a", "grid");
    const t3 = createMockTerminal("t3", "wt-a", "grid");

    const group = {
      id: "g1",
      location: "grid" as const,
      worktreeId: "wt-a",
      activeTabId: "t1",
      panelIds: ["t1", "t2", "t3"],
    };

    setTerminals([t1, t2, t3]);
    usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const state = usePanelStore.getState();

    const movedT1 = state.panelsById["t1"];
    const movedT2 = state.panelsById["t2"];
    const movedT3 = state.panelsById["t3"];

    expect(movedT1?.worktreeId).toBe("wt-b");
    expect(movedT2?.worktreeId).toBe("wt-b");
    expect(movedT3?.worktreeId).toBe("wt-b");

    const movedGroup = state.tabGroups.get("g1");
    expect(movedGroup?.worktreeId).toBe("wt-b");

    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledTimes(3);
  });
});
