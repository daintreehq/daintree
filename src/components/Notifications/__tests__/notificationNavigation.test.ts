// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useUIStore } from "@/store/uiStore";
import { setWorktreeIdSetAccessor } from "@/store/storeAccessors";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
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
const switchProject = vi.fn();
const switchScratch = vi.fn();

const OTHER_PROJECT = "b".repeat(64);
const MISSING_PROJECT = "c".repeat(64);
const SCRATCH = "0b2d7c4e-1f3a-4b5c-8d9e-0a1b2c3d4e5f";

beforeEach(() => {
  dispatchMock.mockReset().mockResolvedValue({ ok: true });
  notifyMock.mockReset();
  trackTerminalFocus.mockReset();
  selectWorktree.mockReset();
  switchProject.mockReset().mockResolvedValue(undefined);
  switchScratch.mockReset().mockResolvedValue(undefined);
  seedPanels({});
  useProjectStore.setState({
    currentProject: { id: "p1" },
    projects: [
      { id: "p1", name: "Helios" },
      { id: OTHER_PROJECT, name: "Atlas", status: "closed" },
      { id: MISSING_PROJECT, name: "Gone", status: "missing" },
    ],
    switchProject,
  } as never);
  useScratchStore.setState({ scratches: [{ id: SCRATCH }], switchScratch } as never);
  useWorktreeSelectionStore.setState({
    activeWorktreeId: "wt-1",
    deletedWorktrees: new Map(),
    trackTerminalFocus,
    selectWorktree,
  } as never);
  setWorktreeIdSetAccessor(() => new Set(["wt-1", "wt-2"]));
  useUIStore.setState({ notificationCenterOpen: true });
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
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

  it("does not go to a panel in a worktree this view doesn't know", async () => {
    seedPanels({ "pane-4": { location: "grid", worktreeId: "wt-unknown" } });
    await expect(navigateToNotificationSource({ panelId: "pane-4" })).resolves.toBe(false);
    expect(trackTerminalFocus).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
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
    await goToNotificationSource({ panelId: "pane-1" }, "e1");
    expect(useUIStore.getState().notificationCenterOpen).toBe(false);
  });

  it("leaves the inbox open when panel.focus fails", async () => {
    seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "gone" } });
    await goToNotificationSource({ panelId: "pane-1" }, "e1");
    expect(useUIStore.getState().notificationCenterOpen).toBe(true);
  });

  describe("read state", () => {
    const entry = (id: string, extra: Partial<NotificationHistoryEntry> = {}) =>
      ({
        id,
        type: "info",
        message: id,
        timestamp: 1,
        seenAsToast: false,
        summarized: false,
        countable: true,
        ...extra,
      }) as NotificationHistoryEntry;
    const seed = (entries: NotificationHistoryEntry[]) =>
      useNotificationHistoryStore.setState({ entries, unreadCount: entries.length });
    const readIds = () =>
      useNotificationHistoryStore
        .getState()
        .entries.filter((e) => e.seenAsToast)
        .map((e) => e.id);

    it("marks the entry read on arrival and leaves it unarchived", async () => {
      seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
      seed([entry("e1"), entry("e2")]);
      await goToNotificationSource({ panelId: "pane-1" }, "e1");
      expect(readIds()).toEqual(["e1"]);
      expect(useNotificationHistoryStore.getState().entries.some((e) => e.archivedAt)).toBe(false);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("marks a thread's unarchived entries read but not its archived ones", async () => {
      seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
      seed([
        entry("e1", { correlationId: "c1" }),
        entry("e2", { correlationId: "c1" }),
        entry("e3", { correlationId: "c1", archivedAt: 5 }),
        entry("e4", { correlationId: "c2" }),
      ]);
      await goToNotificationSource({ panelId: "pane-1" }, "e1");
      expect(readIds().sort()).toEqual(["e1", "e2"]);
    });

    it("waits for arrival before marking read or closing", async () => {
      seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
      seed([entry("e1")]);
      let resolveFocus!: (value: { ok: boolean }) => void;
      dispatchMock.mockReturnValueOnce(new Promise((resolve) => (resolveFocus = resolve)));
      const pending = goToNotificationSource({ panelId: "pane-1" }, "e1");
      await Promise.resolve();
      expect(readIds()).toEqual([]);
      expect(useUIStore.getState().notificationCenterOpen).toBe(true);
      resolveFocus({ ok: true });
      await pending;
      expect(readIds()).toEqual(["e1"]);
      expect(useUIStore.getState().notificationCenterOpen).toBe(false);
    });

    it("leaves the entry unread when navigation fails", async () => {
      seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
      seed([entry("e1")]);
      dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "gone" } });
      await goToNotificationSource({ panelId: "pane-1" }, "e1");
      expect(readIds()).toEqual([]);
    });

    it("leaves the entry unread when the source is gone", async () => {
      seed([entry("e1")]);
      await goToNotificationSource({ panelId: "missing" }, "e1");
      expect(readIds()).toEqual([]);
    });

    it("tolerates an entry pruned during navigation", async () => {
      seedPanels({ "pane-1": { location: "grid", worktreeId: "wt-1" } });
      await expect(goToNotificationSource({ panelId: "pane-1" }, "gone")).resolves.toBe(true);
    });

    it("leaves a row from another workspace unread when it switches there", async () => {
      seed([entry("e1")]);
      await goToNotificationSource({ projectId: OTHER_PROJECT, panelId: "pane-1" }, "e1");
      expect(switchProject).toHaveBeenCalledOnce();
      expect(readIds()).toEqual([]);
    });
  });

  describe("another workspace", () => {
    it("closes the inbox and switches with the panel, its worktree riding as the fallback", async () => {
      let centerOpenAtSwitch: boolean | undefined;
      switchProject.mockImplementation(() => {
        centerOpenAtSwitch = useUIStore.getState().notificationCenterOpen;
        // The switch settles in another view; the handoff must not wait on it.
        return new Promise(() => {});
      });
      await expect(
        goToNotificationSource(
          { projectId: OTHER_PROJECT, worktreeId: "wt-9", panelId: "pane-9" },
          "e1"
        )
      ).resolves.toBe(true);
      expect(centerOpenAtSwitch).toBe(false);
      expect(switchProject).toHaveBeenCalledWith(OTHER_PROJECT, {
        focusIntent: { intent: "focus-panel", panelId: "pane-9", worktreeId: "wt-9" },
      });
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("lands on the worktree when the record named only that", async () => {
      await goToNotificationSource({ projectId: OTHER_PROJECT, worktreeId: "wt-9" }, "e1");
      expect(switchProject).toHaveBeenCalledWith(OTHER_PROJECT, {
        focusIntent: { intent: "focus-worktree", worktreeId: "wt-9" },
      });
    });

    it("sends a panel with no worktree without a fallback", async () => {
      await goToNotificationSource({ projectId: OTHER_PROJECT, panelId: "pane-9" }, "e1");
      expect(switchProject).toHaveBeenCalledWith(OTHER_PROJECT, {
        focusIntent: { intent: "focus-panel", panelId: "pane-9" },
      });
    });

    it("routes a scratch through the scratch switch", async () => {
      await goToNotificationSource({ projectId: SCRATCH, panelId: "pane-9" }, "e1");
      expect(switchScratch).toHaveBeenCalledWith(SCRATCH, {
        focusIntent: { intent: "focus-panel", panelId: "pane-9" },
      });
      expect(switchProject).not.toHaveBeenCalled();
    });

    it("says so, with a Try again that keeps the address, when the switch rejects", async () => {
      switchScratch.mockRejectedValueOnce(new Error("The scratch is busy"));
      await goToNotificationSource({ projectId: SCRATCH, panelId: "pane-9" }, "e1");
      await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledOnce());
      const toast = notifyMock.mock.calls[0]![0];
      expect(toast).toMatchObject({ type: "error", message: "The scratch is busy" });
      toast.actions[0].onClick();
      expect(switchScratch).toHaveBeenCalledTimes(2);
      expect(switchScratch).toHaveBeenLastCalledWith(SCRATCH, {
        focusIntent: { intent: "focus-panel", panelId: "pane-9" },
      });
    });

    it("re-reads whether the workspace can still be opened at activation", async () => {
      const context = { projectId: OTHER_PROJECT, panelId: "pane-9" };
      expect(resolveLiveNotificationDestination(context).kind).toBe("project");
      useProjectStore.setState({ projects: [{ id: "p1", name: "Helios" }] } as never);
      expect(resolveLiveNotificationDestination(context)).toEqual({
        kind: "none",
        reason: "other-project",
      });
      await expect(
        goToNotificationSource({ projectId: OTHER_PROJECT, panelId: "pane-9" }, "e1")
      ).resolves.toBe(false);
      expect(useUIStore.getState().notificationCenterOpen).toBe(true);
      expect(switchProject).not.toHaveBeenCalled();
    });

    it("goes nowhere for a project whose folder is missing, or a row from another machine", async () => {
      await expect(
        goToNotificationSource({ projectId: MISSING_PROJECT, panelId: "pane-9" }, "e1")
      ).resolves.toBe(false);
      await expect(
        goToNotificationSource(
          { projectId: OTHER_PROJECT, panelId: "pane-9", hostName: "studio-01" },
          "e1"
        )
      ).resolves.toBe(false);
      expect(switchProject).not.toHaveBeenCalled();
      expect(useUIStore.getState().notificationCenterOpen).toBe(true);
    });

    it("is not navigated within this view", async () => {
      await expect(
        navigateToNotificationSource({ projectId: OTHER_PROJECT, panelId: "pane-9" })
      ).resolves.toBe(false);
      expect(switchProject).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });
});
