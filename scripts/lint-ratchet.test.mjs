import { describe, it, expect } from "vitest";
import { checkShrinkageGuard, aggregateByRule, checkByRule } from "./lint-ratchet.mjs";

// These import the pure helpers directly from the script — the `invokedDirectly`
// guard means importing the module does not spawn ESLint or touch the baseline.

const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

describe("lint-ratchet shrinkage guard", () => {
  describe("UPDATE_SHRINKAGE_THRESHOLD = 0.1", () => {
    it("passes when warnings decrease by exactly 10%", () => {
      // prior=100, new=90 → drop=0.10 exactly → not > 0.1
      const result = checkShrinkageGuard(100, 90, false);
      expect(result.blocked).toBe(false);
    });

    it("passes when warnings decrease by less than 10%", () => {
      // prior=100, new=91 → drop=0.09
      const result = checkShrinkageGuard(100, 91, false);
      expect(result.blocked).toBe(false);
    });

    it("blocks when warnings decrease by more than 10%", () => {
      // prior=100, new=89 → drop=0.11 > 0.1
      const result = checkShrinkageGuard(100, 89, false);
      expect(result.blocked).toBe(true);
      expect(result.message).toContain("::error::refusing to update baseline");
      expect(result.message).toContain("11.0% shrinkage");
      expect(result.message).toContain("10% threshold");
    });

    it("blocks large drops", () => {
      // prior=200, new=100 → drop=0.50
      const result = checkShrinkageGuard(200, 100, false);
      expect(result.blocked).toBe(true);
      expect(result.message).toContain("50.0% shrinkage");
    });

    it("passes when warning count stays the same", () => {
      const result = checkShrinkageGuard(100, 100, false);
      expect(result.blocked).toBe(false);
    });

    it("passes when warnings increase", () => {
      const result = checkShrinkageGuard(90, 100, false);
      expect(result.blocked).toBe(false);
    });
  });

  describe("--force flag", () => {
    it("bypasses the guard when --force is true", () => {
      // 30% drop → would normally block
      const result = checkShrinkageGuard(100, 70, true);
      expect(result.blocked).toBe(false);
    });

    it("bypasses the guard even at 100% drop", () => {
      const result = checkShrinkageGuard(100, 0, true);
      expect(result.blocked).toBe(false);
    });
  });

  describe("priorCount=0 edge cases", () => {
    it("allows update when prior count is 0 (avoids division by zero)", () => {
      // prior=0, new=5 → skip guard, not a shrinkage scenario
      const result = checkShrinkageGuard(0, 5, false);
      expect(result.blocked).toBe(false);
    });

    it("allows update when prior count is 0 and new count is 0", () => {
      const result = checkShrinkageGuard(0, 0, false);
      expect(result.blocked).toBe(false);
    });
  });

  describe("priorCount edge cases", () => {
    it("allows update when prior count is Infinity (malformed baseline)", () => {
      const result = checkShrinkageGuard(Infinity, 50, false);
      expect(result.blocked).toBe(false);
    });

    it("allows update when prior count is NaN (malformed baseline)", () => {
      const result = checkShrinkageGuard(NaN, 50, false);
      expect(result.blocked).toBe(false);
    });
  });

  describe("threshold boundary values", () => {
    it("10% boundary: prior=1000 new=900 → exactly 10%, passes", () => {
      const result = checkShrinkageGuard(1000, 900, false);
      expect(result.blocked).toBe(false);
    });

    it("just over 10%: prior=1000 new=899 → 10.1%, blocks", () => {
      const result = checkShrinkageGuard(1000, 899, false);
      expect(result.blocked).toBe(true);
    });

    it("small absolute numbers: prior=10 new=8 → 20%, blocks", () => {
      const result = checkShrinkageGuard(10, 8, false);
      expect(result.blocked).toBe(true);
    });

    it("small absolute numbers: prior=10 new=9 → 10%, passes", () => {
      const result = checkShrinkageGuard(10, 9, false);
      expect(result.blocked).toBe(false);
    });
  });
});

describe("aggregateByRule", () => {
  const mkFile = (filePath, messages) => ({ filePath, messages });

  it("tallies severity-1 warnings per rule across files", () => {
    const results = [
      mkFile("/src/a.ts", [
        { severity: 1, ruleId: "@typescript-eslint/no-explicit-any" },
        { severity: 1, ruleId: "no-console" },
      ]),
      mkFile("/src/b.ts", [{ severity: 1, ruleId: "@typescript-eslint/no-explicit-any" }]),
    ];
    expect(aggregateByRule(results)).toEqual({
      "@typescript-eslint/no-explicit-any": 2,
      "no-console": 1,
    });
  });

  it("excludes severity-2 (error) messages", () => {
    const results = [
      mkFile("/src/a.ts", [
        { severity: 2, ruleId: "no-debugger" },
        { severity: 1, ruleId: "no-console" },
      ]),
    ];
    expect(aggregateByRule(results)).toEqual({ "no-console": 1 });
  });

  it("excludes messages with null ruleId (parse/syntax errors)", () => {
    const results = [
      mkFile("/src/a.ts", [
        { severity: 1, ruleId: null },
        { severity: 1, ruleId: "no-console" },
      ]),
    ];
    expect(aggregateByRule(results)).toEqual({ "no-console": 1 });
  });

  it("returns keys sorted for deterministic diffs", () => {
    const results = [
      mkFile("/src/a.ts", [
        { severity: 1, ruleId: "zebra-rule" },
        { severity: 1, ruleId: "alpha-rule" },
        { severity: 1, ruleId: "@scope/mid-rule" },
      ]),
    ];
    expect(Object.keys(aggregateByRule(results))).toEqual([
      "@scope/mid-rule",
      "alpha-rule",
      "zebra-rule",
    ]);
  });

  it("returns an empty object when there are no warnings", () => {
    const results = [mkFile("/src/a.ts", [{ severity: 2, ruleId: "no-debugger" }])];
    expect(aggregateByRule(results)).toEqual({});
  });
});

describe("checkByRule", () => {
  it("flags a rule whose live count exceeds the baseline (warning-shift)", () => {
    const baseline = { "no-console": 5, "no-explicit-any": 10 };
    const live = { "no-console": 7, "no-explicit-any": 10 };
    const { regressed, disappeared, newRules } = checkByRule(baseline, live);
    expect(regressed).toEqual([{ rule: "no-console", from: 5, to: 7, delta: 2 }]);
    expect(disappeared).toEqual([]);
    expect(newRules).toEqual([]);
  });

  it("flags a rule present in the baseline but absent from live as disappeared", () => {
    const baseline = { "no-console": 5, "no-explicit-any": 10 };
    const live = { "no-explicit-any": 10 };
    const { disappeared, regressed, newRules } = checkByRule(baseline, live);
    expect(disappeared).toEqual(["no-console"]);
    expect(regressed).toEqual([]);
    expect(newRules).toEqual([]);
  });

  it("flags a rule present in live but absent from baseline as new", () => {
    const baseline = { "no-console": 5 };
    const live = { "no-console": 5, "new-rule": 3 };
    const { newRules, regressed, disappeared } = checkByRule(baseline, live);
    expect(newRules).toEqual([{ rule: "new-rule", to: 3 }]);
    expect(regressed).toEqual([]);
    expect(disappeared).toEqual([]);
  });

  it("passes cleanly when every rule's live count is <= baseline and present", () => {
    const baseline = { "no-console": 5, "no-explicit-any": 10 };
    const live = { "no-console": 4, "no-explicit-any": 10 };
    const { disappeared, regressed, newRules } = checkByRule(baseline, live);
    expect(disappeared).toEqual([]);
    expect(regressed).toEqual([]);
    expect(newRules).toEqual([]);
  });

  it("detects the canonical warning-shift: total flat, one rule up, one rule down", () => {
    // Total is 15 in both, but no-console rose while no-explicit-any fell —
    // the flat total can't see this; the per-rule check must.
    const baseline = { "no-console": 5, "no-explicit-any": 10 };
    const live = { "no-console": 8, "no-explicit-any": 7 };
    const { regressed } = checkByRule(baseline, live);
    expect(regressed).toEqual([{ rule: "no-console", from: 5, to: 8, delta: 3 }]);
  });

  it("reports multiple simultaneous regressions", () => {
    const baseline = { a: 1, b: 2, c: 3 };
    const live = { a: 2, b: 5, c: 3 };
    const { regressed } = checkByRule(baseline, live);
    expect(regressed).toEqual([
      { rule: "a", from: 1, to: 2, delta: 1 },
      { rule: "b", from: 2, to: 5, delta: 3 },
    ]);
  });
});
