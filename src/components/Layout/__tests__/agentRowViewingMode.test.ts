import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TabGroup } from "@/types";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(() => "mock-notification-id"),
}));

const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { applyAgentRowViewingMode, readAgentRowViewingMode } =
  await import("../agentRowViewingMode");

function makeTerminal(id: string, worktreeId: string, location: "grid" | "dock" = "grid") {
  return {
    id,
    kind: "terminal" as const,
    worktreeId,
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location,
  };
}

const snapshot = { gridCols: 2, gridItemCount: 3, worktreeId: "wt-1" };

/** What the pill row does, in its order, around the two helpers. */
function pickRow(panelId: string, worktreeId: string) {
  const mode = readAgentRowViewingMode();
  const worktrees = useWorktreeSelectionStore.getState();
  if (worktreeId !== worktrees.activeWorktreeId) {
    worktrees.trackTerminalFocus(worktreeId, panelId);
    worktrees.selectWorktree(worktreeId);
  }
  applyAgentRowViewingMode(mode, panelId);
  usePanelStore.getState().activateTerminal(panelId);
}

function maximized() {
  const { maximizedId, maximizeTarget } = usePanelStore.getState();
  return { maximizedId, maximizeTarget };
}

describe("agent row viewing mode (#15335)", () => {
  beforeEach(() => {
    usePanelStore.getState().reset();
    useWorktreeSelectionStore.getState().reset();
    usePanelStore.setState({
      panelsById: {
        "a-1": makeTerminal("a-1", "wt-1"),
        "a-2": makeTerminal("a-2", "wt-1"),
        "a-3": makeTerminal("a-3", "wt-1"),
        "a-dock": makeTerminal("a-dock", "wt-1", "dock"),
        "b-1": makeTerminal("b-1", "wt-2"),
        "b-2": makeTerminal("b-2", "wt-2"),
      },
      panelIds: ["a-1", "a-2", "a-3", "a-dock", "b-1", "b-2"],
      tabGroups: new Map(),
      focusedId: "a-1",
      maximizedId: null,
      maximizeTarget: null,
      preMaximizeLayout: null,
      activeDockTerminalId: null,
    });
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-1",
      maximizeByWorktree: new Map(),
      isFleetScopeActive: false,
    });
  });

  function maximizeA1() {
    usePanelStore.setState({
      maximizedId: "a-1",
      maximizeTarget: { type: "panel", id: "a-1" },
      preMaximizeLayout: snapshot,
    });
  }

  it("shows the picked pane fullscreen when a pane was fullscreen", () => {
    maximizeA1();

    pickRow("a-2", "wt-1");

    expect(maximized()).toEqual({
      maximizedId: "a-2",
      maximizeTarget: { type: "panel", id: "a-2" },
    });
    expect(usePanelStore.getState().focusedId).toBe("a-2");
  });

  it("leaves the normal layout alone when nothing was fullscreen", () => {
    pickRow("a-2", "wt-1");

    expect(maximized()).toEqual({ maximizedId: null, maximizeTarget: null });
    expect(usePanelStore.getState().focusedId).toBe("a-2");
  });

  it("returns to the layout the user maximized from, with the picked pane active", () => {
    maximizeA1();
    pickRow("a-2", "wt-1");

    usePanelStore.getState().exitMaximize();

    expect(maximized()).toEqual({ maximizedId: null, maximizeTarget: null });
    expect(usePanelStore.getState().preMaximizeLayout).toBe(snapshot);
    expect(usePanelStore.getState().focusedId).toBe("a-2");
  });

  it("keeps the already maximized pane maximized", () => {
    maximizeA1();

    pickRow("a-1", "wt-1");

    expect(maximized()).toEqual({
      maximizedId: "a-1",
      maximizeTarget: { type: "panel", id: "a-1" },
    });
  });

  it("maximizes the picked tab's whole group", () => {
    maximizeA1();
    usePanelStore.setState({
      tabGroups: new Map<string, TabGroup>([
        [
          "g1",
          {
            id: "g1",
            location: "grid",
            worktreeId: "wt-1",
            activeTabId: "a-3",
            panelIds: ["a-2", "a-3"],
          },
        ],
      ]),
    });

    pickRow("a-3", "wt-1");

    expect(maximized()).toEqual({
      maximizedId: "a-3",
      maximizeTarget: { type: "group", id: "g1" },
    });
  });

  it("leaves fullscreen behind a picked dock pane untouched", () => {
    maximizeA1();

    pickRow("a-dock", "wt-1");

    expect(maximized()).toEqual({
      maximizedId: "a-1",
      maximizeTarget: { type: "panel", id: "a-1" },
    });
    expect(usePanelStore.getState().activeDockTerminalId).toBe("a-dock");
  });

  it("carries fullscreen into another worktree and keeps the one it left parked", () => {
    maximizeA1();

    pickRow("b-1", "wt-2");

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
    expect(maximized()).toEqual({
      maximizedId: "b-1",
      maximizeTarget: { type: "panel", id: "b-1" },
    });
    // wt-1's snapshot describes wt-1's grid, not this one.
    expect(usePanelStore.getState().preMaximizeLayout).toBeNull();
    expect(useWorktreeSelectionStore.getState().maximizeByWorktree.get("wt-1")?.maximizedId).toBe(
      "a-1"
    );
  });

  it("moves another worktree's parked fullscreen to the picked pane", () => {
    maximizeA1();
    const wt2Layout = { gridCols: 1, gridItemCount: 2, worktreeId: "wt-2" };
    useWorktreeSelectionStore.setState({
      maximizeByWorktree: new Map([
        [
          "wt-2",
          {
            maximizedId: "b-2",
            maximizeTarget: { type: "panel" as const, id: "b-2" },
            preMaximizeLayout: wt2Layout,
          },
        ],
      ]),
    });

    pickRow("b-1", "wt-2");

    expect(maximized()).toEqual({
      maximizedId: "b-1",
      maximizeTarget: { type: "panel", id: "b-1" },
    });
    expect(usePanelStore.getState().preMaximizeLayout).toEqual(wt2Layout);
  });

  it("keeps a grid reader in the grid when the destination worktree had fullscreen parked", () => {
    useWorktreeSelectionStore.setState({
      maximizeByWorktree: new Map([
        [
          "wt-2",
          {
            maximizedId: "b-1",
            maximizeTarget: { type: "panel" as const, id: "b-1" },
            preMaximizeLayout: null,
          },
        ],
      ]),
    });

    pickRow("b-1", "wt-2");

    expect(maximized()).toEqual({ maximizedId: null, maximizeTarget: null });
    expect(usePanelStore.getState().focusedId).toBe("b-1");
  });

  it("carries nothing inside fleet scope", () => {
    maximizeA1();
    useWorktreeSelectionStore.setState({ isFleetScopeActive: true });

    expect(readAgentRowViewingMode()).toBeNull();
    applyAgentRowViewingMode(null, "a-2");

    expect(maximized()).toEqual({
      maximizedId: "a-1",
      maximizeTarget: { type: "panel", id: "a-1" },
    });
  });

  it("treats a half-restored maximize as the grid", () => {
    usePanelStore.setState({ maximizedId: "a-1", maximizeTarget: null });

    expect(readAgentRowViewingMode()).toBe("grid");
  });
});
