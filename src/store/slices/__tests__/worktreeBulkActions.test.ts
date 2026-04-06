import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TerminalInstance } from "../../panelStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue("test-id"),
    write: vi.fn(),
    resize: vi.fn(),
    trash: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    resize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  },
}));

vi.mock("../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../panelStore");

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
  } as unknown as TerminalInstance;
}

describe("Worktree-scoped bulk actions", () => {
  beforeEach(() => {
    usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    vi.clearAllMocks();
  });

  it("bulkMoveToDockByWorktree only docks grid terminals in that worktree", () => {
    setTerminals([
      createMockTerminal("wt1-grid-1", "wt1", "grid"),
      createMockTerminal("wt1-dock-1", "wt1", "dock"),
      createMockTerminal("wt2-grid-1", "wt2", "grid"),
    ]);

    usePanelStore.getState().bulkMoveToDockByWorktree("wt1");

    const state = usePanelStore.getState();
    expect(state.panelsById["wt1-grid-1"]?.location).toBe("dock");
    expect(state.panelsById["wt1-dock-1"]?.location).toBe("dock");
    expect(state.panelsById["wt2-grid-1"]?.location).toBe("grid");
  });

  it("bulkMoveToGridByWorktree respects grid capacity and only moves that worktree's docked terminals", () => {
    const otherGrid = Array.from({ length: 15 }, (_, i) =>
      createMockTerminal(`wt2-grid-${i}`, "wt2", "grid")
    );
    const docked = [
      createMockTerminal("wt1-dock-0", "wt1", "dock"),
      createMockTerminal("wt1-dock-1", "wt1", "dock"),
    ];

    setTerminals([...otherGrid, ...docked]);

    usePanelStore.getState().bulkMoveToGridByWorktree("wt1");

    const state = usePanelStore.getState();
    const moved0 = state.panelsById["wt1-dock-0"];
    const moved1 = state.panelsById["wt1-dock-1"];
    const allTerminals = state.panelIds.map((id) => state.panelsById[id]);
    const gridCount = allTerminals.filter((t) => t.location === "grid").length;
    const dockCountWt1 = allTerminals.filter(
      (t) => t.worktreeId === "wt1" && t.location === "dock"
    ).length;

    expect(moved0?.location).toBe("grid");
    expect(moved1?.location).toBe("grid");
    expect(dockCountWt1).toBe(0);
    expect(gridCount).toBe(17);
  });

  it("bulkMoveToGridByWorktree preserves existing grid focus", () => {
    setTerminals([
      createMockTerminal("wt2-grid-0", "wt2", "grid"),
      createMockTerminal("wt1-dock-0", "wt1", "dock"),
    ]);
    usePanelStore.setState({ focusedId: "wt2-grid-0" });

    usePanelStore.getState().bulkMoveToGridByWorktree("wt1");

    const { focusedId } = usePanelStore.getState();
    expect(focusedId).toBe("wt2-grid-0");
  });

  it("bulkTrashByWorktree only trashes active terminals in that worktree", () => {
    setTerminals([
      createMockTerminal("wt1-grid-0", "wt1", "grid"),
      createMockTerminal("wt1-trash-0", "wt1", "trash"),
      createMockTerminal("wt2-grid-0", "wt2", "grid"),
    ]);

    usePanelStore.getState().bulkTrashByWorktree("wt1");

    const state = usePanelStore.getState();
    expect(state.panelsById["wt1-grid-0"]?.location).toBe("trash");
    expect(state.panelsById["wt1-trash-0"]?.location).toBe("trash");
    expect(state.panelsById["wt2-grid-0"]?.location).toBe("grid");
  });
});
