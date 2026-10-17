import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { DriveLeaseNavigation } from "@shared/types/ipc/driveLease";

type Target = { type: "panel" | "group"; id: string } | null;
interface FakePanel {
  id: string;
  location: string;
  worktreeId?: string;
  excludeFromPersistence?: boolean;
}

const h = vi.hoisted(() => ({
  mruSuppressed: false,
  mruRecorded: [] as string[],
  worktreeIds: new Set<string>(["wt-1", "wt-2"]),
  resolveMaximize: vi.fn(),
  calls: [] as string[],
}));

const worktreeStore = create<{
  activeWorktreeId: string | null;
  setActiveWorktree: (id: string | null, options?: { persist?: boolean }) => void;
}>((set) => ({
  activeWorktreeId: "wt-1",
  setActiveWorktree: (id, options) => {
    h.calls.push(`worktree:${id}:${String(options?.persist)}`);
    // The real switch restores the incoming worktree's own stashed maximize.
    panelStore.setState({ maximizedId: "stashed", maximizeTarget: { type: "panel", id: "x" } });
    set({ activeWorktreeId: id });
  },
}));

const panelStore = create<{
  panelsById: Record<string, FakePanel>;
  tabGroups: Map<string, unknown>;
  focusedId: string | null;
  maximizedId: string | null;
  maximizeTarget: Target;
  preMaximizeLayout: unknown;
  setFocused: (id: string | null, shouldPing?: boolean, options?: { followed?: boolean }) => void;
  exitMaximize: () => void;
}>((set, get) => ({
  panelsById: {},
  tabGroups: new Map(),
  focusedId: null,
  maximizedId: null,
  maximizeTarget: null,
  preMaximizeLayout: null,
  setFocused: (id, _shouldPing, options) => {
    h.calls.push(`focus:${id}${options?.followed ? ":followed" : ""}`);
    if (id && !h.mruSuppressed) h.mruRecorded.push(id);
    set({ focusedId: id });
  },
  exitMaximize: () => {
    if (!get().maximizedId && !get().maximizeTarget) return;
    h.calls.push("exit-maximize");
    set({ maximizedId: null, maximizeTarget: null });
  },
}));

const focusStore = create<{
  gestureSidebarHidden: boolean;
  gestureAssistantHidden: boolean;
  setSidebarGestureHidden: (hidden: boolean) => void;
}>((set) => ({
  gestureSidebarHidden: false,
  gestureAssistantHidden: false,
  setSidebarGestureHidden: (hidden) => {
    h.calls.push(`focus-mode:${hidden}`);
    set({ gestureSidebarHidden: hidden });
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: worktreeStore,
  resolveMaximizeForWorktree: h.resolveMaximize,
  suppressMruRecording: (value: boolean) => {
    h.mruSuppressed = value;
  },
  isMruRecordingSuppressed: () => h.mruSuppressed,
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStore }));
vi.mock("@/store/focusStore", () => ({ useFocusStore: focusStore }));
vi.mock("@/store/storeAccessors", () => ({ getWorktreeIdSet: () => h.worktreeIds }));

import { applyDriverNavigation, startDriverNavigationReporter } from "../hostDriverNavigation";

const nav = (overrides: Partial<DriveLeaseNavigation> = {}): DriveLeaseNavigation => ({
  activeWorktreeId: "wt-1",
  focusedPanelId: null,
  maximize: null,
  focusMode: false,
  ...overrides,
});

const panels: Record<string, FakePanel> = {
  t1: { id: "t1", location: "grid", worktreeId: "wt-1" },
  t2: { id: "t2", location: "dock", worktreeId: "wt-2" },
  global: { id: "global", location: "grid" },
  overlay: { id: "overlay", location: "grid", worktreeId: "wt-2", excludeFromPersistence: true },
};

beforeEach(() => {
  h.mruSuppressed = false;
  h.mruRecorded = [];
  h.calls = [];
  h.resolveMaximize.mockReset();
  worktreeStore.setState({ activeWorktreeId: "wt-1" });
  panelStore.setState({
    panelsById: panels,
    focusedId: null,
    maximizedId: null,
    maximizeTarget: null,
    preMaximizeLayout: null,
  });
  focusStore.setState({ gestureSidebarHidden: false, gestureAssistantHidden: false });
  panelStore.setState({ tabGroups: new Map() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("applyDriverNavigation", () => {
  it("moves to the driver's worktree first, then its maximize and focus, without persisting", async () => {
    h.resolveMaximize.mockImplementation((snapshot, worktreeId) => {
      h.calls.push(`resolve:${worktreeId}`);
      return snapshot;
    });

    await applyDriverNavigation(
      nav({
        activeWorktreeId: "wt-2",
        focusedPanelId: "t2",
        maximize: { panelId: "t2", target: { type: "group", id: "g1" } },
        focusMode: true,
      }),
      () => true
    );

    expect(h.calls).toEqual([
      "worktree:wt-2:false",
      "focus-mode:true",
      "resolve:wt-2",
      "focus:t2:followed",
    ]);
    // The driver's maximize wins over the one this screen had stashed for the worktree.
    expect(panelStore.getState()).toMatchObject({
      maximizedId: "t2",
      maximizeTarget: { type: "group", id: "g1" },
    });
    // The driver's pick stays out of this screen's quick switcher, and the
    // suppression this view had before is restored.
    expect(h.mruRecorded).toEqual([]);
    expect(h.mruSuppressed).toBe(false);
  });

  it("leaves this screen's own assistant suppression alone", async () => {
    focusStore.setState({ gestureAssistantHidden: true });
    await applyDriverNavigation(nav({ focusMode: true }), () => true);
    expect(focusStore.getState()).toMatchObject({
      gestureSidebarHidden: true,
      gestureAssistantHidden: true,
    });
  });

  it("shows the focused panel's tab before the driver's tab-group save arrives", async () => {
    const group = { id: "g1", panelIds: ["t1", "global"], activeTabId: "global", location: "grid" };
    panelStore.setState({ tabGroups: new Map([["g1", group]]) });

    await applyDriverNavigation(nav({ focusedPanelId: "t1" }), () => true);

    expect(panelStore.getState().tabGroups.get("g1")).toEqual({ ...group, activeTabId: "t1" });
    expect(panelStore.getState().focusedId).toBe("t1");
  });

  it("drops a maximize it already holds once its panel can no longer show it", async () => {
    panelStore.setState({ maximizedId: "t1", maximizeTarget: { type: "panel", id: "t1" } });
    h.resolveMaximize.mockReturnValue(null);

    await applyDriverNavigation(
      nav({ maximize: { panelId: "t1", target: { type: "panel", id: "t1" } } }),
      () => true
    );

    expect(panelStore.getState()).toMatchObject({ maximizedId: null, maximizeTarget: null });
  });

  it("follows a maximize in a project with no worktrees", async () => {
    worktreeStore.setState({ activeWorktreeId: null });
    await applyDriverNavigation(
      nav({
        activeWorktreeId: null,
        maximize: { panelId: "global", target: { type: "panel", id: "global" } },
      }),
      () => true
    );
    expect(panelStore.getState()).toMatchObject({
      maximizedId: "global",
      maximizeTarget: { type: "panel", id: "global" },
    });

    // A panel filed in a worktree isn't one this grid shows.
    await applyDriverNavigation(
      nav({
        activeWorktreeId: null,
        maximize: { panelId: "t1", target: { type: "panel", id: "t1" } },
      }),
      () => true
    );
    expect(panelStore.getState().maximizedId).toBeNull();
    expect(h.resolveMaximize).not.toHaveBeenCalled();
  });

  it("returns to the grid rather than keep a maximize it can't show", async () => {
    panelStore.setState({ maximizedId: "t1", maximizeTarget: { type: "panel", id: "t1" } });
    h.resolveMaximize.mockReturnValue(null);

    await applyDriverNavigation(
      nav({ maximize: { panelId: "missing", target: { type: "panel", id: "missing" } } }),
      () => true
    );
    expect(panelStore.getState()).toMatchObject({ maximizedId: null, maximizeTarget: null });

    panelStore.setState({ maximizedId: "t1", maximizeTarget: { type: "panel", id: "t1" } });
    await applyDriverNavigation(nav(), () => true);
    expect(panelStore.getState()).toMatchObject({ maximizedId: null, maximizeTarget: null });
  });

  it("skips what this view doesn't have yet, or can't show in the driver's worktree", async () => {
    await applyDriverNavigation(nav({ activeWorktreeId: "wt-unknown" }), () => true);
    expect(worktreeStore.getState().activeWorktreeId).toBe("wt-1");

    for (const focusedPanelId of ["missing", "t2", "overlay"]) {
      await applyDriverNavigation(nav({ focusedPanelId }), () => true);
    }
    expect(panelStore.getState().focusedId).toBeNull();

    // A panel filed in no worktree shows in all of them.
    await applyDriverNavigation(nav({ focusedPanelId: "global" }), () => true);
    expect(panelStore.getState().focusedId).toBe("global");
  });

  it("does nothing once the view has moved on", async () => {
    await applyDriverNavigation(
      nav({ activeWorktreeId: "wt-2", focusMode: true, focusedPanelId: "t2" }),
      () => false
    );
    expect(h.calls).toEqual([]);
  });
});

describe("startDriverNavigationReporter", () => {
  it("keeps a forced report asked for while its stores were still loading", async () => {
    vi.useFakeTimers();
    const sent: DriveLeaseNavigation[] = [];
    const reporter = startDriverNavigationReporter({
      mayReport: () => true,
      send: (navigation) => sent.push(navigation),
      delayMs: 0,
    });
    reporter.reportNow();
    vi.advanceTimersByTime(0);
    await vi.dynamicImportSettled();
    await Promise.resolve();
    vi.advanceTimersByTime(0);

    expect(sent).toEqual([nav()]);
    reporter.dispose();
  });

  async function loaded() {
    // Lets the reporter's store imports resolve and its subscriptions attach.
    await vi.dynamicImportSettled();
    await Promise.resolve();
  }

  it("reports each change once, at most once per delay, only while it may", async () => {
    vi.useFakeTimers();
    const sent: DriveLeaseNavigation[] = [];
    let may = true;
    const reporter = startDriverNavigationReporter({
      mayReport: () => may,
      send: (navigation) => sent.push(navigation),
      delayMs: 50,
    });
    await loaded();

    panelStore.getState().setFocused("t1");
    focusStore.getState().setSidebarGestureHidden(true);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([nav({ focusedPanelId: "t1", focusMode: true })]);

    // A change to something that isn't navigation sends nothing.
    panelStore.setState({ preMaximizeLayout: { columns: 2 } });
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);

    // Focus on a panel only this screen shows keeps the last one the project holds.
    panelStore.setState({ focusedId: "overlay" });
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);

    may = false;
    worktreeStore.setState({ activeWorktreeId: "wt-2" });
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);

    may = true;
    reporter.reportNow();
    vi.advanceTimersByTime(50);
    expect(sent.at(-1)).toEqual(
      nav({ activeWorktreeId: "wt-2", focusedPanelId: "t1", focusMode: true })
    );

    reporter.dispose();
    panelStore.getState().setFocused("t2");
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(2);
  });
});
