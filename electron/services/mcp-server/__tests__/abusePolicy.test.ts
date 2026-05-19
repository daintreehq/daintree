import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AbusePolicy } from "../abusePolicy.js";

interface PolicyConfig {
  auditEnabled: boolean;
  abusePolicyEnabled: boolean;
  abusePolicyMaxDenials: number;
  abusePolicyWindowMs: number;
}

function makePolicy(config: PolicyConfig) {
  const readConfig = vi.fn(() => config);
  return { policy: new AbusePolicy({ readConfig }), readConfig };
}

describe("AbusePolicy", () => {
  let baseConfig: PolicyConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    baseConfig = {
      auditEnabled: true,
      abusePolicyEnabled: true,
      abusePolicyMaxDenials: 5,
      abusePolicyWindowMs: 60_000,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("kill-switch", () => {
    it("returns tripped=false when auditEnabled is false", () => {
      const { policy } = makePolicy({ ...baseConfig, auditEnabled: false });
      for (let i = 0; i < 10; i++) {
        expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: false });
      }
    });

    it("returns tripped=false when abusePolicyEnabled is false", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyEnabled: false });
      for (let i = 0; i < 10; i++) {
        expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: false });
      }
    });

    it("does not create Map entries when disabled", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyEnabled: false });
      policy.recordDenial("s1", "auth401");
      expect(policy.getSnapshot("s1")).toBeNull();
    });
  });

  describe("threshold", () => {
    it("returns tripped=false when below maxDenials", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 5 });
      for (let i = 0; i < 4; i++) {
        expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: false });
      }
    });

    it("returns tripped=true when reaching maxDenials", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 3 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "auth401");
      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: true });
    });

    it("returns tripped=true past the threshold", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 2 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "auth401");
      expect(policy.recordDenial("s1", "tierMismatch")).toEqual({ tripped: true });
    });

    it("trips at maxDenials=1 (zero-tolerance)", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 1 });
      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: true });
    });
  });

  describe("sliding window", () => {
    it("resets count after window expires", () => {
      const { policy } = makePolicy({
        ...baseConfig,
        abusePolicyMaxDenials: 3,
        abusePolicyWindowMs: 10_000,
      });

      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "auth401");

      vi.advanceTimersByTime(11_000);

      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: false });
    });

    it("does not reset if within window", () => {
      const { policy } = makePolicy({
        ...baseConfig,
        abusePolicyMaxDenials: 3,
        abusePolicyWindowMs: 10_000,
      });

      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "auth401");

      vi.advanceTimersByTime(5_000);

      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: true });
    });
  });

  describe("mixed inputs", () => {
    it("401 and tierMismatch denials share the same counter", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 3 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "tierMismatch");
      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: true });
    });
  });

  describe("per-session isolation", () => {
    it("independent sessions do not interfere", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 3 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s2", "auth401");
      policy.recordDenial("s2", "auth401");
      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: true });
      expect(policy.recordDenial("s2", "auth401")).toEqual({ tripped: true });
      expect(policy.getSnapshot("s1")).toEqual({ count: 3, tripped: true });
      expect(policy.getSnapshot("s2")).toEqual({ count: 3, tripped: true });
    });

    it("tripping one session does not affect another", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 2 });
      policy.recordDenial("s1", "auth401");
      expect(policy.recordDenial("s1", "auth401")).toEqual({ tripped: true });
      expect(policy.recordDenial("s2", "auth401")).toEqual({ tripped: false });
    });
  });

  describe("clearSession and clear", () => {
    it("clearSession removes state for one session", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 3 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s2", "auth401");
      policy.clearSession("s1");
      expect(policy.getSnapshot("s1")).toBeNull();
      expect(policy.getSnapshot("s2")).toEqual({ count: 1, tripped: false });
    });

    it("clear removes all state", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 3 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s2", "auth401");
      policy.clear();
      expect(policy.getSnapshot("s1")).toBeNull();
      expect(policy.getSnapshot("s2")).toBeNull();
    });
  });

  describe("getSnapshot", () => {
    it("returns null for unknown session", () => {
      const { policy } = makePolicy(baseConfig);
      expect(policy.getSnapshot("unknown")).toBeNull();
    });

    it("returns count and tripped for tracked session", () => {
      const { policy } = makePolicy({ ...baseConfig, abusePolicyMaxDenials: 3 });
      policy.recordDenial("s1", "auth401");
      policy.recordDenial("s1", "auth401");
      expect(policy.getSnapshot("s1")).toEqual({ count: 2, tripped: false });
    });
  });
});
