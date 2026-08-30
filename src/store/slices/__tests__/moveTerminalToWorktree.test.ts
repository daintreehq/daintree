import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    updateWorktreeId: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
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
const { terminalClient } = await import("@/clients");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { panelPersistence } = await import("../../persistence/panelPersistence");

function setTerminals(terminals: PtyPanelData[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function createMockTerminal(
  id: string,
  worktreeId: string,
  location: "grid" | "dock" | "trash" = "grid"
): PtyPanelData {
  return {
    id,
    title: `Terminal ${id}`,
    kind: "terminal" as const,
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

  it("keeps the terminal in grid when target worktree already has many grid panels", () => {
    // Scrollable grid (#8805) — moving to another worktree's grid no longer
    // forces dock when the target exceeds the legacy on-screen cap. The grid
    // scrolls vertically; cross-worktree moves preserve the grid location.
    const source = createMockTerminal("t1", "wt-a", "grid");
    const targetGridTerminals = Array.from({ length: 16 }, (_, i) =>
      createMockTerminal(`target-${i}`, "wt-b", "grid")
    );

    setTerminals([source, ...targetGridTerminals]);

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const moved = usePanelStore.getState().panelsById["t1"];
    expect(moved?.worktreeId).toBe("wt-b");
    expect(moved?.location).toBe("grid");
    expect(moved?.isVisible).toBe(true);
    expect(panelPersistence.save).toHaveBeenCalledTimes(1);
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

  it("re-files the run on the pty-host record so the fleet palette regroups it", () => {
    // The palette groups by the pty-host's copy of `worktreeId`, and nothing
    // re-stamps it after spawn — so without this hop the sidebar and the
    // palette disagree about where the very same run is (#12060).
    const t1 = createMockTerminal("t1", "wt-a");
    setTerminals([t1]);
    // Explicit: a leftover group from a prior case would route this through
    // `moveTabGroupToWorktree`, whose own sync would satisfy the spy and hide a
    // regression in the single-panel path.
    usePanelStore.setState({ tabGroups: new Map() });
    expect(usePanelStore.getState().getPanelGroup("t1")).toBeUndefined();

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    expect(terminalClient.updateWorktreeId).toHaveBeenCalledWith("t1", "wt-b");
  });

  it("does not re-file a run whose destination is the worktree it is already in", () => {
    // The early return covers the whole move, the host hop included: a no-op
    // drag must not churn the record or the fleet recompute it triggers.
    const t1 = createMockTerminal("t1", "wt-a");
    setTerminals([t1]);
    usePanelStore.setState({ tabGroups: new Map() });

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-a");

    expect(terminalClient.updateWorktreeId).not.toHaveBeenCalled();
  });
});
