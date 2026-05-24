import { describe, it, expect } from "vitest";
import { LintRules } from "babel-plugin-react-compiler";

// Tests the pure logic introduced in #7454 — capturing compiler bailout
// reasons and categories — plus the severity-aware ratchet from #8892. Mirrors
// the lint-ratchet.test.mjs pattern: extract the logic under test inline, no
// shell-out, no script import.

// ── Severity-aware mirrors (#8892) ───────────────────────────────────────────
// Mirror the SEVERITY_BY_CATEGORY / severityForCategory / getHintCount /
// getStrictBailouts helpers from check-compiler-budget.mjs (and the matching
// severityForCategory in vite.config.ts).
const SEVERITY_BY_CATEGORY = Object.fromEntries(LintRules.map((r) => [r.category, r.severity]));
const HINT_CATEGORIES = new Set(
  LintRules.filter((r) => r.severity === "Hint").map((r) => r.category)
);

function severityForCategory(category) {
  return SEVERITY_BY_CATEGORY[category] ?? "Error";
}

function getHintCount(entry) {
  return typeof entry?.hintCount === "number" && Number.isFinite(entry.hintCount)
    ? entry.hintCount
    : 0;
}

function getStrictBailouts(entry) {
  return Array.isArray(entry?.errorBailouts)
    ? entry.errorBailouts.filter(
        (b) => b && typeof b === "object" && !HINT_CATEGORIES.has(b.category)
      )
    : [];
}

// Mirror the per-file regression decision: returns the delta keys that would
// fail CI for a single file given its baseline (or null baseline = new file).
function fileRegressionKeys(entry, base) {
  const REGRESSION_KEYS = ["skip", "pipeline"];
  const strictCount = getStrictBailouts(entry).length;
  if (!base) {
    const keys = REGRESSION_KEYS.filter((k) => entry[k] > 0);
    if (strictCount > 0) keys.push("strictErrors");
    return keys;
  }
  const keys = REGRESSION_KEYS.filter((k) => entry[k] > base[k]);
  if (strictCount > getStrictBailouts(base).length) keys.push("strictErrors");
  return keys;
}

// Mirror the global Hint budget gate: report total may not exceed baseline.
function hintBudgetExceeded(report, baseline) {
  const reportTotal = Object.values(report).reduce((s, e) => s + getHintCount(e), 0);
  const baselineTotal = Object.values(baseline).reduce((s, e) => s + getHintCount(e), 0);
  return reportTotal > baselineTotal;
}

/**
 * Mirrors `summarizePipelineError` in vite.config.ts. Trims to first line,
 * caps at 200 chars, tolerates null/undefined.
 */
function summarizePipelineError(data) {
  return String(data ?? "")
    .split(/\r?\n/)[0]
    .slice(0, 200);
}

/**
 * Mirrors the writeBaseline reconstruction in check-compiler-budget.mjs.
 * Explicit field list (not spread) — prevents unintended propagation of
 * future report fields into the baseline.
 */
function reconstructBaselineEntry(e) {
  return {
    success: e.success,
    skip: e.skip,
    error: e.error,
    pipeline: e.pipeline,
    hintCount: getHintCount(e),
    errorBailouts: Array.isArray(e.errorBailouts) ? e.errorBailouts : [],
    skipReasons: Array.isArray(e.skipReasons) ? e.skipReasons : [],
    pipelineErrors: Array.isArray(e.pipelineErrors) ? e.pipelineErrors : [],
  };
}

/**
 * Mirrors the validateShape COUNT_KEYS check — extra fields are tolerated;
 * only the four counts must be present and valid non-negative finite numbers.
 * hintCount is optional (legacy baselines lack it) but, when present, must be
 * a valid non-negative finite number.
 */
const COUNT_KEYS = ["success", "skip", "error", "pipeline"];
function entryShapeError(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "not-object";
  for (const key of COUNT_KEYS) {
    const v = entry[key];
    if (typeof v !== "number" || v < 0 || !Number.isFinite(v)) return `invalid-${key}`;
  }
  if (
    "hintCount" in entry &&
    (typeof entry.hintCount !== "number" ||
      entry.hintCount < 0 ||
      !Number.isFinite(entry.hintCount))
  ) {
    return "invalid-hintCount";
  }
  return null;
}

/**
 * Mirrors the regression-display formatting in check-compiler-budget.mjs.
 * Returns the lines that would be written to stderr after the ::error
 * header, in order. Used to verify (a) errorBailouts grouping/null
 * tolerance, and (b) skipReasons deduplication semantics.
 */
function formatDiagnostics(entry) {
  const lines = [];
  const errorBailouts = Array.isArray(entry?.errorBailouts) ? entry.errorBailouts : [];
  const skipReasons = Array.isArray(entry?.skipReasons) ? entry.skipReasons : [];
  const pipelineErrors = Array.isArray(entry?.pipelineErrors) ? entry.pipelineErrors : [];
  if (errorBailouts.length > 0) {
    const grouped = new Map();
    for (const item of errorBailouts) {
      if (!item || typeof item !== "object") continue;
      const key = item.category || "(unknown)";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item.reason);
    }
    for (const [category, reasons] of grouped) {
      const sample = reasons[0];
      const more = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : "";
      lines.push(`   error[${category}]: ${sample}${more}`);
    }
  }
  if (skipReasons.length > 0) {
    const unique = [...new Set(skipReasons)];
    const sample = unique[0];
    const more = unique.length > 1 ? ` (+${unique.length - 1} more)` : "";
    lines.push(`   skip: ${sample}${more}`);
  }
  if (pipelineErrors.length > 0) {
    lines.push(`   pipeline: ${pipelineErrors[0]}`);
  }
  return lines;
}

describe("summarizePipelineError", () => {
  it("returns empty string for null", () => {
    expect(summarizePipelineError(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(summarizePipelineError(undefined)).toBe("");
  });

  it("returns the input unchanged for short single-line input", () => {
    expect(summarizePipelineError("boom")).toBe("boom");
  });

  it("strips everything after the first newline (LF)", () => {
    expect(summarizePipelineError("ValidationError: foo\n  at bar (baz.ts:1:2)")).toBe(
      "ValidationError: foo"
    );
  });

  it("strips everything after the first newline (CRLF)", () => {
    expect(summarizePipelineError("ValidationError: foo\r\n  at bar")).toBe("ValidationError: foo");
  });

  it("caps single-line input at 200 characters", () => {
    const long = "x".repeat(500);
    const result = summarizePipelineError(long);
    expect(result.length).toBe(200);
    expect(result).toBe("x".repeat(200));
  });

  it("caps the first line, ignoring later lines, at 200 chars", () => {
    const first = "y".repeat(300);
    const input = `${first}\nsecond line`;
    const result = summarizePipelineError(input);
    expect(result.length).toBe(200);
    expect(result).toBe("y".repeat(200));
  });

  it("coerces non-string inputs via String()", () => {
    expect(summarizePipelineError(42)).toBe("42");
  });
});

describe("writeBaseline reconstruction", () => {
  it("preserves all four count keys", () => {
    const result = reconstructBaselineEntry({
      success: 3,
      skip: 1,
      error: 2,
      pipeline: 0,
    });
    expect(result.success).toBe(3);
    expect(result.skip).toBe(1);
    expect(result.error).toBe(2);
    expect(result.pipeline).toBe(0);
  });

  it("preserves diagnostic arrays from the report", () => {
    const result = reconstructBaselineEntry({
      success: 0,
      skip: 1,
      error: 1,
      pipeline: 1,
      errorBailouts: [{ category: "Hooks", reason: "called conditionally" }],
      skipReasons: ["Skipped due to 'use no memo' directive."],
      pipelineErrors: ["Internal error: boom"],
    });
    expect(result.errorBailouts).toEqual([{ category: "Hooks", reason: "called conditionally" }]);
    expect(result.skipReasons).toEqual(["Skipped due to 'use no memo' directive."]);
    expect(result.pipelineErrors).toEqual(["Internal error: boom"]);
  });

  it("defaults missing diagnostic arrays to [] (legacy report)", () => {
    const result = reconstructBaselineEntry({ success: 1, skip: 0, error: 0, pipeline: 0 });
    expect(result.errorBailouts).toEqual([]);
    expect(result.skipReasons).toEqual([]);
    expect(result.pipelineErrors).toEqual([]);
  });

  it("coerces non-array diagnostic fields to [] (defense in depth)", () => {
    const result = reconstructBaselineEntry({
      success: 1,
      skip: 0,
      error: 0,
      pipeline: 0,
      errorBailouts: "not an array",
      skipReasons: null,
      pipelineErrors: undefined,
    });
    expect(result.errorBailouts).toEqual([]);
    expect(result.skipReasons).toEqual([]);
    expect(result.pipelineErrors).toEqual([]);
  });

  it("does not propagate unknown report fields into the baseline", () => {
    const result = reconstructBaselineEntry({
      success: 1,
      skip: 0,
      error: 0,
      pipeline: 0,
      futureField: "should not appear",
    });
    expect(Object.prototype.hasOwnProperty.call(result, "futureField")).toBe(false);
  });
});

describe("validateShape tolerance", () => {
  it("accepts an entry with only the four count keys", () => {
    expect(entryShapeError({ success: 1, skip: 0, error: 0, pipeline: 0 })).toBeNull();
  });

  it("accepts an entry with the new diagnostic arrays alongside counts", () => {
    expect(
      entryShapeError({
        success: 1,
        skip: 1,
        error: 1,
        pipeline: 0,
        errorBailouts: [{ category: "Refs", reason: "x" }],
        skipReasons: ["y"],
        pipelineErrors: [],
      })
    ).toBeNull();
  });

  it("rejects an entry missing a count key", () => {
    expect(entryShapeError({ success: 1, skip: 0, error: 0 })).toBe("invalid-pipeline");
  });

  it("rejects negative counts", () => {
    expect(entryShapeError({ success: -1, skip: 0, error: 0, pipeline: 0 })).toBe(
      "invalid-success"
    );
  });

  it("rejects non-numeric counts", () => {
    expect(entryShapeError({ success: "1", skip: 0, error: 0, pipeline: 0 })).toBe(
      "invalid-success"
    );
  });

  it("rejects Infinity counts", () => {
    expect(entryShapeError({ success: Infinity, skip: 0, error: 0, pipeline: 0 })).toBe(
      "invalid-success"
    );
  });
});

describe("regression diagnostic display", () => {
  it("returns no lines when all diagnostic arrays are empty", () => {
    expect(formatDiagnostics({ errorBailouts: [], skipReasons: [], pipelineErrors: [] })).toEqual(
      []
    );
  });

  it("returns no lines when entry is missing or arrays are absent", () => {
    expect(formatDiagnostics(undefined)).toEqual([]);
    expect(formatDiagnostics({})).toEqual([]);
  });

  it("groups multiple errorBailouts by category", () => {
    const lines = formatDiagnostics({
      errorBailouts: [
        { category: "Todo", reason: "first todo" },
        { category: "Todo", reason: "second todo" },
        { category: "Refs", reason: "ref problem" },
      ],
    });
    expect(lines).toEqual(["   error[Todo]: first todo (+1 more)", "   error[Refs]: ref problem"]);
  });

  it("falls back to (unknown) category for empty-string category", () => {
    const lines = formatDiagnostics({
      errorBailouts: [{ category: "", reason: "missing category" }],
    });
    expect(lines).toEqual(["   error[(unknown)]: missing category"]);
  });

  it("skips null/non-object errorBailouts elements without crashing", () => {
    const lines = formatDiagnostics({
      errorBailouts: [null, { category: "Hooks", reason: "real" }, "string-junk", 42],
    });
    expect(lines).toEqual(["   error[Hooks]: real"]);
  });

  it("dedupes skipReasons and reports unique-count, not raw-count", () => {
    // Two distinct reasons → "(+1 more)", not "(×2)" which would be
    // misleading (it would imply the same reason occurred twice).
    const lines = formatDiagnostics({
      skipReasons: ["reason A", "reason B"],
    });
    expect(lines).toEqual(["   skip: reason A (+1 more)"]);
  });

  it("collapses repeated identical skipReasons to the single entry with no suffix", () => {
    const lines = formatDiagnostics({
      skipReasons: ["only reason", "only reason", "only reason"],
    });
    expect(lines).toEqual(["   skip: only reason"]);
  });

  it("shows only the first pipelineError summary", () => {
    const lines = formatDiagnostics({
      pipelineErrors: ["first error: boom", "second error: kaboom"],
    });
    expect(lines).toEqual(["   pipeline: first error: boom"]);
  });

  it("emits all three sections in order when all are populated", () => {
    const lines = formatDiagnostics({
      errorBailouts: [{ category: "Refs", reason: "r" }],
      skipReasons: ["s"],
      pipelineErrors: ["p"],
    });
    expect(lines).toEqual(["   error[Refs]: r", "   skip: s", "   pipeline: p"]);
  });
});

describe("severity bucketing (#8892)", () => {
  it("derives severity from the live LintRules registry", () => {
    // Cosmetic try/catch lowering noise — the category that dominated the
    // pre-#8892 baseline.
    expect(severityForCategory("Todo")).toBe("Hint");
    // Rule-of-React violations — the load-bearing ones.
    expect(severityForCategory("Hooks")).toBe("Error");
    expect(severityForCategory("Refs")).toBe("Error");
    // Warnings fold into the strict gate (treated like Error).
    expect(severityForCategory("IncompatibleLibrary")).toBe("Warning");
    expect(severityForCategory("UnsupportedSyntax")).toBe("Warning");
  });

  it("defaults unknown/future categories to Error (fail loud, never silently Hint)", () => {
    expect(severityForCategory("SomeFutureCategoryNotInRegistry")).toBe("Error");
    expect(severityForCategory("")).toBe("Error");
  });

  it("classifies exactly one Hint category (Todo)", () => {
    expect([...HINT_CATEGORIES]).toEqual(["Todo"]);
  });
});

describe("getHintCount (#8892)", () => {
  it("reads an explicit hintCount", () => {
    expect(getHintCount({ hintCount: 7 })).toBe(7);
  });

  it("defaults missing hintCount to 0 (legacy baseline)", () => {
    expect(getHintCount({ success: 1, skip: 0, error: 0, pipeline: 0 })).toBe(0);
    expect(getHintCount(undefined)).toBe(0);
  });

  it("treats non-numeric / non-finite hintCount as 0", () => {
    expect(getHintCount({ hintCount: "9" })).toBe(0);
    expect(getHintCount({ hintCount: Infinity })).toBe(0);
    expect(getHintCount({ hintCount: NaN })).toBe(0);
  });
});

describe("getStrictBailouts (#8892)", () => {
  it("returns Error and Warning entries verbatim", () => {
    const entry = {
      errorBailouts: [
        { category: "Refs", severity: "Error", reason: "r" },
        { category: "IncompatibleLibrary", severity: "Warning", reason: "w" },
      ],
    };
    expect(getStrictBailouts(entry)).toHaveLength(2);
  });

  it("strips Hint (Todo) entries from a legacy baseline that lumped them in", () => {
    // Pre-#8892 baselines stored Todo verbatim in errorBailouts. The strict
    // gate must ignore them so it stays honest against old baselines.
    const entry = {
      errorBailouts: [
        { category: "Todo", reason: "cosmetic" },
        { category: "Todo", reason: "cosmetic" },
        { category: "Hooks", reason: "real" },
      ],
    };
    expect(getStrictBailouts(entry).map((b) => b.category)).toEqual(["Hooks"]);
  });

  it("tolerates a missing or malformed errorBailouts array", () => {
    expect(getStrictBailouts({})).toEqual([]);
    expect(getStrictBailouts({ errorBailouts: "nope" })).toEqual([]);
    expect(getStrictBailouts({ errorBailouts: [null, 42, "x"] })).toEqual([]);
  });
});

describe("strict Error per-file gate (#8892)", () => {
  it("fails a new file that introduces a strict bailout", () => {
    const entry = {
      skip: 0,
      pipeline: 0,
      hintCount: 0,
      errorBailouts: [{ category: "Hooks", severity: "Error", reason: "x" }],
    };
    expect(fileRegressionKeys(entry, null)).toContain("strictErrors");
  });

  it("passes a new file with only Hint noise (Hints gate globally, not per-file)", () => {
    const entry = { skip: 0, pipeline: 0, hintCount: 12, errorBailouts: [] };
    expect(fileRegressionKeys(entry, null)).toEqual([]);
  });

  it("fails when a file's strict bailout count increases against baseline", () => {
    const base = { skip: 0, pipeline: 0, hintCount: 0, errorBailouts: [] };
    const entry = {
      skip: 0,
      pipeline: 0,
      hintCount: 0,
      errorBailouts: [{ category: "Refs", severity: "Error", reason: "x" }],
    };
    expect(fileRegressionKeys(entry, base)).toEqual(["strictErrors"]);
  });

  it("passes when a file's strict count is unchanged but Hint count grows", () => {
    const base = {
      skip: 0,
      pipeline: 0,
      hintCount: 2,
      errorBailouts: [{ category: "Refs", severity: "Error", reason: "x" }],
    };
    const entry = {
      skip: 0,
      pipeline: 0,
      hintCount: 5,
      errorBailouts: [{ category: "Refs", severity: "Error", reason: "x" }],
    };
    expect(fileRegressionKeys(entry, base)).toEqual([]);
  });

  it("does NOT gate on the raw error count (Hint-only error inflation is allowed)", () => {
    // error went 0 → 6 but it's all Hint noise — no strict bailouts, so no
    // per-file failure. This is the core #8892 behavior change.
    const base = { skip: 0, pipeline: 0, error: 0, hintCount: 0, errorBailouts: [] };
    const entry = { skip: 0, pipeline: 0, error: 6, hintCount: 6, errorBailouts: [] };
    expect(fileRegressionKeys(entry, base)).toEqual([]);
  });
});

describe("global Hint budget gate (#8892)", () => {
  it("fails when the whole-repo Hint total grows", () => {
    const baseline = { "a.tsx": { hintCount: 3 }, "b.tsx": { hintCount: 2 } };
    const report = { "a.tsx": { hintCount: 3 }, "b.tsx": { hintCount: 4 } };
    expect(hintBudgetExceeded(report, baseline)).toBe(true);
  });

  it("passes when Hint noise shifts between files but the total is unchanged", () => {
    const baseline = { "a.tsx": { hintCount: 3 }, "b.tsx": { hintCount: 2 } };
    const report = { "a.tsx": { hintCount: 1 }, "b.tsx": { hintCount: 4 } };
    expect(hintBudgetExceeded(report, baseline)).toBe(false);
  });

  it("passes when the total drops (improvement)", () => {
    const baseline = { "a.tsx": { hintCount: 3 }, "b.tsx": { hintCount: 2 } };
    const report = { "a.tsx": { hintCount: 1 }, "b.tsx": { hintCount: 1 } };
    expect(hintBudgetExceeded(report, baseline)).toBe(false);
  });
});
