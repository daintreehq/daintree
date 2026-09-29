// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useUIStore } from "@/store/uiStore";
import { setWorktreeIdSetAccessor } from "@/store/storeAccessors";
import {
  goToNotificationSource,
  navigateToNotificationSource,
  resolveLiveNotificationDestination,
} from "../notificationNavigation";

type PanelSeed = { location: string; worktreeId?: string };

function seedPanels(panels: Record<string, PanelSeed>, focusedId: string | null = null) {
  const panelsById = Object.fromEntries(
    Object.entries(panels).map(([id, p]) => [id, { id, kind: "terminal", ...p }])
  );
  usePanelStore.setState({ panelsById, focusedId } as never);
}

const trackTerminalFocus = vi.fn();
const selectWorktree = vi.fn();

beforeEach(() => {
  dispatchMock.mockReset().mockResolvedValue({ ok: true });
  trackTerminalFocus.mockReset();
  selectWorktree.mockReset();
  seedPanels({});
  useProjectStore.setState({ currentProject: { id: "p1" } } as never);
  useWorktreeSelectionStore.setState({
    activeWorktreeId: "wt-1",
    deletedWorktrees: new Map(),
    trackTerminalFocus,
    selectWorktree,
  } as never);
  setWorktreeIdSetAccessor(() => new Set(["wt-1", "wt-2"]));
  useUIStore.setState({ notificationCenterOpen: true });
});

afterEach(() => {
  setWorktreeIdSetAccessor(() => null);
});

describe("resolveLiveNotificationDestination", () => {
  it("reads the panel's trash state at the moment of asking", () => {
    seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
    const context = { projectId: "p1", worktreeId: "wt-1", panelId: "pane-1" };
    expect(resolveLiveNotificationDestination(context).kind).toBe("panel");
    seedPanels({ "pane-1": { location: "trash", worktreeId: "wt-1" } });
    expect(resolveLiveNotificationDestination(context)).toEqual({
      kind: "worktree",
      worktreeId: "wt-1",
    });
  });

  it("does not count a deleted worktree as live, even while the view still lists it", () => {
    useWorktreeSelectionStore.setState({
      deletedWorktrees: new Map([["wt-2", {}]]),
    } as never);
    expect(resolveLiveNotificationDestination({ worktreeId: "wt-2" })).toEqual({
      kind: "none",
      reason: "gone",
    });
  });

  it("has no live worktree when no project view is mounted", () => {
    setWorktreeIdSetAccessor(() => null);
    expect(resolveLiveNotificationDestination({ worktreeId: "wt-1" }).kind).toBe("none");
  });
});

describe("navigateToNotificationSource", () => {
  it("focuses a panel in the active worktree without switching", async () => {
    seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
    await expect(navigateToNotificationSource({ panelId: "pane-1" })).resolves.toBe(true);
    expect(dispatchMock.mock.calls).toEqual([["panel.focus", { panelId: "pane-1" }]]);
    expect(trackTerminalFocus).not.toHaveBeenCalled();
  });

  it("selects the panel's worktree first, remembering the panel for the switch", async () => {
    seedPanels({ "pane-2": { location: "grid", worktreeId: "wt-2" } });
    await expect(
      navigateToNotificationSource({ worktreeId: "wt-1", panelId: "pane-2" })
    ).resolves.toBe(true);
    expect(trackTerminalFocus).toHaveBeenCalledWith("wt-2", "pane-2");
    expect(dispatchMock.mock.calls).toEqual([
      ["worktree.select", { worktreeId: "wt-2" }],
      ["panel.focus", { panelId: "pane-2" }],
    ]);
  });

  it("selects a deleted worktree's surviving panel for the session only", async () => {
    seedPanels({ "pane-3": { location: "grid", worktreeId: "wt-gone" } });
    useWorktreeSelectionStore.setState({
      deletedWorktrees: new Map([["wt-gone", {}]]),
    } as never);
    await expect(navigateToNotificationSource({ panelId: "pane-3" })).resolves.toBe(true);
    expect(selectWorktree).toHaveBeenCalledWith("wt-gone", { source: "focus" });
    expect(dispatchMock.mock.calls).toEqual([["panel.focus", { panelId: "pane-3" }]]);
  });

  it("focuses a panel in place when its worktree is one this view doesn't know", async () => {
    seedPanels({ "pane-4": { location: "grid", worktreeId: "wt-unknown" } });
    await expect(navigateToNotificationSource({ panelId: "pane-4" })).resolves.toBe(true);
    expect(trackTerminalFocus).not.toHaveBeenCalled();
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(dispatchMock.mock.calls).toEqual([["panel.focus", { panelId: "pane-4" }]]);
  });

  it("treats a scratch view's own records as this view's", async () => {
    const win = window as unknown as { __DAINTREE_INITIAL_PROJECT__?: { id: string } };
    win.__DAINTREE_INITIAL_PROJECT__ = { id: "scratch-1" };
    try {
      useProjectStore.setState({ currentProject: null });
      seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
      await expect(
        navigateToNotificationSource({ projectId: "scratch-1", panelId: "pane-1" })
      ).resolves.toBe(true);
      expect(
        resolveLiveNotificationDestination({ projectId: "p-other", panelId: "pane-1" })
      ).toEqual({ kind: "none", reason: "other-project" });
    } finally {
      delete win.__DAINTREE_INITIAL_PROJECT__;
    }
  });

  it("stops when the worktree switch is refused", async () => {
    seedPanels({ "pane-2": { location: "grid", worktreeId: "wt-2" } });
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "no" } });
    await expect(navigateToNotificationSource({ panelId: "pane-2" })).resolves.toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("goes to the worktree when the panel is trashed, then focuses what it restores", async () => {
    seedPanels({
      "pane-1": { location: "trash", worktreeId: "wt-2" },
      "pane-9": { location: "grid", worktreeId: "wt-2" },
    });
    dispatchMock.mockImplementation(async (id: string) => {
      if (id === "worktree.select") usePanelStore.setState({ focusedId: "pane-9" } as never);
      return { ok: true };
    });
    await expect(
      navigateToNotificationSource({ worktreeId: "wt-2", panelId: "pane-1" })
    ).resolves.toBe(true);
    expect(dispatchMock.mock.calls).toEqual([
      ["worktree.select", { worktreeId: "wt-2" }],
      ["panel.focus", { panelId: "pane-9" }],
    ]);
  });

  it("dispatches nothing when no destination is left", async () => {
    await expect(
      navigateToNotificationSource({ projectId: "p1", worktreeId: "wt-gone", panelId: "x" })
    ).resolves.toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("goToNotificationSource", () => {
  it("closes the inbox once navigation lands", async () => {
    seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
    await goToNotificationSource({ panelId: "pane-1" });
    expect(useUIStore.getState().notificationCenterOpen).toBe(false);
  });

  it("leaves the inbox open when panel.focus fails", async () => {
    seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "gone" } });
    await goToNotificationSource({ panelId: "pane-1" });
    expect(useUIStore.getState().notificationCenterOpen).toBe(true);
  });
});
