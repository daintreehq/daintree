import { describe, expect, it } from "vitest";
import type { BrowserPanelData, FilePanelData, PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";
import { buildDockRenderItems } from "../dockRenderItems";

function terminal(id: string, worktreeId?: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "dock",
    isVisible: false,
    worktreeId,
  } as PtyPanelData;
}

function group(panelIds: string[], activeTabId = panelIds[0] ?? "", overrides?: Partial<TabGroup>) {
  return {
    id: "group-1",
    panelIds,
    activeTabId,
    location: "dock",
    ...overrides,
  } satisfies TabGroup;
}

function groupMap(...groups: TabGroup[]): ReadonlyMap<string, TabGroup> {
  return new Map(groups.map((g) => [g.id, g]));
}

const NO_GROUPS: ReadonlyMap<string, TabGroup> = new Map();

function filePanel(id: string): FilePanelData {
  return {
    id,
    title: id,
    kind: "file",
    location: "dock",
    isVisible: false,
    filePath: `/repo/${id}.md`,
  } as FilePanelData;
}

function browserPanel(id: string): BrowserPanelData {
  return {
    id,
    title: id,
    kind: "browser",
    location: "dock",
    isVisible: false,
    browserUrl: `https://example.com/${id}`,
  } as BrowserPanelData;
}

function idsOf(items: ReturnType<typeof buildDockRenderItems>): string[] {
  return items.map((item) => item.group.id);
}

describe("buildDockRenderItems", () => {
  it("renders a docked file panel as a standalone chip", () => {
    const items = buildDockRenderItems([filePanel("spec")], NO_GROUPS, null);

    expect(items).toHaveLength(1);
    expect(items[0]?.panels[0]?.kind).toBe("file");
    expect(items[0]?.group.panelIds).toEqual(["spec"]);
  });

  it("renders a docked browser panel as a standalone chip", () => {
    // #11053: browser panels were committable to the dock but had no render
    // membership, so they vanished. They must surface as standalone chips.
    const items = buildDockRenderItems([browserPanel("docs")], NO_GROUPS, null);

    expect(items).toHaveLength(1);
    expect(items[0]?.panels[0]?.kind).toBe("browser");
    expect(items[0]?.group.panelIds).toEqual(["docs"]);
  });

  it("renders a browser panel standalone even when its stored group lists it", () => {
    // A grid tab group containing a terminal and a browser panel moved to the
    // dock: dock groups stay PTY-only, so the browser panel must not join the
    // group and must not vanish (#11053).
    const items = buildDockRenderItems(
      [terminal("term-1"), browserPanel("docs")],
      groupMap(group(["term-1", "docs"], "term-1")),
      null
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.group.panelIds).toEqual(["term-1"]);
    expect(items[1]?.panels[0]?.id).toBe("docs");
  });

  it("renders a file panel standalone even when its stored group lists it", () => {
    const items = buildDockRenderItems(
      [terminal("term-1"), filePanel("spec")],
      groupMap(group(["term-1", "spec"], "term-1")),
      null
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.group.panelIds).toEqual(["term-1"]);
    expect(items[1]?.panels[0]?.id).toBe("spec");
  });

  it("drops stale groups whose panels no longer resolve to dock panels", () => {
    const items = buildDockRenderItems([], groupMap(group(["closed-panel"])), null);

    expect(items).toEqual([]);
  });

  it("repairs panelIds and activeTabId to match resolved panels", () => {
    const items = buildDockRenderItems(
      [terminal("live-panel")],
      groupMap(group(["closed-panel", "live-panel"], "closed-panel")),
      null
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["live-panel"]);
    expect(items[0]?.group.activeTabId).toBe("live-panel");
    expect(items[0]?.panels.map((panel) => panel.id)).toEqual(["live-panel"]);
  });

  it("drops a group member that is absent from the ordered panel list", () => {
    // The help panel is filtered out of the ordered list upstream, so it must
    // not resurface through its stored group.
    const items = buildDockRenderItems(
      [terminal("live-panel")],
      groupMap(group(["help", "live-panel"], "help")),
      null
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["live-panel"]);
    expect(items[0]?.panels.map((panel) => panel.id)).toEqual(["live-panel"]);
  });

  it("renders ungrouped dock panels when there are no groups at all", () => {
    const items = buildDockRenderItems([terminal("ungrouped-dock")], NO_GROUPS, null);

    expect(items).toHaveLength(1);
    expect(items[0]?.group).toMatchObject({
      id: "ungrouped-dock",
      location: "dock",
      activeTabId: "ungrouped-dock",
      panelIds: ["ungrouped-dock"],
    });
    expect(items[0]?.panels.map((panel) => panel.id)).toEqual(["ungrouped-dock"]);
  });

  it("does not duplicate a panel rendered through a group", () => {
    const items = buildDockRenderItems(
      [terminal("live-panel")],
      groupMap(group(["live-panel"])),
      null
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["live-panel"]);
  });

  it("emits chips in the ordered panel list's order", () => {
    // The regression: a dock reorder rewrites only `panelIds`, so the ordered
    // list is the sole signal that anything moved. Order must come from it,
    // never from the tab-group map's iteration order.
    const items = buildDockRenderItems(
      [terminal("c"), terminal("a"), terminal("b")],
      NO_GROUPS,
      null
    );

    expect(idsOf(items)).toEqual(["c", "a", "b"]);
  });

  it("reorders the rail when only the ordered panel list changes", () => {
    const groups = groupMap(group(["a", "b"], "a", { id: "pair" }));
    const before = buildDockRenderItems(
      [terminal("a"), terminal("b"), terminal("solo")],
      groups,
      null
    );
    const after = buildDockRenderItems(
      [terminal("solo"), terminal("a"), terminal("b")],
      groups,
      null
    );

    expect(idsOf(before)).toEqual(["pair", "solo"]);
    expect(idsOf(after)).toEqual(["solo", "pair"]);
  });

  it("keeps a non-PTY panel at its canonical position instead of appending it", () => {
    // Resolving every group through a PTY-only filter dropped a non-PTY panel's
    // group and re-appended it after every terminal, so `[a1, browser, a2]`
    // rendered as `a1, a2, browser` (#11873).
    const items = buildDockRenderItems(
      [terminal("a1"), browserPanel("docs"), terminal("a2"), filePanel("spec")],
      NO_GROUPS,
      null
    );

    expect(idsOf(items)).toEqual(["a1", "docs", "a2", "spec"]);
  });

  it("keeps several non-PTY panels each at their own position", () => {
    const items = buildDockRenderItems(
      [browserPanel("docs"), terminal("a1"), filePanel("spec"), terminal("a2")],
      NO_GROUPS,
      null
    );

    expect(idsOf(items)).toEqual(["docs", "a1", "spec", "a2"]);
  });

  it("emits an explicit group at its earliest surviving member's position", () => {
    // #10435: forcing explicit groups ahead of virtual ones made a panel jump
    // to position 0 the moment it gained a second tab.
    const items = buildDockRenderItems(
      [terminal("solo"), terminal("a"), terminal("tail"), terminal("b")],
      groupMap(group(["a", "b"], "a", { id: "pair" })),
      null
    );

    expect(idsOf(items)).toEqual(["solo", "pair", "tail"]);
  });

  it("keeps a group's internal tab order even when the rail order differs", () => {
    const items = buildDockRenderItems(
      [terminal("b"), terminal("a")],
      groupMap(group(["a", "b"], "b", { id: "pair" })),
      null
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["a", "b"]);
    expect(items[0]?.group.activeTabId).toBe("b");
  });

  it("ignores a group scoped to another worktree, rendering its members standalone", () => {
    const items = buildDockRenderItems(
      [terminal("a"), terminal("b")],
      groupMap(group(["a", "b"], "a", { id: "pair", worktreeId: "wt-b" })),
      "wt-a"
    );

    expect(idsOf(items)).toEqual(["a", "b"]);
  });

  it("keeps a global group visible inside a worktree-scoped dock", () => {
    // Dock-global panels are visible in every worktree-scoped dock (#11289).
    const items = buildDockRenderItems(
      [terminal("a"), terminal("b")],
      groupMap(group(["a", "b"], "a", { id: "pair" })),
      "wt-a"
    );

    expect(idsOf(items)).toEqual(["pair"]);
  });

  it("orders two explicit groups by their earliest rail member, not map order", () => {
    // Positioning a group at `orderedPanels.indexOf(group.panelIds[0])`, or
    // simply preserving the map's insertion order, passes every single-group
    // test above but gets this one wrong.
    const groups = groupMap(
      group(["a", "b"], "a", { id: "g1" }),
      group(["c", "d"], "c", { id: "g2" })
    );

    expect(
      idsOf(
        buildDockRenderItems(
          [terminal("c"), terminal("d"), terminal("solo"), terminal("a"), terminal("b")],
          groups,
          null
        )
      )
    ).toEqual(["g2", "solo", "g1"]);

    expect(
      idsOf(
        buildDockRenderItems(
          [terminal("a"), terminal("b"), terminal("solo"), terminal("c"), terminal("d")],
          groups,
          null
        )
      )
    ).toEqual(["g1", "solo", "g2"]);
  });

  it("emits a group at its earliest rail member even when that is not its first tab", () => {
    const items = buildDockRenderItems(
      [terminal("b"), terminal("solo"), terminal("a")],
      groupMap(group(["a", "b"], "a", { id: "pair" })),
      null
    );

    expect(idsOf(items)).toEqual(["pair", "solo"]);
    expect(items[0]?.group.panelIds).toEqual(["a", "b"]);
  });

  it("repairs activeTabId when the active tab is a non-PTY member", () => {
    const items = buildDockRenderItems(
      [browserPanel("docs"), terminal("t2"), filePanel("spec"), terminal("t1")],
      groupMap(group(["t1", "docs", "t2", "spec"], "docs", { id: "mixed" })),
      null
    );

    expect(idsOf(items)).toEqual(["docs", "mixed", "spec"]);
    const mixed = items[1];
    expect(mixed?.panels.map((panel) => panel.id)).toEqual(["t1", "t2"]);
    expect(mixed?.group.activeTabId).toBe("t1");
  });

  it("renders every member standalone when a group has no PTY members at all", () => {
    const items = buildDockRenderItems(
      [filePanel("spec"), browserPanel("docs")],
      groupMap(group(["docs", "spec"], "docs")),
      null
    );

    expect(idsOf(items)).toEqual(["spec", "docs"]);
  });

  it("ignores a group stored against the grid", () => {
    const items = buildDockRenderItems(
      [terminal("a"), terminal("b")],
      groupMap(group(["a", "b"], "a", { id: "pair", location: "grid" })),
      null
    );

    expect(idsOf(items)).toEqual(["a", "b"]);
  });

  it("renders a panel once when two groups both claim it", () => {
    // Overlapping membership is invalid state, but it must not put the same
    // panel under two chips — two sortables would share one dnd-kit id.
    const items = buildDockRenderItems(
      [terminal("a"), terminal("b"), terminal("c")],
      groupMap(group(["a", "b"], "a", { id: "g1" }), group(["a", "c"], "a", { id: "g2" })),
      null
    );

    const rendered = items.flatMap((item) => item.panels.map((panel) => panel.id));
    expect(rendered).toEqual([...new Set(rendered)]);
    expect([...rendered].sort()).toEqual(["a", "b", "c"]);
  });

  it("renders a duplicated ordered panel once", () => {
    const dupe = terminal("a");
    const items = buildDockRenderItems([dupe, dupe], NO_GROUPS, null);

    expect(idsOf(items)).toEqual(["a"]);
  });

  it("does not mutate the groups or panels it is given", () => {
    // Freeze as statements so the bindings keep their mutable types — the
    // builder's parameters are already readonly, and casting back would just
    // trade a real assertion for a type assertion.
    const stored = group(["a", "closed"], "closed", { id: "pair" });
    Object.freeze(stored);
    Object.freeze(stored.panelIds);
    const panels = [terminal("a")];
    Object.freeze(panels);

    const items = buildDockRenderItems(panels, groupMap(stored), null);

    expect(items[0]?.group.panelIds).toEqual(["a"]);
    expect(items[0]?.group.activeTabId).toBe("a");
    // The stored group is the live Zustand object — it must come back untouched.
    expect(stored.panelIds).toEqual(["a", "closed"]);
    expect(stored.activeTabId).toBe("closed");
  });

  it("groups a global group under a global scope", () => {
    const items = buildDockRenderItems(
      [terminal("a"), terminal("b")],
      groupMap(group(["a", "b"], "a", { id: "pair" })),
      null
    );

    expect(idsOf(items)).toEqual(["pair"]);
  });

  it("groups a worktree-scoped group under its own worktree", () => {
    const items = buildDockRenderItems(
      [terminal("a", "wt-a"), terminal("b", "wt-a")],
      groupMap(group(["a", "b"], "a", { id: "pair", worktreeId: "wt-a" })),
      "wt-a"
    );

    expect(idsOf(items)).toEqual(["pair"]);
  });

  it("ignores a worktree-scoped group under the global scope", () => {
    const items = buildDockRenderItems(
      [terminal("a", "wt-a"), terminal("b", "wt-a")],
      groupMap(group(["a", "b"], "a", { id: "pair", worktreeId: "wt-a" })),
      null
    );

    expect(idsOf(items)).toEqual(["a", "b"]);
  });
});
