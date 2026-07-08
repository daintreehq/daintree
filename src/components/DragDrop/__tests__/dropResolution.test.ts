import { describe, it, expect } from "vitest";
import {
  resolveContainerId,
  filterTerminalsByContainer,
  detectTargetContainer,
  resolveTargetIndex,
  resolveGroupPlacementIndex,
  resolveGridInsertionIndexFromRects,
  findGroupIndex,
  type ClientRectLike,
} from "../dropResolution";
import type { PanelInstance } from "@shared/types/panel";
import type { TabGroup } from "@shared/types";

function makeRect(left: number, top: number, width: number, height: number): ClientRectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeTerminal(id: string, location: "grid" | "dock", worktreeId?: string): PanelInstance {
  return {
    id,
    kind: "terminal",
    location,
    worktreeId,
    title: `Terminal ${id}`,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  } as PanelInstance;
}

function makeTabGroup(
  id: string,
  location: "grid" | "dock",
  panelIds: string[],
  worktreeId?: string
): TabGroup {
  return { id, location, panelIds, worktreeId, activeTabId: panelIds[0] ?? id } as TabGroup;
}

// ---------------------------------------------------------------------------
// resolveContainerId
// ---------------------------------------------------------------------------
describe("resolveContainerId", () => {
  it('maps "grid-container" to "grid"', () => {
    expect(resolveContainerId("grid-container")).toBe("grid");
  });

  it('maps "dock-container" to "dock"', () => {
    expect(resolveContainerId("dock-container")).toBe("dock");
  });

  it("returns null for unknown container IDs", () => {
    expect(resolveContainerId("worktree-foo-accordion")).toBeNull();
    expect(resolveContainerId("")).toBeNull();
    expect(resolveContainerId("random")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// filterTerminalsByContainer
// ---------------------------------------------------------------------------
describe("filterTerminalsByContainer", () => {
  const tA = makeTerminal("a", "grid", "wt1");
  const tB = makeTerminal("b", "dock", "wt1");
  const tC = makeTerminal("c", "grid", "wt1");
  const tD = makeTerminal("d", "dock", "wt2");
  const terminalsById = { a: tA, b: tB, c: tC, d: tD };
  const panelIds = ["a", "b", "c", "d"];

  it("filters grid terminals for a worktree", () => {
    const result = filterTerminalsByContainer(terminalsById, panelIds, "grid", "wt1");
    expect(result.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("filters dock terminals for a worktree", () => {
    const result = filterTerminalsByContainer(terminalsById, panelIds, "dock", "wt1");
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });

  it("treats undefined location as grid", () => {
    const tE = makeTerminal("e", "grid", "wt1");
    (tE as unknown as Record<string, unknown>).location = undefined;
    const byId = { ...terminalsById, e: tE };
    const result = filterTerminalsByContainer(byId, [...panelIds, "e"], "grid", "wt1");
    expect(result.map((t) => t.id)).toEqual(["a", "c", "e"]);
  });

  it("skips terminals with wrong worktreeId", () => {
    const result = filterTerminalsByContainer(terminalsById, panelIds, "dock", "wt1");
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });

  it("skips undefined terminals (stale ID in panelIds)", () => {
    const result = filterTerminalsByContainer(terminalsById, [...panelIds, "ghost"], "grid", "wt1");
    expect(result.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("preserves panelIds ordering", () => {
    const result = filterTerminalsByContainer(terminalsById, ["c", "a"], "grid", "wt1");
    expect(result.map((t) => t.id)).toEqual(["c", "a"]);
  });

  it("handles null worktreeId by converting to undefined", () => {
    const tNull = makeTerminal("null", "grid", undefined);
    (tNull as unknown as Record<string, unknown>).worktreeId = null;
    const byId = { null: tNull };
    const result = filterTerminalsByContainer(byId, ["null"], "grid", null);
    expect(result.map((t) => t.id)).toEqual(["null"]);
  });
});

// ---------------------------------------------------------------------------
// detectTargetContainer
// ---------------------------------------------------------------------------
describe("detectTargetContainer", () => {
  const overTerminal = makeTerminal("t1", "dock", "wt1");
  const terminalsById = { t1: overTerminal };

  it("P1: returns direct container from overData", () => {
    expect(detectTargetContainer({ container: "dock" }, null, "t1", terminalsById, false)).toBe(
      "dock"
    );
    expect(detectTargetContainer({ container: "grid" }, "dock", "t1", terminalsById, false)).toBe(
      "grid"
    );
  });

  it("P2: resolves sortable.containerId", () => {
    expect(
      detectTargetContainer(
        { sortable: { containerId: "grid-container" } },
        null,
        "t1",
        terminalsById,
        false
      )
    ).toBe("grid");
  });

  it("P2: returns null for unknown containerId when P3/P4 also miss", () => {
    // unknown containerId → falls through to P3 (null) → P4 (ghost not found) → null
    expect(
      detectTargetContainer(
        { sortable: { containerId: "accordion-x" } },
        null,
        "ghost",
        terminalsById,
        false
      )
    ).toBeNull();
  });

  it("P2: unknown sortable.containerId blocks cascade (does not fall to P3/P4)", () => {
    // old else-if chain: entering P2 branch blocks P3/P4 even when containerId is unknown
    expect(
      detectTargetContainer(
        { sortable: { containerId: "accordion-x" } },
        "dock",
        "t1",
        terminalsById,
        false
      )
    ).toBeNull();
  });

  it("P3: falls back to dropContainer", () => {
    expect(detectTargetContainer(undefined, "dock", "t1", terminalsById, false)).toBe("dock");
  });

  it("P1 beats P2/P3/P4", () => {
    expect(
      detectTargetContainer(
        { container: "grid", sortable: { containerId: "dock-container" } },
        "dock",
        "t1",
        terminalsById,
        false
      )
    ).toBe("grid");
  });

  it("P4: resolves from terminal location", () => {
    expect(detectTargetContainer(undefined, null, "t1", terminalsById, false)).toBe("dock");
  });

  it("P4: respects skipAccordionTarget", () => {
    expect(detectTargetContainer(undefined, null, "t1", terminalsById, true)).toBeNull();
  });

  it("P4: returns null when overId terminal not found", () => {
    expect(detectTargetContainer(undefined, null, "ghost", terminalsById, false)).toBeNull();
  });

  it("P4: maps non-dock location to grid", () => {
    const t2 = makeTerminal("t2", "grid", "wt1");
    expect(detectTargetContainer(undefined, null, "t2", { t2 }, false)).toBe("grid");
  });
});

// ---------------------------------------------------------------------------
// resolveTargetIndex
// ---------------------------------------------------------------------------
describe("resolveTargetIndex", () => {
  const tA = makeTerminal("a", "grid", "wt1");
  const tB = makeTerminal("b", "grid", "wt1");
  const tC = makeTerminal("c", "grid", "wt1");
  const terminalsById = { a: tA, b: tB, c: tC };
  const panelIds = ["a", "b", "c"];

  it("finds exact terminal match index", () => {
    expect(resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, false)).toBe(
      1
    );
  });

  it("falls back to sortableIndex when overId not found", () => {
    expect(resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "ghost", 2, false)).toBe(2);
  });

  it("appends to end when no match and no sortableIndex", () => {
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "ghost", undefined, false)
    ).toBe(3);
  });

  it("skips exact match for accordion over (skipAccordionOver)", () => {
    expect(resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, true)).toBe(
      3
    );
  });

  it("filters by worktreeId", () => {
    const tD = makeTerminal("d", "grid", "wt2");
    const byId = { ...terminalsById, d: tD };
    const ids = [...panelIds, "d"];
    // "d" is wt2 and won't appear when filtering for wt1
    expect(resolveTargetIndex(byId, ids, "wt1", "grid", "d", undefined, false)).toBe(3);
  });

  // Geometry-aware branch (dock→grid single-terminal drops). Over rect spans
  // x:[0,100] y:[0,100]; the active center decides before ("b" → 1) vs after → 2.
  const over = makeRect(0, 0, 100, 100);

  it("exact grid match with geometry left-of-midpoint keeps before-index", () => {
    const active = makeRect(20, 40, 20, 20); // center (30, 50) → left half
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, false, {
        activeRect: active,
        overRect: over,
      })
    ).toBe(1);
  });

  it("exact grid match with geometry right-of-midpoint advances to after-index", () => {
    const active = makeRect(60, 40, 20, 20); // center (70, 50) → right half
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, false, {
        activeRect: active,
        overRect: over,
      })
    ).toBe(2);
  });

  it("exact grid match with missing rects biases after the hovered panel, not before", () => {
    // Hovering "a" (idx 0) with null rects → after → 1 (not the before-biased 0)
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "a", undefined, false, {
        activeRect: null,
        overRect: null,
      })
    ).toBe(1);
  });

  it("exact grid match without geometry keeps the original before-index", () => {
    expect(resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "a", undefined, false)).toBe(
      0
    );
  });

  it("does not apply geometry when the exact-match branch is skipped (skipAccordionOver)", () => {
    // skipAccordionOver=true bypasses the findIndex branch entirely, so the
    // right-half geometry (which would give idx+1=2) must NOT apply; falls to sortableIndex.
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", 0, true, {
        activeRect: makeRect(60, 40, 20, 20),
        overRect: over,
      })
    ).toBe(0);
  });

  it("ignores geometry when overId misses (falls to sortableIndex)", () => {
    const active = makeRect(60, 40, 20, 20);
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "ghost", 2, false, {
        activeRect: active,
        overRect: over,
      })
    ).toBe(2);
  });

  it("honors previousAfter so the commit matches the previewed slot in the dead-zone", () => {
    // Hovering "b" (idx 1), center just left of midpoint (raw = before = 1), but the
    // preview held after; previousAfter reconstructs the after-index (2) in
    // terminal-space so the commit lands where the placeholder previewed.
    const active = makeRect(38, 40, 20, 20); // center x = 48, dist 2 < 8
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, false, {
        activeRect: active,
        overRect: over,
        previousAfter: true,
      })
    ).toBe(2);
    // Without the memoized verdict the raw geometry would commit before (1).
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, false, {
        activeRect: active,
        overRect: over,
      })
    ).toBe(1);
  });

  it("reconstructs previousAfter=false as the before-index for the hovered terminal", () => {
    // Hovering "b" (idx 1), center just right of midpoint (raw = after = 2), but the
    // preview held before; previousAfter=false reconstructs idx (1).
    const active = makeRect(42, 40, 20, 20); // center x = 52, dist 2 < 8
    expect(
      resolveTargetIndex(terminalsById, panelIds, "wt1", "grid", "b", undefined, false, {
        activeRect: active,
        overRect: over,
        previousAfter: false,
      })
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveGridInsertionIndexFromRects
// ---------------------------------------------------------------------------
describe("resolveGridInsertionIndexFromRects", () => {
  const over = makeRect(0, 0, 100, 100); // midX = 50, band y:[0,100)

  it("biases after when the active rect is missing", () => {
    expect(resolveGridInsertionIndexFromRects(0, null, over)).toBe(1);
  });

  it("biases after when the over rect is missing", () => {
    expect(resolveGridInsertionIndexFromRects(0, makeRect(40, 40, 20, 20), null)).toBe(1);
  });

  it("biases after for degenerate (zero/NaN) rect dimensions", () => {
    expect(resolveGridInsertionIndexFromRects(0, makeRect(40, 40, 0, 20), over)).toBe(1);
    expect(resolveGridInsertionIndexFromRects(0, makeRect(40, 40, Number.NaN, 20), over)).toBe(1);
  });

  it("biases after for a finite-size rect with a non-finite position", () => {
    // width/height are valid but left is NaN → centerX is NaN; must still fall
    // back to after, not silently resolve before.
    const active = {
      left: Number.NaN,
      top: 40,
      width: 20,
      height: 20,
      right: Number.NaN,
      bottom: 60,
    };
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(1);
  });

  it("returns before when the center is above the target row", () => {
    const active = makeRect(40, -60, 20, 20); // center y = -50 < 0
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(0);
  });

  it("returns after when the center is below the target row", () => {
    const active = makeRect(40, 120, 20, 20); // center y = 130 >= 100
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(1);
  });

  it("treats center exactly at the top edge as in-band (splits horizontally)", () => {
    // center y = 0 == over.top; `< top` is false → same band, right half → after
    expect(resolveGridInsertionIndexFromRects(0, makeRect(60, -10, 20, 20), over)).toBe(1);
    // same edge, left half → before
    expect(resolveGridInsertionIndexFromRects(0, makeRect(20, -10, 20, 20), over)).toBe(0);
  });

  it("treats center exactly at the bottom edge as after (>= bottom), even on the left", () => {
    // center y = 100 == over.bottom → after regardless of x
    expect(resolveGridInsertionIndexFromRects(0, makeRect(20, 90, 20, 20), over)).toBe(1);
  });

  it("returns after below the row even when x is far left (reading order)", () => {
    const active = makeRect(0, 120, 20, 20); // center (10, 130)
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(1);
  });

  it("splits on the horizontal midpoint within the same row", () => {
    expect(resolveGridInsertionIndexFromRects(0, makeRect(20, 40, 20, 20), over)).toBe(0); // cx 30
    expect(resolveGridInsertionIndexFromRects(0, makeRect(60, 40, 20, 20), over)).toBe(1); // cx 70
  });

  it("biases after on an exact horizontal tie", () => {
    const active = makeRect(40, 40, 20, 20); // center x = 50 == midX
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(1);
  });

  it("holds the previous 'after' verdict inside the hysteresis dead-zone", () => {
    const active = makeRect(38, 40, 20, 20); // center x = 48, dist 2 < 8, raw = before
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(0); // no memory → raw
    expect(resolveGridInsertionIndexFromRects(0, active, over, 1)).toBe(1); // holds after
  });

  it("holds the previous 'before' verdict inside the hysteresis dead-zone", () => {
    const active = makeRect(42, 40, 20, 20); // center x = 52, dist 2 < 8, raw = after
    expect(resolveGridInsertionIndexFromRects(0, active, over)).toBe(1); // no memory → raw
    expect(resolveGridInsertionIndexFromRects(0, active, over, 0)).toBe(0); // holds before
  });

  it("lets the raw verdict win once the center leaves the dead-zone", () => {
    const active = makeRect(60, 40, 20, 20); // center x = 70, dist 20 > 8
    expect(resolveGridInsertionIndexFromRects(0, active, over, 0)).toBe(1);
  });

  it("does not hold at exactly the dead-zone boundary (distance == hysteresisPx)", () => {
    // center x = 42, dist exactly 8; `< 8` is false so the hold does not engage → raw before
    expect(resolveGridInsertionIndexFromRects(0, makeRect(32, 40, 20, 20), over, 1)).toBe(0);
  });

  it("ignores a previousIndex that does not belong to this base index", () => {
    const active = makeRect(38, 40, 20, 20); // center x = 48 (would hold if adjacent)
    // previousIndex 5 is not baseIndex(0) or baseIndex+1(1) → recompute raw = before
    expect(resolveGridInsertionIndexFromRects(0, active, over, 5)).toBe(0);
  });

  it("honors hysteresis relative to a non-zero base index", () => {
    const active = makeRect(38, 40, 20, 20); // raw = before = 2
    expect(resolveGridInsertionIndexFromRects(2, active, over, 3)).toBe(3); // holds after
    expect(resolveGridInsertionIndexFromRects(2, active, over, 0)).toBe(2); // 0 not adjacent → raw
  });
});

// `isGridFull` was removed in #8805 — the scrollable grid no longer rejects
// drops based on a screen-fit cap; the grid scrolls vertically instead.

// ---------------------------------------------------------------------------
// resolveGroupPlacementIndex
// ---------------------------------------------------------------------------
describe("resolveGroupPlacementIndex", () => {
  const groups: TabGroup[] = [
    makeTabGroup("g1", "grid", ["a", "b"]),
    makeTabGroup("g2", "grid", ["c"]),
    makeTabGroup("g3", "grid", ["d"]),
  ];

  it("finds index by group ID match", () => {
    expect(resolveGroupPlacementIndex(groups, "g2", undefined)).toBe(1);
  });

  it("finds index by panel ID membership", () => {
    expect(resolveGroupPlacementIndex(groups, "d", undefined)).toBe(2);
  });

  it("falls back to clamped sortableIndex when no match", () => {
    expect(resolveGroupPlacementIndex(groups, "ghost", 0)).toBe(0);
    expect(resolveGroupPlacementIndex(groups, "ghost", 5)).toBe(2); // clamped to length-1
  });

  it("falls back to last position when no match and no sortableIndex", () => {
    expect(resolveGroupPlacementIndex(groups, "ghost", undefined)).toBe(2);
  });

  it("handles empty groups", () => {
    expect(resolveGroupPlacementIndex([], "x", undefined)).toBe(-1);
  });

  it("handles empty groups with sortableIndex", () => {
    // tabGroups.length - 1 = -1, Math.max(0, 3) = 3, Math.min(3, -1) = -1
    // This edge case shouldn't happen in practice but we preserve the math
    const result = resolveGroupPlacementIndex([], "x", 3);
    expect(result).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// findGroupIndex
// ---------------------------------------------------------------------------
describe("findGroupIndex", () => {
  const groups: TabGroup[] = [
    makeTabGroup("g1", "grid", ["a", "b"]),
    makeTabGroup("g2", "grid", ["c"]),
  ];

  it("finds by groupId match (priority)", () => {
    expect(findGroupIndex(groups, "g2", "a")).toBe(1);
  });

  it("falls back to panel membership", () => {
    expect(findGroupIndex(groups, undefined, "c")).toBe(1);
    expect(findGroupIndex(groups, "nonexistent", "a")).toBe(0);
  });

  it("returns -1 when not found", () => {
    expect(findGroupIndex(groups, undefined, "ghost")).toBe(-1);
  });
});
