import { describe, expect, it } from "vitest";
import {
  applyWorktreeLabelColors,
  computeWorktreeColorMap,
  isWorktreeLabelToken,
  WORKTREE_COLOR_PALETTE,
} from "../worktreeColors.js";

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
    const entries: [string, { path: string }][] = WORKTREE_COLOR_PALETTE.map(
      (_: string, i: number) => [`wt-${i}`, { path: `/p/${String(i).padStart(2, "0")}` }]
    );
    const result = computeWorktreeColorMap(new Map(entries))!;
    const colors = new Set(Object.values(result));
    expect(colors.size).toBe(WORKTREE_COLOR_PALETTE.length);
  });
});

describe("applyWorktreeLabelColors", () => {
  it("returns the automatic map itself when nothing is labelled", () => {
    const auto = { "wt-a": "var(--theme-category-blue)" };
    expect(applyWorktreeLabelColors(auto, {})).toBe(auto);
    expect(applyWorktreeLabelColors(null, {})).toBeNull();
  });

  it("overrides the automatic colour without recolouring other worktrees", () => {
    const auto = computeWorktreeColorMap(
      new Map([
        ["wt-a", { path: "/p/a" }],
        ["wt-b", { path: "/p/b" }],
      ])
    )!;
    const result = applyWorktreeLabelColors(auto, { "wt-a": "category-pink" })!;
    expect(result["wt-a"]).toBe("var(--theme-category-pink)");
    expect(result["wt-b"]).toBe(auto["wt-b"]);
    expect(auto["wt-a"]).not.toBe("var(--theme-category-pink)");
  });

  it("shows a label even when single-worktree suppression left no map", () => {
    const auto = computeWorktreeColorMap(new Map([["wt-main", { path: "/p/main" }]]));
    expect(auto).toBeNull();
    expect(applyWorktreeLabelColors(auto, { "wt-main": "category-teal" })).toEqual({
      "wt-main": "var(--theme-category-teal)",
    });
  });
});

describe("isWorktreeLabelToken", () => {
  it("accepts only the label palette, not every category token", () => {
    expect(isWorktreeLabelToken("category-violet")).toBe(true);
    expect(isWorktreeLabelToken("category-orange")).toBe(false);
    expect(isWorktreeLabelToken(null)).toBe(false);
  });
});
