import { describe, it, expect } from "vitest";
import { computeAlarmTier, formatAlarmDetail } from "../worktreeAlarmTier";

describe("computeAlarmTier", () => {
  describe("tier 0 (none)", () => {
    it("returns tier 0 when no alarm fields are set", () => {
      expect(computeAlarmTier({})).toEqual({
        tier: 0,
        kind: "none",
        label: "",
        tone: "none",
      });
    });

    it("treats undefined behindCount as 0", () => {
      expect(computeAlarmTier({ behindCount: undefined }).tier).toBe(0);
    });

    it("treats behindCount === 0 as tier 0", () => {
      expect(computeAlarmTier({ behindCount: 0 }).tier).toBe(0);
    });

    it("treats CI 'success' as tier 0", () => {
      expect(computeAlarmTier({ ciState: "success" }).tier).toBe(0);
    });

    it("treats CI 'pending' as tier 0 (transient — would churn on every push)", () => {
      expect(computeAlarmTier({ ciState: "pending" }).tier).toBe(0);
    });

    it("treats CI 'neutral' as tier 0", () => {
      expect(computeAlarmTier({ ciState: "neutral" }).tier).toBe(0);
    });

    it("treats CI 'unknown' as tier 0", () => {
      expect(computeAlarmTier({ ciState: "unknown" }).tier).toBe(0);
    });

    it("treats missing ciState as tier 0", () => {
      expect(computeAlarmTier({ ciState: undefined }).tier).toBe(0);
    });

    it("does not include detached HEAD — gitStateIndicator already labels it", () => {
      // Detached is intentionally NOT in the alarm set; the title row's
      // gitStateIndicator surfaces it on both collapsed and expanded states.
      expect(computeAlarmTier({}).tier).toBe(0);
    });
  });

  describe("single-tier resolutions", () => {
    it("returns tier 1 (behind) for any behindCount > 0", () => {
      expect(computeAlarmTier({ behindCount: 1 })).toEqual({
        tier: 1,
        kind: "behind",
        label: "Behind",
        tone: "warning",
      });
      expect(computeAlarmTier({ behindCount: 99 }).tier).toBe(1);
    });

    it("returns tier 2 (auth-failed)", () => {
      expect(computeAlarmTier({ authFailed: true })).toEqual({
        tier: 2,
        kind: "auth-failed",
        label: "Auth failed",
        tone: "warning",
      });
    });

    it("returns tier 3 (CI failed) for ciState === 'failure'", () => {
      expect(computeAlarmTier({ ciState: "failure" })).toEqual({
        tier: 3,
        kind: "ci-failed",
        label: "CI failed",
        tone: "error",
      });
    });
  });

  describe("priority cascade — higher tier wins", () => {
    it("CI failure beats auth-failed", () => {
      expect(computeAlarmTier({ ciState: "failure", authFailed: true }).tier).toBe(3);
    });

    it("CI failure beats behind", () => {
      expect(computeAlarmTier({ ciState: "failure", behindCount: 3 }).tier).toBe(3);
    });

    it("auth-failed beats behind", () => {
      expect(computeAlarmTier({ authFailed: true, behindCount: 5 }).tier).toBe(2);
    });

    it("all alarms at once → tier 3", () => {
      expect(
        computeAlarmTier({
          ciState: "failure",
          authFailed: true,
          behindCount: 7,
        }).tier
      ).toBe(3);
    });
  });
});

describe("computeAlarmTier — base-branch drift", () => {
  it("raises the behind alarm for a branch whose only drift signal is the base", () => {
    // A worktree branch created without tracking has no upstream count at all;
    // its distance from the base is the only "behind" it will ever report.
    expect(computeAlarmTier({ baseBehindCount: 4 }).kind).toBe("behind");
  });

  it("stays quiet when neither distance is behind", () => {
    expect(computeAlarmTier({ behindCount: 0, baseBehindCount: 0 }).tier).toBe(0);
  });

  it("keeps CI failure above base drift", () => {
    expect(computeAlarmTier({ ciState: "failure", baseBehindCount: 9 }).kind).toBe("ci-failed");
  });

  it("keeps an auth failure above base drift", () => {
    expect(computeAlarmTier({ authFailed: true, baseBehindCount: 9 }).kind).toBe("auth-failed");
  });
});

/**
 * The collapsed pill dropped its label, and on a collapsed row nothing else
 * states the drift — the upstream badge only renders expanded. So this string
 * is the only place the counts appear, and the thing it must never do is
 * invent one: an absent count is "not measured", not zero.
 */
describe("formatAlarmDetail", () => {
  it("says nothing for the no-alarm kind", () => {
    expect(formatAlarmDetail("none", { behindCount: 3 })).toBeUndefined();
  });

  describe("behind", () => {
    it("names the upstream distance, pluralised", () => {
      expect(formatAlarmDetail("behind", { behindCount: 3 })).toBe("Upstream: 3 commits behind");
      expect(formatAlarmDetail("behind", { behindCount: 1 })).toBe("Upstream: 1 commit behind");
    });

    it("adds the ahead count behind the behind one, which is what raised the alarm", () => {
      expect(formatAlarmDetail("behind", { behindCount: 3, aheadCount: 2 })).toBe(
        "Upstream: 3 commits behind, 2 ahead"
      );
    });

    it("falls back to the base when the branch has no upstream count at all", () => {
      // A worktree branch created without tracking never reports an upstream
      // distance; its drift from the base is the only "behind" it will have.
      expect(
        formatAlarmDetail("behind", { baseBehindCount: 4, baseCompareRef: "upstream/develop" })
      ).toBe("Base (upstream/develop): 4 commits behind");
    });

    it("prefers the compare ref over the bare branch name — that is what was measured", () => {
      expect(
        formatAlarmDetail("behind", {
          baseBehindCount: 4,
          baseBranchName: "develop",
          baseCompareRef: "upstream/develop",
        })
      ).toBe("Base (upstream/develop): 4 commits behind");
    });

    it("falls back to the branch name, then to no name at all", () => {
      expect(formatAlarmDetail("behind", { baseBehindCount: 4, baseBranchName: "develop" })).toBe(
        "Base (develop): 4 commits behind"
      );
      expect(formatAlarmDetail("behind", { baseBehindCount: 4 })).toBe("Base: 4 commits behind");
    });

    it("names both distances when they are genuinely different measurements", () => {
      expect(
        formatAlarmDetail("behind", {
          behindCount: 1,
          baseBehindCount: 4,
          baseCompareRef: "upstream/develop",
        })
      ).toBe("Upstream: 1 commit behind · Base (upstream/develop): 4 commits behind");
    });

    it("drops the unlabelled pair when the two refs are the same commit", () => {
      // The dedupe `UpstreamSyncBadge` already does: one measurement written
      // twice, and only the labelled half says what it was counted against.
      expect(
        formatAlarmDetail("behind", {
          behindCount: 4,
          baseBehindCount: 4,
          baseCompareRef: "upstream/develop",
          baseMatchesUpstream: true,
        })
      ).toBe("Base (upstream/develop): 4 commits behind");
    });

    it("keeps the upstream pair when the base counts raced to zero", () => {
      // `baseMatchesUpstream` with nothing to dedupe onto must not render
      // nothing — the upstream pair is the fresher of the two.
      expect(
        formatAlarmDetail("behind", {
          behindCount: 4,
          baseBehindCount: 0,
          baseMatchesUpstream: true,
        })
      ).toBe("Upstream: 4 commits behind");
    });

    it("claims no distance it was not given", () => {
      expect(formatAlarmDetail("behind", {})).toBeUndefined();
      expect(formatAlarmDetail("behind", { behindCount: 0, baseBehindCount: 0 })).toBeUndefined();
      expect(formatAlarmDetail("behind", { behindCount: undefined })).toBeUndefined();
    });
  });

  describe("ci-failed", () => {
    it("counts the failing checks when the forge reported them", () => {
      expect(formatAlarmDetail("ci-failed", { ciFailed: 2, ciTotal: 7 })).toBe(
        "2 of 7 checks failing"
      );
      expect(formatAlarmDetail("ci-failed", { ciFailed: 1, ciTotal: 1 })).toBe(
        "1 of 1 check failing"
      );
    });

    it("still says what happened when it has no counts to give", () => {
      expect(formatAlarmDetail("ci-failed", {})).toBe("Checks failed on the linked pull request");
      expect(formatAlarmDetail("ci-failed", { ciFailed: 0, ciTotal: 0 })).toBe(
        "Checks failed on the linked pull request"
      );
    });
  });

  describe("auth-failed", () => {
    it("points at the affordance rather than implying the mark is one", () => {
      expect(formatAlarmDetail("auth-failed", {})).toBe(
        "Expand the card to reconnect your code forge"
      );
    });
  });
});
