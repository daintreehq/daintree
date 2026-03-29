import { describe, expect, it } from "vitest";
import { computeWorktreeColorMap, WORKTREE_COLOR_PALETTE } from "../worktreeColors";

describe("computeWorktreeColorMap", () => {
  it("returns null for empty map", () => {
    expect(computeWorktreeColorMap(new Map())).toBeNull();
  });

  it("returns null for single worktree (suppression)", () => {
    const map = new Map([["wt1", { path: "/projects/main" }]]);
    expect(computeWorktreeColorMap(map)).toBeNull();
  });

  it("assigns colors to two worktrees sorted by path", () => {
    const map = new Map([
      ["wt-b", { path: "/projects/beta" }],
      ["wt-a", { path: "/projects/alpha" }],
    ]);
    const result = computeWorktreeColorMap(map)!;
    expect(result).not.toBeNull();
    // alpha sorts before beta
    expect(result["wt-a"]).toBe(`var(--theme-${WORKTREE_COLOR_PALETTE[0]})`);
    expect(result["wt-b"]).toBe(`var(--theme-${WORKTREE_COLOR_PALETTE[1]})`);
  });

  it("is deterministic regardless of insertion order", () => {
    const map1 = new Map([
      ["wt-a", { path: "/projects/alpha" }],
      ["wt-b", { path: "/projects/beta" }],
    ]);
    const map2 = new Map([
      ["wt-b", { path: "/projects/beta" }],
      ["wt-a", { path: "/projects/alpha" }],
    ]);
    expect(computeWorktreeColorMap(map1)).toEqual(computeWorktreeColorMap(map2));
  });

  it("cycles palette for more worktrees than palette size", () => {
    const entries: [string, { path: string }][] = [];
    for (let i = 0; i < WORKTREE_COLOR_PALETTE.length + 2; i++) {
      entries.push([
        `wt-${String(i).padStart(2, "0")}`,
        { path: `/p/${String(i).padStart(2, "0")}` },
      ]);
    }
    const result = computeWorktreeColorMap(new Map(entries))!;
    const values = Object.values(result);
    // First entry after wrap should match first palette color
    expect(values[WORKTREE_COLOR_PALETTE.length]).toBe(values[0]);
  });

  it("assigns all 8 palette colors for exactly 8 worktrees", () => {
    const entries: [string, { path: string }][] = WORKTREE_COLOR_PALETTE.map((_, i) => [
      `wt-${i}`,
      { path: `/p/${String(i).padStart(2, "0")}` },
    ]);
    const result = computeWorktreeColorMap(new Map(entries))!;
    const colors = new Set(Object.values(result));
    expect(colors.size).toBe(WORKTREE_COLOR_PALETTE.length);
  });
});
