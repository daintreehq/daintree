import { describe, expect, it } from "vitest";
import { checkResultsEqual, detectCheckResult } from "../CheckResultDetector.js";

const RAN_AT = 1_700_000_000_000;

describe("detectCheckResult", () => {
  it("returns null for empty or summary-free output", () => {
    expect(detectCheckResult("", RAN_AT)).toBeNull();
    expect(detectCheckResult("just some agent prose\nnothing structured here", RAN_AT)).toBeNull();
  });

  it("detects a passing tsc run", () => {
    const out = ["> daintree@1.0.0 typecheck", "> tsc --noEmit", "", "Found 0 errors."].join("\n");
    const result = detectCheckResult(out, RAN_AT);
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(true);
    expect(result?.failureSummary).toBeNull();
    expect(result?.truncated).toBe(false);
    expect(result?.ranAt).toBe(RAN_AT);
    expect(result?.command).toContain("tsc");
  });

  it("detects a failing tsc run with a failure summary", () => {
    const out = [
      "> tsc --noEmit",
      "src/foo.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Found 1 error in src/foo.ts:3",
    ].join("\n");
    const result = detectCheckResult(out, RAN_AT);
    expect(result?.passed).toBe(false);
    expect(result?.failureSummary).toContain("error TS2322");
    expect(result?.failureSummary).toContain("Found 1 error");
  });

  it("keys the ESLint verdict off errors, not warnings", () => {
    const warnOnly = "✖ 1 problem (0 errors, 1 warning)";
    expect(detectCheckResult(warnOnly, RAN_AT)?.passed).toBe(true);

    const withErrors = "✖ 5 problems (3 errors, 2 warnings)";
    const failing = detectCheckResult(withErrors, RAN_AT);
    expect(failing?.passed).toBe(false);
    expect(failing?.failureSummary).toContain("3 errors");
  });

  it("detects a failing Vitest run", () => {
    const out = [
      "$ vitest run",
      " FAIL  src/math.test.ts > adds",
      "Test Files  1 failed | 4 passed (5)",
      "     Tests  2 failed | 18 passed (20)",
    ].join("\n");
    const result = detectCheckResult(out, RAN_AT);
    expect(result?.passed).toBe(false);
    expect(result?.failureSummary).toContain("failed");
  });

  it("detects a passing Vitest run", () => {
    const out = ["$ vitest run", "Test Files  5 passed (5)", "     Tests  20 passed (20)"].join(
      "\n"
    );
    expect(detectCheckResult(out, RAN_AT)?.passed).toBe(true);
  });

  it("fails when a Vitest file fails to compile even if the Tests row shows all passed", () => {
    // A file that fails to compile contributes 0 tests, so the "Tests" row
    // (scanned first, bottom-up) can read clean while "Test Files" shows the
    // failure. The verdict must be pessimistic across the two adjacent rows.
    const out = [
      "$ vitest run",
      " FAIL  src/broken.test.ts [ import error ]",
      "Test Files  1 failed | 1 passed (2)",
      "     Tests  5 passed (5)",
    ].join("\n");
    expect(detectCheckResult(out, RAN_AT)?.passed).toBe(false);
  });

  it("detects a failing Jest run", () => {
    const out = ["$ jest", "Tests:       2 failed, 8 passed, 10 total"].join("\n");
    const result = detectCheckResult(out, RAN_AT);
    expect(result?.passed).toBe(false);
  });

  it("strips ANSI codes before matching", () => {
    const out = "[31mFound 2 errors.[0m";
    const result = detectCheckResult(out, RAN_AT);
    expect(result?.passed).toBe(false);
    expect(result?.failureSummary).toContain("Found 2 errors");
  });

  it("uses the most recent summary when several are present", () => {
    const out = ["Found 3 errors.", "...agent fixes things...", "Found 0 errors."].join("\n");
    expect(detectCheckResult(out, RAN_AT)?.passed).toBe(true);
  });

  it("returns null command when no echo is recoverable", () => {
    const result = detectCheckResult("Found 0 errors.", RAN_AT);
    expect(result?.command).toBeNull();
  });

  it("truncates an oversized failure summary and flags it", () => {
    const noise = Array.from({ length: 80 }, (_, i) => `src/a.ts(${i},1): error TS1000: boom`).join(
      "\n"
    );
    const out = [noise, "Found 80 errors."].join("\n");
    const result = detectCheckResult(out, RAN_AT);
    expect(result?.passed).toBe(false);
    expect(result?.truncated).toBe(true);
    expect(result?.failureSummary?.length ?? 0).toBeLessThanOrEqual(600);
  });

  describe("package-runner lifecycle failures", () => {
    it("detects a pnpm ELIFECYCLE failure", () => {
      const out = [
        "> pnpm test",
        "some test output with no recognized summary",
        " ELIFECYCLE  Command failed with exit code 1.",
      ].join("\n");
      const result = detectCheckResult(out, RAN_AT);
      expect(result?.passed).toBe(false);
      expect(result?.command).toContain("pnpm test");
      expect(result?.failureSummary).toContain("ELIFECYCLE");
    });

    it("detects an npm lifecycle-script failure", () => {
      const out = [
        "> npm run typecheck",
        "npm error Lifecycle script `typecheck` failed with error:",
        "npm error code 2",
      ].join("\n");
      const result = detectCheckResult(out, RAN_AT);
      expect(result?.passed).toBe(false);
      expect(result?.command).toContain("npm run typecheck");
    });

    it("detects yarn and bun script failures", () => {
      expect(detectCheckResult("error Command failed with exit code 1.", RAN_AT)?.passed).toBe(
        false
      );
      expect(detectCheckResult('error: script "test" exited with code 1', RAN_AT)?.passed).toBe(
        false
      );
    });

    it("prose mentioning a failure phrase mid-sentence does not fire", () => {
      const out = "Earlier the npm error Lifecycle script issue was fixed by pinning node.";
      expect(detectCheckResult(out, RAN_AT)).toBeNull();
    });

    it("a real tool summary below the lifecycle line still reports failure", () => {
      const out = [
        "> npm test",
        "Tests  2 failed | 8 passed (10)",
        " ELIFECYCLE  Command failed with exit code 1.",
      ].join("\n");
      const result = detectCheckResult(out, RAN_AT);
      expect(result?.passed).toBe(false);
      expect(result?.failureSummary).toContain("2 failed");
    });
  });
});

describe("checkResultsEqual", () => {
  const base = {
    command: "npm run check",
    passed: false,
    ranAt: 1,
    failureSummary: "boom",
    truncated: false,
  };

  it("ignores ranAt", () => {
    expect(checkResultsEqual(base, { ...base, ranAt: 999 })).toBe(true);
  });

  it("distinguishes pass/fail and summary changes", () => {
    expect(checkResultsEqual(base, { ...base, passed: true })).toBe(false);
    expect(checkResultsEqual(base, { ...base, failureSummary: "different" })).toBe(false);
    expect(checkResultsEqual(base, undefined)).toBe(false);
    expect(checkResultsEqual(undefined, undefined)).toBe(true);
  });
});
