import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, { id: string; location?: string; worktreeId?: string }>,
  getPanelGroup: vi.fn((_panelId: string): { id: string } | undefined => undefined),
  setActiveTab: vi.fn(),
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

import { openPluginAttentionPanel } from "../openPluginAttentionPanel";

beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ ok: true });
  panelState.panelsById = {};
  panelState.getPanelGroup.mockReset().mockReturnValue(undefined);
  panelState.setActiveTab.mockReset();
  panelState.pingTerminal.mockReset();
  selection.activeWorktreeId = "wt-1";
  selection.selectWorktree.mockReset();
  selection.trackTerminalFocus.mockReset();
});

describe("openPluginAttentionPanel (#13821)", () => {
  it("focuses a panel in the active worktree without switching", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "grid", worktreeId: "wt-1" } };

    await expect(openPluginAttentionPanel("p1")).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "p1" }, { source: "user" });
    expect(selection.selectWorktree).not.toHaveBeenCalled();
    expect(panelState.pingTerminal).toHaveBeenCalledWith("p1");
  });

  it("switches to the panel's worktree and selects its tab first", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "dock", worktreeId: "wt-2" } };
    panelState.getPanelGroup.mockReturnValue({ id: "group-1" });

    await openPluginAttentionPanel("p1");

    expect(selection.trackTerminalFocus).toHaveBeenCalledWith("wt-2", "p1");
    expect(selection.selectWorktree).toHaveBeenCalledWith("wt-2");
    expect(panelState.setActiveTab).toHaveBeenCalledWith("group-1", "p1");
    expect(selection.selectWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0]!
    );
  });

  it("refuses a closed panel, or one no row can take the user to", async () => {
    await expect(openPluginAttentionPanel("gone")).resolves.toBe(false);
    for (const location of ["dialog", "background", "trash"]) {
      panelState.panelsById = { p1: { id: "p1", location } };
      await expect(openPluginAttentionPanel("p1"), location).resolves.toBe(false);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports a focus the action refused, and pings nothing", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "grid" } };
    dispatch.mockResolvedValue({ ok: false, error: new Error("gone") });

    await expect(openPluginAttentionPanel("p1")).resolves.toBe(false);
    expect(panelState.pingTerminal).not.toHaveBeenCalled();
  });

  it("lets a rejected dispatch reach the caller's error handling", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "grid" } };
    dispatch.mockRejectedValue(new Error("boom"));

    await expect(openPluginAttentionPanel("p1")).rejects.toThrow("boom");
  });
});
