import { describe, it, expect } from "vitest";
import { computeAlarmTier } from "../worktreeAlarmTier";

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
