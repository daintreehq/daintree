import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, { id: string; location?: string; worktreeId?: string }>,
  getPanelGroup: vi.fn((_panelId: string): { id: string } | undefined => undefined),
  setActiveTab: vi.fn(),
  setFileViewMode: vi.fn(),
  pingTerminal: vi.fn(),
}));
const selection = vi.hoisted(() => ({
  activeWorktreeId: "wt-1" as string | null,
  selectWorktree: vi.fn(),
  trackTerminalFocus: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => panelState } }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));

import { showFileDraft } from "../showFileDraft";

beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ ok: true });
  panelState.panelsById = {};
  panelState.getPanelGroup.mockReset().mockReturnValue(undefined);
  panelState.setActiveTab.mockReset();
  panelState.setFileViewMode.mockReset();
  panelState.pingTerminal.mockReset();
  selection.activeWorktreeId = "wt-1";
  selection.selectWorktree.mockReset();
  selection.trackTerminalFocus.mockReset();
});

describe("showFileDraft (#15017)", () => {
  it("brings an inactive tab forward in Edit and focuses it", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "grid", worktreeId: "wt-1" } };
    panelState.getPanelGroup.mockReturnValue({ id: "g1" });

    await showFileDraft("p1");

    expect(selection.selectWorktree).not.toHaveBeenCalled();
    expect(panelState.setFileViewMode).toHaveBeenCalledWith("p1", "edit");
    expect(panelState.setActiveTab).toHaveBeenCalledWith("g1", "p1");
    expect(panelState.setActiveTab.mock.invocationCallOrder[0]!).toBeLessThan(
      dispatch.mock.invocationCallOrder[0]!
    );
    expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "p1" }, { source: "user" });
    expect(panelState.pingTerminal).toHaveBeenCalledWith("p1");
  });

  it("switches to the panel's worktree first, restoring this panel there", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "dock", worktreeId: "wt-2" } };

    await showFileDraft("p1");

    expect(selection.trackTerminalFocus).toHaveBeenCalledWith("wt-2", "p1");
    expect(selection.selectWorktree).toHaveBeenCalledWith("wt-2");
    // Tracked before the switch, which restores whatever the worktree last tracked.
    const tracked = selection.trackTerminalFocus.mock.invocationCallOrder[0]!;
    const selected = selection.selectWorktree.mock.invocationCallOrder[0]!;
    const focused = dispatch.mock.invocationCallOrder[0]!;
    expect(tracked).toBeLessThan(selected);
    expect(selected).toBeLessThan(focused);
    expect(panelState.setFileViewMode.mock.invocationCallOrder[0]!).toBeLessThan(focused);
  });

  it("does nothing for a panel that is gone or out of reach", async () => {
    panelState.panelsById = { p2: { id: "p2", location: "trash", worktreeId: "wt-1" } };

    await showFileDraft("p1");
    await showFileDraft("p2");

    expect(panelState.setFileViewMode).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves the panel unpinged when focus was refused", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "grid", worktreeId: "wt-1" } };
    dispatch.mockResolvedValue({ ok: false });

    await showFileDraft("p1");

    expect(panelState.pingTerminal).not.toHaveBeenCalled();
  });
});
