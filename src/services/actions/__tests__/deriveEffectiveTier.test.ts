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
  submoduleCommitsAtRisk: false,
  submoduleRiskUnverified: false,
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

  it("escalates to D3 on at-risk submodule commits even without force", () => {
    // The invisible case: parent porcelain prints zero bytes, so nothing in the
    // non-force refusal path is looking at the commits that would be lost.
    expect(
      deriveEffectiveTier(
        "worktree.delete",
        worktreeCtx({ force: false, submoduleCommitsAtRisk: true })
      )
    ).toBe("D3");
    expect(
      deriveEffectiveTier(
        "worktree.delete",
        worktreeCtx({ force: true, submoduleCommitsAtRisk: true })
      )
    ).toBe("D3");
  });

  it("treats an unverified submodule inventory as fail-closed under force only", () => {
    // Mirrors the parent's failed status fetch: it counts as work present when
    // the user has reached for force, but a delete we have no reason to think
    // is destructive must not demand the typed-name gate on a maybe.
    expect(
      deriveEffectiveTier(
        "worktree.delete",
        worktreeCtx({ force: false, submoduleRiskUnverified: true })
      )
    ).toBe("D2");
    expect(
      deriveEffectiveTier(
        "worktree.delete",
        worktreeCtx({ force: true, submoduleRiskUnverified: true })
      )
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
