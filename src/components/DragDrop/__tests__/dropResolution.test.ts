import { describe, it, expect } from "vitest";
import {
  resolveContainerId,
  filterTerminalsByContainer,
  detectTargetContainer,
  resolveTargetIndex,
  isGridFull,
  resolveGroupPlacementIndex,
  findGroupIndex,
} from "../dropResolution";
import type { TerminalInstance } from "@/store";
import type { TabGroup } from "@shared/types";

function makeTerminal(
  id: string,
  location: "grid" | "dock",
  worktreeId?: string
): TerminalInstance {
  return { id, location, worktreeId, title: `Terminal ${id}` } as TerminalInstance;
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
});

// ---------------------------------------------------------------------------
// isGridFull
// ---------------------------------------------------------------------------
describe("isGridFull", () => {
  it("returns true when count meets capacity", () => {
    const tA = makeTerminal("a", "grid", "wt1");
    const tB = makeTerminal("b", "grid", "wt1");
    const terminalsById = { a: tA, b: tB };
    expect(isGridFull(terminalsById, ["a", "b"], "wt1", new Map(), 2)).toBe(true);
  });

  it("returns false when count is below capacity", () => {
    const tA = makeTerminal("a", "grid", "wt1");
    expect(isGridFull({ a: tA }, ["a"], "wt1", new Map(), 2)).toBe(false);
  });

  it("counts explicit tab groups", () => {
    const group = makeTabGroup("g1", "grid", ["a", "b"], "wt1");
    const tA = makeTerminal("a", "grid", "wt1");
    const tB = makeTerminal("b", "grid", "wt1");
    const tabGroups = new Map([["g1", group]]);
    // 2-panel group counts as 1 slot; capacity=2 means NOT full (proves panels aren't double-counted)
    expect(isGridFull({ a: tA, b: tB }, ["a", "b"], "wt1", tabGroups, 2)).toBe(false);
  });

  it("counts ungrouped panels separately from grouped panels", () => {
    const group = makeTabGroup("g1", "grid", ["a"], "wt1");
    const tA = makeTerminal("a", "grid", "wt1");
    const tB = makeTerminal("b", "grid", "wt1"); // ungrouped
    const tabGroups = new Map([["g1", group]]);
    // 1 group + 1 ungrouped = 2, capacity = 2 => full
    expect(isGridFull({ a: tA, b: tB }, ["a", "b"], "wt1", tabGroups, 2)).toBe(true);
  });

  it("ignores dock-location groups in grid check", () => {
    const group = makeTabGroup("g1", "dock", ["a"], "wt1");
    const tA = makeTerminal("a", "grid", "wt1");
    const tB = makeTerminal("b", "grid", "wt1");
    const tabGroups = new Map([["g1", group]]);
    // group is dock, doesn't count; 2 grid terminals = 2 slots, capacity=2 => full
    expect(isGridFull({ a: tA, b: tB }, ["a", "b"], "wt1", tabGroups, 2)).toBe(true);
  });

  it("filters by worktreeId for groups", () => {
    const group = makeTabGroup("g1", "grid", ["a"], "wt2");
    const tA = makeTerminal("a", "grid", "wt1");
    const tabGroups = new Map([["g1", group]]);
    // wt2 group excluded; only 1 wt1 terminal counted; capacity=2 => not full
    expect(isGridFull({ a: tA }, ["a"], "wt1", tabGroups, 2)).toBe(false);
  });

  it("multiple groups fill independent slots", () => {
    const g1 = makeTabGroup("g1", "grid", ["a"], "wt1");
    const g2 = makeTabGroup("g2", "grid", ["b"], "wt1");
    const map = new Map([
      ["g1", g1],
      ["g2", g2],
    ]);
    const tA = makeTerminal("a", "grid", "wt1");
    const tB = makeTerminal("b", "grid", "wt1");
    // 2 groups = 2 slots; capacity=2 => full
    expect(isGridFull({ a: tA, b: tB }, ["a", "b"], "wt1", map, 2)).toBe(true);
    // capacity=3 => not full (proves each group counts as 1, not double-counted with terminals)
    expect(isGridFull({ a: tA, b: tB }, ["a", "b"], "wt1", map, 3)).toBe(false);
  });
});

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
