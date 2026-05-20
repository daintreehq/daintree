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
  });

  describe("single-tier resolutions", () => {
    it("returns tier 1 (detached)", () => {
      expect(computeAlarmTier({ isDetached: true })).toEqual({
        tier: 1,
        kind: "detached",
        label: "Detached",
        tone: "warning",
      });
    });

    it("returns tier 2 (behind) for any behindCount > 0", () => {
      expect(computeAlarmTier({ behindCount: 1 })).toEqual({
        tier: 2,
        kind: "behind",
        label: "Behind",
        tone: "warning",
      });
      expect(computeAlarmTier({ behindCount: 99 }).tier).toBe(2);
    });

    it("returns tier 3 (auth-failed)", () => {
      expect(computeAlarmTier({ fetchAuthFailed: true })).toEqual({
        tier: 3,
        kind: "auth-failed",
        label: "Auth failed",
        tone: "warning",
      });
    });

    it("returns tier 4 (CI failed) for ciState === 'failure'", () => {
      expect(computeAlarmTier({ ciState: "failure" })).toEqual({
        tier: 4,
        kind: "ci-failed",
        label: "CI failed",
        tone: "error",
      });
    });
  });

  describe("priority cascade — higher tier wins", () => {
    it("CI failure beats auth-failed", () => {
      expect(computeAlarmTier({ ciState: "failure", fetchAuthFailed: true }).tier).toBe(4);
    });

    it("CI failure beats behind", () => {
      expect(computeAlarmTier({ ciState: "failure", behindCount: 3 }).tier).toBe(4);
    });

    it("CI failure beats detached", () => {
      expect(computeAlarmTier({ ciState: "failure", isDetached: true }).tier).toBe(4);
    });

    it("auth-failed beats behind", () => {
      expect(computeAlarmTier({ fetchAuthFailed: true, behindCount: 5 }).tier).toBe(3);
    });

    it("auth-failed beats detached", () => {
      expect(computeAlarmTier({ fetchAuthFailed: true, isDetached: true }).tier).toBe(3);
    });

    it("behind beats detached", () => {
      expect(computeAlarmTier({ behindCount: 1, isDetached: true }).tier).toBe(2);
    });

    it("all alarms at once → tier 4", () => {
      expect(
        computeAlarmTier({
          ciState: "failure",
          fetchAuthFailed: true,
          behindCount: 7,
          isDetached: true,
        }).tier
      ).toBe(4);
    });
  });
});
