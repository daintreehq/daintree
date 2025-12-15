import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import { MAX_GRID_TERMINALS, type TerminalInstance } from "../terminalRegistrySlice";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    setActivityTier: vi.fn(),
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

vi.mock("../../persistence/terminalPersistence", () => ({
  terminalPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { useTerminalStore } = await import("../../terminalStore");
const { terminalClient } = await import("@/clients");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { terminalPersistence } = await import("../../persistence/terminalPersistence");

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
    useTerminalStore.getState().reset();
    useTerminalStore.setState({
      terminals: [],
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

    useTerminalStore.setState({ terminals: [source, ...targetGridTerminals] });

    useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const moved = useTerminalStore.getState().terminals.find((t) => t.id === "t1");
    expect(moved?.worktreeId).toBe("wt-b");
    expect(moved?.location).toBe("grid");
    expect(moved?.isVisible).toBe(true);
    expect(terminalPersistence.save).toHaveBeenCalledTimes(1);
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.VISIBLE
    );
    expect(terminalClient.setActivityTier).toHaveBeenCalledWith("t1", "background");
  });

  it("forces terminal to dock when target worktree grid is full", () => {
    const source = createMockTerminal("t1", "wt-a", "grid");
    const targetGridTerminals = Array.from({ length: MAX_GRID_TERMINALS }, (_, i) =>
      createMockTerminal(`target-${i}`, "wt-b", "grid")
    );

    useTerminalStore.setState({ terminals: [source, ...targetGridTerminals] });

    useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const moved = useTerminalStore.getState().terminals.find((t) => t.id === "t1");
    expect(moved?.worktreeId).toBe("wt-b");
    expect(moved?.location).toBe("dock");
    expect(moved?.isVisible).toBe(false);
    expect(terminalPersistence.save).toHaveBeenCalledTimes(1);
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.BACKGROUND
    );
    expect(terminalClient.setActivityTier).toHaveBeenCalledWith("t1", "background");
  });

  it("does nothing when moving to the same worktree", () => {
    const source = createMockTerminal("t1", "wt-a", "grid");
    useTerminalStore.setState({ terminals: [source] });

    useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-a");

    const moved = useTerminalStore.getState().terminals.find((t) => t.id === "t1");
    expect(moved?.worktreeId).toBe("wt-a");
    expect(terminalPersistence.save).not.toHaveBeenCalled();
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    expect(terminalInstanceService.applyRendererPolicy).not.toHaveBeenCalled();
  });

  it("backgrounds terminals moved off the active worktree", () => {
    const source = createMockTerminal("t1", "wt-a", "dock");
    useTerminalStore.setState({ terminals: [source] });

    useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

    expect(terminalClient.setActivityTier).toHaveBeenCalledWith("t1", "background");
  });
});
