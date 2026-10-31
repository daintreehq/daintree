import { describe, expect, it } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import {
  listVisiblePaneIds,
  pickRecentVisibleTarget,
  type VisiblePaneState,
} from "../voiceFallbackTarget";

function pane(id: string, extra: Partial<PanelInstance> = {}): PanelInstance {
  return { id, title: id, kind: "terminal", location: "grid", ...extra } as PanelInstance;
}

function arrange(
  panels: PanelInstance[],
  overrides: Partial<VisiblePaneState> = {}
): VisiblePaneState {
  const grid = panels.filter(
    (p) => p.location === "grid" && (p.worktreeId ?? null) === (overrides.activeWorktreeId ?? null)
  );
  return {
    panelIds: panels.map((p) => p.id),
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    activeDockTerminalId: null,
    trashedTerminals: new Set<string>(),
    activeWorktreeId: null,
    maximizedId: null,
    maximizeTarget: null,
    gridGroups: grid.map((p) => ({ id: p.id, panelIds: [p.id], activeTabId: p.id })),
    helpTerminalIds: new Set<string>(),
    gridHidden: false,
    isClosing: () => false,
    ...overrides,
  };
}

describe("listVisiblePaneIds", () => {
  it("lists the active worktree's grid panes", () => {
    const state = arrange([
      pane("a", { worktreeId: "wt-1" }),
      pane("b", { worktreeId: "wt-1" }),
      pane("c", { worktreeId: "wt-2" }),
    ]);
    state.activeWorktreeId = "wt-1";
    state.gridGroups = [
      { id: "a", panelIds: ["a"], activeTabId: "a" },
      { id: "b", panelIds: ["b"], activeTabId: "b" },
    ];

    expect(listVisiblePaneIds(state)).toEqual(["a", "b"]);
  });

  it("rejects a pane of another worktree even when handed in as a grid group", () => {
    const state = arrange([pane("a", { worktreeId: "wt-2" })], { activeWorktreeId: "wt-1" });
    state.gridGroups = [{ id: "a", panelIds: ["a"], activeTabId: "a" }];

    expect(listVisiblePaneIds(state)).toEqual([]);
  });

  it("shows only the active tab of a tab group", () => {
    const state = arrange([pane("a"), pane("b"), pane("c")], {
      gridGroups: [
        { id: "group-1", panelIds: ["a", "b"], activeTabId: "b" },
        { id: "c", panelIds: ["c"], activeTabId: "c" },
      ],
    });

    expect(listVisiblePaneIds(state)).toEqual(["b", "c"]);
  });

  it("hands a closing active tab's place to the group's next tab, as the grid does", () => {
    const state = arrange([pane("a"), pane("b")], {
      gridGroups: [{ id: "group-1", panelIds: ["a", "b"], activeTabId: "a" }],
      isClosing: (id) => id === "a",
    });

    expect(listVisiblePaneIds(state)).toEqual(["b"]);
  });

  it("drops trashed panes", () => {
    const state = arrange([pane("a"), pane("b")], { trashedTerminals: new Set(["a"]) });

    expect(listVisiblePaneIds(state)).toEqual(["b"]);
  });

  it("shows only the maximized pane while one is maximized", () => {
    const state = arrange([pane("a"), pane("b")], {
      maximizedId: "b",
      maximizeTarget: { type: "panel", id: "b" },
    });

    expect(listVisiblePaneIds(state)).toEqual(["b"]);
  });

  it("shows the active tab of a maximized group, whichever tab was maximized from", () => {
    const state = arrange([pane("a"), pane("b"), pane("c")], {
      gridGroups: [
        { id: "group-1", panelIds: ["a", "b"], activeTabId: "b" },
        { id: "c", panelIds: ["c"], activeTabId: "c" },
      ],
      maximizedId: "a",
      maximizeTarget: { type: "group", id: "group-1" },
    });

    expect(listVisiblePaneIds(state)).toEqual(["b"]);
  });

  it("shows the grid again once the maximized pane is closing", () => {
    const state = arrange([pane("a"), pane("b"), pane("c")], {
      maximizedId: "a",
      maximizeTarget: { type: "panel", id: "a" },
      isClosing: (id) => id === "a",
    });

    expect(listVisiblePaneIds(state)).toEqual(["b", "c"]);
  });

  it("treats a half-set maximize as the plain grid, as ContentGrid does", () => {
    const state = arrange([pane("a"), pane("b")], { maximizedId: "b", maximizeTarget: null });

    expect(listVisiblePaneIds(state)).toEqual(["a", "b"]);
  });

  it("lists no grid pane while something else fills the main area, but keeps the open dock", () => {
    const state = arrange([pane("a"), pane("docked", { location: "dock" })], {
      gridHidden: true,
      activeDockTerminalId: "docked",
    });

    expect(listVisiblePaneIds(state)).toEqual(["docked"]);
  });

  it("lists the open dock popover", () => {
    const state = arrange([pane("a"), pane("docked", { location: "dock" })], {
      activeDockTerminalId: "docked",
    });

    expect(listVisiblePaneIds(state)).toEqual(["a", "docked"]);
  });

  it("lists nothing for a closed dock", () => {
    const state = arrange([pane("docked", { location: "dock", worktreeId: "wt-1" })], {
      activeWorktreeId: "wt-1",
      activeDockTerminalId: null,
    });

    expect(listVisiblePaneIds(state)).toEqual([]);
  });

  it("lists nothing for a dock pointer left over from another worktree", () => {
    const state = arrange([pane("docked", { location: "dock", worktreeId: "wt-2" })], {
      activeWorktreeId: "wt-1",
      activeDockTerminalId: "docked",
    });

    expect(listVisiblePaneIds(state)).toEqual([]);
  });

  it("drops an open dock pane that is closing", () => {
    const state = arrange([pane("docked", { location: "dock" })], {
      activeDockTerminalId: "docked",
      isClosing: (id) => id === "docked",
    });

    expect(listVisiblePaneIds(state)).toEqual([]);
  });

  it("never lists an assistant lane's terminal as the dock popover", () => {
    const state = arrange([pane("assistant", { location: "dock" })], {
      activeDockTerminalId: "assistant",
      helpTerminalIds: new Set(["assistant"]),
    });

    expect(listVisiblePaneIds(state)).toEqual([]);
  });
});

describe("pickRecentVisibleTarget", () => {
  const candidates = (...ids: string[]) => new Map(ids.map((id) => [id, { panelId: id }]));

  it("takes the newest terminal entry among the candidates", () => {
    expect(
      pickRecentVisibleTarget(candidates("a", "b"), [
        "terminal:gone",
        "worktree:wt-1",
        "terminal:b",
        "terminal:a",
      ])
    ).toEqual({ panelId: "b" });
  });

  it("ignores a worktree entry whose id names a candidate", () => {
    expect(pickRecentVisibleTarget(candidates("a", "b"), ["worktree:a"])).toBeNull();
  });

  it("takes the only candidate when none was focused", () => {
    expect(pickRecentVisibleTarget(candidates("a"), ["terminal:gone"])).toEqual({ panelId: "a" });
  });

  it("guesses at nothing when several candidates were never focused", () => {
    expect(pickRecentVisibleTarget(candidates("a", "b"), ["terminal:gone"])).toBeNull();
  });

  it("returns null with no candidates", () => {
    expect(pickRecentVisibleTarget(candidates(), ["terminal:a"])).toBeNull();
  });
});
