import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot } from "@shared/types";
import {
  comparableBranch,
  comparisonBlocker,
  worktreeOptionLabel,
} from "../crossWorktreeDiffUtils";

function wt(id: string, branch: string | undefined, isDetached?: boolean): WorktreeSnapshot {
  return { id, name: id, path: `/wt/${id}`, branch, isDetached } as WorktreeSnapshot;
}

describe("a detached checkout that retains its last branch name", () => {
  it("has no comparable branch", () => {
    expect(comparableBranch(wt("a", "feature", true))).toBeUndefined();
    expect(comparableBranch(wt("a", "feature", false))).toBe("feature");
    expect(comparableBranch(wt("a", undefined))).toBeUndefined();
    expect(comparableBranch(null)).toBeUndefined();
  });

  it("is labelled as detached", () => {
    expect(worktreeOptionLabel(wt("a", "feature", true))).toBe("a (detached)");
  });

  it("blocks the comparison on whichever side is detached", () => {
    const attached = wt("b", "main");
    const detached = wt("a", "feature", true);
    expect(comparisonBlocker("a", detached, "b", attached)).toEqual({
      kind: "detached",
      side: "base",
      name: "a",
    });
    expect(comparisonBlocker("b", attached, "a", detached)).toEqual({
      kind: "detached",
      side: "compare",
      name: "a",
    });
  });
});
