import { describe, it, expect } from "vitest";
import {
  deriveEffectiveTier,
  PORTAL_BULK_CLOSE_TIER_THRESHOLD,
  type WorktreeDeleteTierCtx,
} from "../deriveEffectiveTier";

const worktreeCtx = (over: Partial<WorktreeDeleteTierCtx> = {}): WorktreeDeleteTierCtx => ({
  force: false,
  isProtectedBranch: false,
  isMainWorktree: false,
  hasTrackedChanges: false,
  ...over,
});

describe("deriveEffectiveTier — worktree.delete", () => {
  it("is D2 whenever force is false, regardless of other context", () => {
    expect(deriveEffectiveTier("worktree.delete", worktreeCtx({ force: false }))).toBe("D2");
    expect(
      deriveEffectiveTier(
        "worktree.delete",
        worktreeCtx({
          force: false,
          isProtectedBranch: true,
          isMainWorktree: true,
          hasTrackedChanges: true,
        })
      )
    ).toBe("D2");
  });

  it("escalates to D3 with force + protected branch", () => {
    expect(
      deriveEffectiveTier("worktree.delete", worktreeCtx({ force: true, isProtectedBranch: true }))
    ).toBe("D3");
  });

  it("escalates to D3 with force + main worktree", () => {
    expect(
      deriveEffectiveTier("worktree.delete", worktreeCtx({ force: true, isMainWorktree: true }))
    ).toBe("D3");
  });

  it("escalates to D3 with force + tracked changes", () => {
    expect(
      deriveEffectiveTier("worktree.delete", worktreeCtx({ force: true, hasTrackedChanges: true }))
    ).toBe("D3");
  });

  it("stays D2 with force but only untracked files (#4927 regression guard)", () => {
    // hasTrackedChanges:false models a worktree with untracked-only changes.
    // Collapsing tracked/untracked would wrongly demand the typed-name gate.
    expect(
      deriveEffectiveTier("worktree.delete", worktreeCtx({ force: true, hasTrackedChanges: false }))
    ).toBe("D2");
  });
});

describe("deriveEffectiveTier — portal bulk close", () => {
  it("threshold constant is 3", () => {
    expect(PORTAL_BULK_CLOSE_TIER_THRESHOLD).toBe(3);
  });

  it.each([
    ["portal.closeAllTabs", 0, "D0"],
    ["portal.closeAllTabs", 1, "D0"],
    ["portal.closeAllTabs", 2, "D0"],
    ["portal.closeAllTabs", 3, "D1"],
    ["portal.closeAllTabs", 7, "D1"],
    ["portal.closeOthers", 2, "D0"],
    ["portal.closeOthers", 3, "D1"],
  ] as const)("%s with %i tabs → %s", (actionId, tabCount, expected) => {
    expect(deriveEffectiveTier(actionId, { tabCount })).toBe(expected);
  });
});
