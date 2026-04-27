import { describe, it, expect } from "vitest";
import {
  TEST_FILE_RE,
  isFixTitle,
  isReleaseOrVersionBump,
  isEligiblePR,
  classifyPR,
  computeTestRatioReport,
  validateBaseline,
  compareToBaseline,
  formatBaseline,
  formatMarkdown,
} from "./test-ratio-lib.mjs";

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: (overrides.number as number) ?? 1,
    title: (overrides.title as string) ?? "feat: add feature",
    labels: overrides.labels ?? { nodes: [] },
    files: overrides.files ?? { nodes: [] },
  };
}

// ── Title classification ────────────────────────────────────────────────

describe("isFixTitle", () => {
  it("matches fix: prefix", () => {
    expect(isFixTitle("fix: resolve login regression")).toBe(true);
  });

  it("matches fix( scope", () => {
    expect(isFixTitle("fix(auth): patch token expiry")).toBe(true);
  });

  it("rejects non-fix titles", () => {
    expect(isFixTitle("feat: add logout button")).toBe(false);
    expect(isFixTitle("chore: update deps")).toBe(false);
    expect(isFixTitle("docs: fix typo in README")).toBe(false);
    expect(isFixTitle("fix")).toBe(false);
    expect(isFixTitle("")).toBe(false);
    expect(isFixTitle("prefix-fix: something")).toBe(false);
  });

  it("matches case-insensitive fix titles", () => {
    expect(isFixTitle("Fix: crash on startup")).toBe(true);
    expect(isFixTitle("FIX: restore state")).toBe(true);
    expect(isFixTitle("Fix(auth): patch token")).toBe(true);
  });
});

// ── Release / version-bump detection ─────────────────────────────────────

describe("isReleaseOrVersionBump", () => {
  it("matches chore(release): prefix", () => {
    expect(isReleaseOrVersionBump("chore(release): v0.7.2")).toBe(true);
  });

  it("matches version-tag titles", () => {
    expect(isReleaseOrVersionBump("v1.2.3")).toBe(true);
    expect(isReleaseOrVersionBump("2.0.0")).toBe(true);
    expect(isReleaseOrVersionBump("v0.7.1")).toBe(true);
  });

  it("rejects non-version non-release titles", () => {
    expect(isReleaseOrVersionBump("feat: add v2 support")).toBe(false);
    expect(isReleaseOrVersionBump("fix: v1 compat")).toBe(false);
    expect(isReleaseOrVersionBump("chore(deps): bump to v2")).toBe(false);
    expect(isReleaseOrVersionBump("")).toBe(false);
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────

describe("isEligiblePR", () => {
  it("accepts normal PRs", () => {
    expect(isEligiblePR(pr({ title: "feat: new panel" }))).toBe(true);
    expect(isEligiblePR(pr({ title: "fix: crash on startup" }))).toBe(true);
    expect(isEligiblePR(pr({ title: "chore: tidy up" }))).toBe(true);
  });

  it("skips release PRs", () => {
    expect(isEligiblePR(pr({ title: "chore(release): v0.7.2" }))).toBe(false);
    expect(isEligiblePR(pr({ title: "v1.0.0" }))).toBe(false);
  });

  it("labels are handled in GraphQL query (not here)", () => {
    // Documentation / dependencies labels are already filtered by the
    // `-label:` clause in the GraphQL search query. The lib does not
    // re-check labels — it trusts the API to exclude them.
    expect(isEligiblePR(pr({ title: "docs: update readme" }))).toBe(true);
  });
});

// ── Test file regex ──────────────────────────────────────────────────────

describe("TEST_FILE_RE", () => {
  it("matches .test.ts files", () => {
    expect(TEST_FILE_RE.test("src/components/Terminal/Terminal.test.ts")).toBe(true);
  });

  it("matches .spec.ts files", () => {
    expect(TEST_FILE_RE.test("src/store/panelStore.spec.ts")).toBe(true);
  });

  it("matches .test.tsx and .spec.tsx", () => {
    expect(TEST_FILE_RE.test("src/App.test.tsx")).toBe(true);
    expect(TEST_FILE_RE.test("src/App.spec.tsx")).toBe(true);
  });

  it("matches .test.js and .spec.js", () => {
    expect(TEST_FILE_RE.test("scripts/helpers.test.js")).toBe(true);
    expect(TEST_FILE_RE.test("scripts/helpers.spec.js")).toBe(true);
  });

  it("rejects non-test files", () => {
    expect(TEST_FILE_RE.test("src/utils/test-utils.ts")).toBe(false);
    expect(TEST_FILE_RE.test("src/components/TestButton.tsx")).toBe(false);
    expect(TEST_FILE_RE.test("scripts/check-test-ratio.mjs")).toBe(false);
  });
});

// ── classifyPR ───────────────────────────────────────────────────────────

describe("classifyPR", () => {
  it("marks fix title and test presence", () => {
    const r = classifyPR(
      pr({
        number: 42,
        title: "fix(auth): session token refresh",
        files: { nodes: [{ path: "src/auth/auth.test.ts" }] },
      })
    );
    expect(r.isFix).toBe(true);
    expect(r.touchesTests).toBe(true);
    expect(r.isSkipped).toBe(false);
  });

  it("fix PR without tests", () => {
    const r = classifyPR(
      pr({
        title: "fix: typo in error message",
        files: { nodes: [{ path: "src/lib/errors.ts" }] },
      })
    );
    expect(r.isFix).toBe(true);
    expect(r.touchesTests).toBe(false);
  });

  it("non-fix PR with test files", () => {
    const r = classifyPR(
      pr({
        title: "feat: add dark mode",
        files: { nodes: [{ path: "src/theme/dark.test.ts" }] },
      })
    );
    expect(r.isFix).toBe(false);
    expect(r.touchesTests).toBe(true);
  });

  it("skips release PRs", () => {
    const r = classifyPR(
      pr({
        title: "chore(release): v0.7.2",
        files: { nodes: [{ path: "package.json" }] },
      })
    );
    expect(r.isSkipped).toBe(true);
    expect(r.skipReason).toBe("release/version bump");
  });

  it("detects test files among mixed files", () => {
    const r = classifyPR(
      pr({
        files: {
          nodes: [{ path: "src/a.ts" }, { path: "src/b.tsx" }, { path: "src/a.test.ts" }],
        },
      })
    );
    expect(r.touchesTests).toBe(true);
  });

  it("handles empty files array", () => {
    const r = classifyPR(pr({ files: { nodes: [] } }));
    expect(r.touchesTests).toBe(false);
  });

  it("handles files passed as null (unrequested field)", () => {
    const r = classifyPR(pr({ files: null }));
    expect(r.touchesTests).toBe(false);
  });
});

// ── computeTestRatioReport ───────────────────────────────────────────────

describe("computeTestRatioReport", () => {
  it("returns zero ratios for empty input", () => {
    const report = computeTestRatioReport([], 100);
    expect(report.fixWithTestRatio).toBe(0);
    expect(report.allWithTestRatio).toBe(0);
    expect(report.fixCount).toBe(0);
    expect(report.totalCount).toBe(0);
    expect(report.windowCompleted).toBe(false);
  });

  it("computes both ratios from classified PRs", () => {
    const classified = [
      { number: 1, title: "fix: a", isFix: true, touchesTests: true, isSkipped: false },
      { number: 2, title: "fix: b", isFix: true, touchesTests: false, isSkipped: false },
      { number: 3, title: "feat: c", isFix: false, touchesTests: true, isSkipped: false },
      { number: 4, title: "feat: d", isFix: false, touchesTests: false, isSkipped: false },
    ];
    const report = computeTestRatioReport(classified, 100);
    expect(report.fixCount).toBe(2);
    expect(report.fixWithTestCount).toBe(1);
    expect(report.fixWithTestRatio).toBe(0.5);
    expect(report.totalCount).toBe(4);
    expect(report.allWithTestCount).toBe(2);
    expect(report.allWithTestRatio).toBe(0.5);
  });

  it("excludes skipped PRs from denominator", () => {
    const classified = [
      { number: 1, title: "fix: a", isFix: true, touchesTests: true, isSkipped: false },
      {
        number: 2,
        title: "v1.0.0",
        isFix: false,
        touchesTests: false,
        isSkipped: true,
        skipReason: "release/version bump",
      },
    ];
    const report = computeTestRatioReport(classified, 100);
    expect(report.totalCount).toBe(1);
    expect(report.skippedCount).toBe(1);
  });

  it("windowCompleted is true when eligible >= window size", () => {
    const classified = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: "feat: item",
      isFix: false,
      touchesTests: false,
      isSkipped: false,
    }));
    const report = computeTestRatioReport(classified, 100);
    expect(report.windowCompleted).toBe(true);
  });

  it("fixWithTestRatio is 0 when no fix PRs exist", () => {
    const classified = [
      { number: 1, title: "feat: a", isFix: false, touchesTests: true, isSkipped: false },
    ];
    const report = computeTestRatioReport(classified, 100);
    expect(report.fixCount).toBe(0);
    expect(report.fixWithTestRatio).toBe(0);
    expect(report.allWithTestRatio).toBe(1);
  });
});

// ── validateBaseline ─────────────────────────────────────────────────────

describe("validateBaseline", () => {
  it("accepts a well-formed baseline", () => {
    const errs = validateBaseline({
      rollingWindowSize: 100,
      updatedAt: "2026-01-01",
      fixWithTestRatio: 0.72,
      fixCount: 50,
      fixWithTestCount: 36,
      allWithTestRatio: 0.66,
      totalCount: 100,
      allWithTestCount: 66,
    });
    expect(errs).toEqual([]);
  });

  it("rejects non-objects", () => {
    expect(validateBaseline(null)).toContain("baseline must be a JSON object");
    expect(validateBaseline([])).toContain("baseline must be a JSON object");
    expect(validateBaseline("string")).toContain("baseline must be a JSON object");
  });

  it("rejects missing keys", () => {
    const errs = validateBaseline({ fixWithTestRatio: 0.5 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("missing required key"))).toBe(true);
  });

  it("rejects ratio out of range", () => {
    const base = {
      rollingWindowSize: 100,
      updatedAt: "2026-01-01",
      fixWithTestRatio: 1.5,
      fixCount: 10,
      fixWithTestCount: 5,
      allWithTestRatio: 0.5,
      totalCount: 10,
      allWithTestCount: 5,
    };
    const errs = validateBaseline(base);
    expect(errs.some((e) => e.includes("fixWithTestRatio"))).toBe(true);
  });

  it("rejects negative counts", () => {
    const base = {
      rollingWindowSize: 100,
      updatedAt: "2026-01-01",
      fixWithTestRatio: 0.5,
      fixCount: -1,
      fixWithTestCount: 5,
      allWithTestRatio: 0.5,
      totalCount: 10,
      allWithTestCount: 5,
    };
    const errs = validateBaseline(base);
    expect(errs.some((e) => e.includes("fixCount"))).toBe(true);
  });

  it("rejects cross-field inconsistencies", () => {
    const base = {
      rollingWindowSize: 100,
      updatedAt: "2026-01-01",
      fixWithTestRatio: 0.9,
      fixCount: 10,
      fixWithTestCount: 99,
      allWithTestRatio: 0.5,
      totalCount: 10,
      allWithTestCount: 5,
    };
    const errs = validateBaseline(base);
    expect(errs.some((e) => e.includes("fixWithTestCount cannot exceed fixCount"))).toBe(true);
  });

  it("rejects allWithTestCount exceeding totalCount", () => {
    const base = {
      rollingWindowSize: 100,
      updatedAt: "2026-01-01",
      fixWithTestRatio: 0.5,
      fixCount: 10,
      fixWithTestCount: 5,
      allWithTestRatio: 0.9,
      totalCount: 10,
      allWithTestCount: 99,
    };
    const errs = validateBaseline(base);
    expect(errs.some((e) => e.includes("allWithTestCount cannot exceed totalCount"))).toBe(true);
  });
});

// ── compareToBaseline ────────────────────────────────────────────────────

describe("compareToBaseline", () => {
  const baseline = {
    rollingWindowSize: 100,
    updatedAt: "2026-01-01",
    fixWithTestRatio: 0.72,
    fixCount: 50,
    fixWithTestCount: 36,
    allWithTestRatio: 0.66,
    totalCount: 100,
    allWithTestCount: 66,
  };

  it("passes when ratios match", () => {
    const current = {
      fixWithTestRatio: 0.72,
      fixCount: 50,
      fixWithTestCount: 36,
      allWithTestRatio: 0.66,
      totalCount: 100,
      allWithTestCount: 66,
      rollingWindowSize: 100,
      windowCompleted: true,
      skippedCount: 0,
    };
    const r = compareToBaseline(current, baseline);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails when fixWithTestRatio drops", () => {
    const current = {
      fixWithTestRatio: 0.6,
      fixCount: 50,
      fixWithTestCount: 30,
      allWithTestRatio: 0.66,
      totalCount: 100,
      allWithTestCount: 66,
      rollingWindowSize: 100,
      windowCompleted: true,
      skippedCount: 0,
    };
    const r = compareToBaseline(current, baseline);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe("fix-with-test-regression");
  });

  it("fails when allWithTestRatio drops", () => {
    const current = {
      fixWithTestRatio: 0.72,
      fixCount: 50,
      fixWithTestCount: 36,
      allWithTestRatio: 0.55,
      totalCount: 100,
      allWithTestCount: 55,
      rollingWindowSize: 100,
      windowCompleted: true,
      skippedCount: 0,
    };
    const r = compareToBaseline(current, baseline);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe("all-with-test-regression");
  });

  it("reports both error kinds when both ratios drop", () => {
    const current = {
      fixWithTestRatio: 0.6,
      fixCount: 50,
      fixWithTestCount: 30,
      allWithTestRatio: 0.55,
      totalCount: 100,
      allWithTestCount: 55,
      rollingWindowSize: 100,
      windowCompleted: true,
      skippedCount: 0,
    };
    const r = compareToBaseline(current, baseline);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
    const kinds = r.errors.map((e) => e.kind).sort();
    expect(kinds).toEqual(["all-with-test-regression", "fix-with-test-regression"]);
  });

  it("emits notices for improvements", () => {
    const current = {
      fixWithTestRatio: 0.8,
      fixCount: 50,
      fixWithTestCount: 40,
      allWithTestRatio: 0.7,
      totalCount: 100,
      allWithTestCount: 70,
      rollingWindowSize: 100,
      windowCompleted: true,
      skippedCount: 0,
    };
    const r = compareToBaseline(current, baseline);
    expect(r.ok).toBe(true);
    const kinds = r.notices.map((n) => n.kind).sort();
    expect(kinds).toEqual(["all-with-test-improvement", "fix-with-test-improvement"]);
  });

  it("emits notice on window size change", () => {
    const current = {
      fixWithTestRatio: 0.72,
      fixCount: 30,
      fixWithTestCount: 22,
      allWithTestRatio: 0.66,
      totalCount: 50,
      allWithTestCount: 33,
      rollingWindowSize: 50,
      windowCompleted: true,
      skippedCount: 0,
    };
    const r = compareToBaseline(current, baseline);
    expect(r.notices.some((n) => n.kind === "window-size-change")).toBe(true);
  });
});

// ── formatBaseline ───────────────────────────────────────────────────────

describe("formatBaseline", () => {
  it("sorts keys in deterministic order", () => {
    const result = formatBaseline({
      allWithTestCount: 66,
      totalCount: 100,
      fixCount: 50,
      allWithTestRatio: 0.66,
      fixWithTestRatio: 0.72,
      updatedAt: "2026-01-01",
      fixWithTestCount: 36,
      rollingWindowSize: 100,
    });
    expect(Object.keys(result)).toEqual([
      "rollingWindowSize",
      "updatedAt",
      "fixWithTestRatio",
      "fixCount",
      "fixWithTestCount",
      "allWithTestRatio",
      "totalCount",
      "allWithTestCount",
    ]);
  });

  it("omits keys not in the canonical order", () => {
    const result = formatBaseline({
      rollingWindowSize: 100,
      updatedAt: "2026-01-01",
      fixWithTestRatio: 0.72,
      fixCount: 50,
      fixWithTestCount: 36,
      allWithTestRatio: 0.66,
      totalCount: 100,
      allWithTestCount: 66,
      extraField: "should not appear",
    });
    expect(result).not.toHaveProperty("extraField");
  });
});

// ── formatMarkdown ───────────────────────────────────────────────────────

describe("formatMarkdown", () => {
  it("produces a report with all metrics", () => {
    const report = {
      fixWithTestRatio: 0.72,
      fixCount: 50,
      fixWithTestCount: 36,
      allWithTestRatio: 0.66,
      totalCount: 100,
      allWithTestCount: 66,
      rollingWindowSize: 100,
      windowCompleted: true,
      skippedCount: 3,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const md = formatMarkdown(report, null);
    expect(md).toContain("72.0%");
    expect(md).toContain("66.0%");
    expect(md).toContain("36/50");
    expect(md).toContain("66/100");
  });

  it("includes regressions when comparison is provided", () => {
    const comparison = {
      ok: false,
      errors: [{ kind: "fix-with-test-regression", message: "ratio dropped" }],
      notices: [],
    };
    const md = formatMarkdown(
      {
        fixWithTestRatio: 0.5,
        fixCount: 10,
        fixWithTestCount: 5,
        allWithTestRatio: 0.5,
        totalCount: 10,
        allWithTestCount: 5,
        rollingWindowSize: 100,
        windowCompleted: false,
        skippedCount: 0,
        updatedAt: "2026-01-01T00:00:00Z",
      },
      comparison
    );
    expect(md).toContain("Regressions");
    expect(md).toContain("ratio dropped");
  });

  it("includes a warning for incomplete windows", () => {
    const report = {
      fixWithTestRatio: 0.5,
      fixCount: 5,
      fixWithTestCount: 3,
      allWithTestRatio: 0.4,
      totalCount: 10,
      allWithTestCount: 4,
      rollingWindowSize: 100,
      windowCompleted: false,
      skippedCount: 0,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const md = formatMarkdown(report, null);
    expect(md).toContain("incomplete");
  });
});
