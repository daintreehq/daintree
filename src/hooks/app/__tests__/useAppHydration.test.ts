import { describe, it, expect } from "vitest";
import { pickBootFocusPanelId } from "../useAppHydration";

type Panel = {
  location?: string;
  worktreeId?: string;
  lastActiveAt?: number;
};

function makePanels(...panels: Array<[string, Panel]>): Record<string, Panel> {
  return Object.fromEntries(panels);
}

describe("pickBootFocusPanelId (issue #9933)", () => {
  it("returns null when panelIds is empty", () => {
    expect(pickBootFocusPanelId([], {}, "w1")).toBeNull();
  });

  it("returns null when no panel matches the active worktree", () => {
    const panelsById = makePanels(["a", { location: "grid", worktreeId: "w1" }]);
    expect(pickBootFocusPanelId(["a"], panelsById, "w2")).toBeNull();
  });

  it("returns null when no panel is in the grid location", () => {
    const panelsById = makePanels(
      ["a", { location: "dock", worktreeId: "w1" }],
      ["b", { location: "trash", worktreeId: "w1" }]
    );
    expect(pickBootFocusPanelId(["a", "b"], panelsById, "w1")).toBeNull();
  });

  it("returns the first-in-order eligible panel when none have lastActiveAt", () => {
    // Legacy snapshot — `panelRestorePhase` falls back to saved order in
    // the same way, so the boot pick must match for consistency.
    const panelsById = makePanels(
      ["a", { location: "grid", worktreeId: "w1" }],
      ["b", { location: "grid", worktreeId: "w1" }]
    );
    expect(pickBootFocusPanelId(["a", "b"], panelsById, "w1")).toBe("a");
    // Reversed order — first eligible still wins (panelIds iteration order).
    expect(pickBootFocusPanelId(["b", "a"], panelsById, "w1")).toBe("b");
  });

  it("prefers the highest lastActiveAt, regardless of panelIds order", () => {
    const panelsById = makePanels(
      ["a", { location: "grid", worktreeId: "w1", lastActiveAt: 100 }],
      ["b", { location: "grid", worktreeId: "w1", lastActiveAt: 200 }],
      ["c", { location: "grid", worktreeId: "w1", lastActiveAt: 50 }]
    );
    // b has the highest timestamp even though it's not first in panelIds.
    expect(pickBootFocusPanelId(["a", "b", "c"], panelsById, "w1")).toBe("b");
    // Order-independent: try the reverse panelIds order.
    expect(pickBootFocusPanelId(["c", "b", "a"], panelsById, "w1")).toBe("b");
  });

  it("ignores panels from other worktrees even when they have higher lastActiveAt", () => {
    const panelsById = makePanels(
      ["a", { location: "grid", worktreeId: "w1", lastActiveAt: 100 }],
      ["b", { location: "grid", worktreeId: "w2", lastActiveAt: 9999 }]
    );
    // b is the most recent overall but belongs to a different worktree.
    expect(pickBootFocusPanelId(["a", "b"], panelsById, "w1")).toBe("a");
  });

  it("ignores non-grid panels even when they have higher lastActiveAt", () => {
    const panelsById = makePanels(
      ["a", { location: "grid", worktreeId: "w1", lastActiveAt: 100 }],
      ["b", { location: "dock", worktreeId: "w1", lastActiveAt: 9999 }]
    );
    expect(pickBootFocusPanelId(["a", "b"], panelsById, "w1")).toBe("a");
  });

  it("treats lastActiveAt <= 0 as 'no stamp' (mirrors panelRestorePhase)", () => {
    const panelsById = makePanels(
      ["a", { location: "grid", worktreeId: "w1", lastActiveAt: 0 }],
      ["b", { location: "grid", worktreeId: "w1", lastActiveAt: -5 }],
      ["c", { location: "grid", worktreeId: "w1" }]
    );
    // None of the stamps are valid; first eligible (in panelIds order) wins.
    expect(pickBootFocusPanelId(["a", "b", "c"], panelsById, "w1")).toBe("a");
  });

  it("rejects NaN and ±Infinity lastActiveAt", () => {
    const panelsById = makePanels(
      ["a", { location: "grid", worktreeId: "w1", lastActiveAt: Number.NaN }],
      ["b", { location: "grid", worktreeId: "w1", lastActiveAt: Number.POSITIVE_INFINITY }],
      ["c", { location: "grid", worktreeId: "w1", lastActiveAt: Number.NEGATIVE_INFINITY }]
    );
    expect(pickBootFocusPanelId(["a", "b", "c"], panelsById, "w1")).toBe("a");
  });

  it("matches panels with worktreeId === undefined when activeWorktreeId is null", () => {
    // Empty project / pre-worktree state: active worktree is null and
    // some legacy panels have no worktreeId. The picker's null-null
    // equivalence means they match.
    const panelsById = makePanels(["a", { location: "grid", worktreeId: undefined }]);
    expect(pickBootFocusPanelId(["a"], panelsById, null)).toBe("a");
  });

  it("does not match worktreeId === undefined when activeWorktreeId is set", () => {
    const panelsById = makePanels(["a", { location: "grid", worktreeId: undefined }]);
    expect(pickBootFocusPanelId(["a"], panelsById, "w1")).toBeNull();
  });

  it("skips unknown panelIds in panelsById (defensive against stale IDs)", () => {
    const panelsById = makePanels(["a", { location: "grid", worktreeId: "w1" }]);
    // "ghost" is in panelIds but missing from panelsById.
    expect(pickBootFocusPanelId(["ghost", "a"], panelsById, "w1")).toBe("a");
  });
});
