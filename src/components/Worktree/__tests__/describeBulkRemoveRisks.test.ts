import { describe, it, expect } from "vitest";
import { describeBulkRemoveRisks, type BulkRemoveTarget } from "../useWorktreeBulkRemove";

function target(over: Partial<BulkRemoveTarget> = {}): BulkRemoveTarget {
  return {
    id: "wt-1",
    name: "retry-jitter",
    branch: "fix/retry-backoff-jitter",
    path: "/tmp/worktrees/retry-jitter",
    trackedChangeCount: 0,
    untrackedFileCount: 0,
    aheadCount: 0,
    ...over,
  };
}

describe("describeBulkRemoveRisks", () => {
  /**
   * The invariant, asserted over the target's shape rather than over any
   * wording: every count this preview carries has to reach the confirmation.
   *
   * Written this way deliberately. `BulkRemoveTarget`'s numeric fields are all
   * risk counts, so a new one added later is covered here without anyone
   * remembering to extend this test — which is the whole point, because the bug
   * this guards against was a count being derived and silently never rendered.
   */
  it("surfaces every non-zero count the target carries", () => {
    const populated = target({
      trackedChangeCount: 3,
      untrackedFileCount: 5,
      aheadCount: 7,
    });
    const line = describeBulkRemoveRisks(populated).join(" · ");

    for (const [field, value] of Object.entries(populated)) {
      if (typeof value !== "number" || value === 0) continue;
      expect(
        line,
        `${field} is derived onto the target but never reaches the confirmation`
      ).toContain(String(value));
    }
  });

  it("reports nothing when nothing is at risk", () => {
    expect(describeBulkRemoveRisks(target())).toEqual([]);
  });

  it("treats untracked-only work as a risk in its own right", () => {
    // The regression case: a worktree with no tracked changes and no unpushed
    // commits still loses real files when its directory is deleted.
    const risks = describeBulkRemoveRisks(target({ untrackedFileCount: 2 }));
    expect(risks).toHaveLength(1);
    expect(risks[0]).toContain("2");
  });

  it("keeps each risk to its own phrase so they can be joined", () => {
    const risks = describeBulkRemoveRisks(
      target({ trackedChangeCount: 1, untrackedFileCount: 1, aheadCount: 1 })
    );
    expect(risks).toHaveLength(3);
    for (const risk of risks) {
      expect(risk).not.toContain("·");
    }
  });

  it("singularises a count of one and pluralises the rest", () => {
    const one = describeBulkRemoveRisks(target({ untrackedFileCount: 1 }))[0];
    const many = describeBulkRemoveRisks(target({ untrackedFileCount: 2 }))[0];
    expect(one?.endsWith("s")).toBe(false);
    expect(many?.endsWith("s")).toBe(true);
  });
});
