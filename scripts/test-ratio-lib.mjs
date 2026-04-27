// Pure helpers for the fix-with-test ratio metric. Split from the CLI so the
// classification, aggregation, and baseline-compare logic can be exercised by
// unit tests without a GitHub token.
//
// Conceptual model:
// - A GraphQL search query fetches the last 100 merged PRs with labels and
//   file lists. This library classifies each PR (fix-prefixed, test-touching,
//   should-skip) and computes two ratios over eligible PRs:
//   1. fixWithTestRatio — % of fix-prefixed PRs that touched a *.test.ts file
//   2. allWithTestRatio  — % of all eligible merged PRs that touched a test file
// - The CLI compares these against a checked-in baseline and emits GitHub
//   workflow annotations. No PR-blocking gate.

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

const FIX_TITLE_RE = /^fix[(:]/i;
const RELEASE_TITLE_RE = /^chore\(release\):/;
const VERSION_TAG_RE = /^v?\d+\.\d+/;

/**
 * True when the PR title starts with `fix:` or `fix(` (Conventional Commits).
 */
export function isFixTitle(title) {
  return FIX_TITLE_RE.test(title);
}

/**
 * True when the PR is a release / version-bump that legitimately needs no
 * test changes.
 */
export function isReleaseOrVersionBump(title) {
  return RELEASE_TITLE_RE.test(title) || VERSION_TAG_RE.test(title);
}

/**
 * True when the PR should be excluded from the metric denominator.
 * Documentation and dependencies PRs are already filtered out by the GraphQL
 * query's `-label:` clauses; the title-based skip catches release/version-bump
 * PRs that don't carry those labels.
 */
export function isEligiblePR(pr) {
  return !isReleaseOrVersionBump(pr.title);
}

/**
 * @typedef {object} ClassifiedPR
 * @property {number} number
 * @property {string} title
 * @property {boolean} isFix
 * @property {boolean} touchesTests
 * @property {boolean} isSkipped
 * @property {string} [skipReason]
 */

/**
 * Classify a single GraphQL PR node.
 * @param {object} pr — GraphQL PullRequest node
 * @returns {ClassifiedPR}
 */
export function classifyPR(pr) {
  const skipped = !isEligiblePR(pr);
  const files = pr.files?.nodes ?? [];
  const touchesTests = files.some((f) => TEST_FILE_RE.test(f.path));

  return {
    number: pr.number,
    title: pr.title,
    isFix: isFixTitle(pr.title),
    touchesTests,
    isSkipped: skipped,
    skipReason: skipped ? "release/version bump" : undefined,
  };
}

/**
 * Aggregate classified PRs into the two ratios.
 *
 * @param {ClassifiedPR[]} classified — output of classifyPR for each PR
 * @param {number} rollingWindowSize — target window size (e.g. 100)
 * @returns {object} report shape
 */
export function computeTestRatioReport(classified, rollingWindowSize) {
  const eligible = classified.filter((p) => !p.isSkipped);
  const fixPRs = eligible.filter((p) => p.isFix);
  const allWithTest = eligible.filter((p) => p.touchesTests);
  const fixWithTest = fixPRs.filter((p) => p.touchesTests);

  return {
    fixWithTestRatio: fixPRs.length > 0 ? fixWithTest.length / fixPRs.length : 0,
    fixCount: fixPRs.length,
    fixWithTestCount: fixWithTest.length,
    allWithTestRatio: eligible.length > 0 ? allWithTest.length / eligible.length : 0,
    totalCount: eligible.length,
    allWithTestCount: allWithTest.length,
    rollingWindowSize,
    windowCompleted: eligible.length >= rollingWindowSize,
    skippedCount: classified.length - eligible.length,
  };
}

const REQUIRED_BASELINE_KEYS = [
  "rollingWindowSize",
  "updatedAt",
  "fixWithTestRatio",
  "fixCount",
  "fixWithTestCount",
  "allWithTestRatio",
  "totalCount",
  "allWithTestCount",
];

/**
 * Validate a baseline object. Returns an array of error strings (empty = valid).
 * @param {object} data
 * @returns {string[]}
 */
export function validateBaseline(data) {
  const errs = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errs.push("baseline must be a JSON object");
    return errs;
  }
  for (const key of REQUIRED_BASELINE_KEYS) {
    if (data[key] === undefined) {
      errs.push(`missing required key: ${key}`);
    }
  }
  if (
    typeof data.rollingWindowSize !== "number" ||
    !Number.isFinite(data.rollingWindowSize) ||
    data.rollingWindowSize <= 0
  ) {
    errs.push("rollingWindowSize must be a positive finite number");
  }
  for (const key of ["fixWithTestRatio", "allWithTestRatio"]) {
    const v = data[key];
    if (typeof v !== "number" || v < 0 || v > 1) {
      errs.push(`${key} must be a number between 0 and 1`);
    }
  }
  for (const key of ["fixCount", "fixWithTestCount", "totalCount", "allWithTestCount"]) {
    const v = data[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      errs.push(`${key} must be a finite non-negative number`);
    }
  }
  // Cross-field consistency — catches manual baselines edits or data corruption.
  if (data.fixWithTestCount > data.fixCount) {
    errs.push("fixWithTestCount cannot exceed fixCount");
  }
  if (data.allWithTestCount > data.totalCount) {
    errs.push("allWithTestCount cannot exceed totalCount");
  }
  return errs;
}

/**
 * Compare current report against baseline. Returns structured result the CLI
 * can turn into GitHub workflow annotations.
 *
 * @param {object} current — output of computeTestRatioReport
 * @param {object} baseline — parsed test-ratio-baseline.json
 * @returns {{ ok: boolean, errors: {kind: string, message: string}[], notices: {kind: string, message: string}[] }}
 */
export function compareToBaseline(current, baseline) {
  const errors = [];
  const notices = [];

  const pct = (ratio) => (ratio * 100).toFixed(1);

  if (current.fixWithTestRatio < baseline.fixWithTestRatio) {
    errors.push({
      kind: "fix-with-test-regression",
      message: `fix-with-test ratio dropped from ${pct(baseline.fixWithTestRatio)}% to ${pct(current.fixWithTestRatio)}% (${current.fixWithTestCount}/${current.fixCount} fix PRs touched tests vs baseline ${baseline.fixWithTestCount}/${baseline.fixCount}).`,
    });
  } else if (current.fixWithTestRatio > baseline.fixWithTestRatio) {
    notices.push({
      kind: "fix-with-test-improvement",
      message: `fix-with-test ratio improved from ${pct(baseline.fixWithTestRatio)}% to ${pct(current.fixWithTestRatio)}% — consider \`npm run test-ratio:update\` to lock it in.`,
    });
  }

  if (current.allWithTestRatio < baseline.allWithTestRatio) {
    errors.push({
      kind: "all-with-test-regression",
      message: `all-with-test ratio dropped from ${pct(baseline.allWithTestRatio)}% to ${pct(current.allWithTestRatio)}% (${current.allWithTestCount}/${current.totalCount} PRs touched tests vs baseline ${baseline.allWithTestCount}/${baseline.totalCount}).`,
    });
  } else if (current.allWithTestRatio > baseline.allWithTestRatio) {
    notices.push({
      kind: "all-with-test-improvement",
      message: `all-with-test ratio improved from ${pct(baseline.allWithTestRatio)}% to ${pct(current.allWithTestRatio)}% — consider \`npm run test-ratio:update\` to lock it in.`,
    });
  }

  const baselineWindow = baseline.rollingWindowSize || current.rollingWindowSize;
  if (current.rollingWindowSize !== baselineWindow) {
    notices.push({
      kind: "window-size-change",
      message: `rolling window size changed from ${baselineWindow} to ${current.rollingWindowSize}.`,
    });
  }

  return { ok: errors.length === 0, errors, notices };
}

/**
 * Sort the window so every key appears in a deterministic position in the
 * checked-in file — this keeps git diffs clean.
 */
const KEY_ORDER = [
  "rollingWindowSize",
  "updatedAt",
  "fixWithTestRatio",
  "fixCount",
  "fixWithTestCount",
  "allWithTestRatio",
  "totalCount",
  "allWithTestCount",
];

/**
 * Deterministic serializer for the baseline file.
 * @param {object} report
 * @returns {object}
 */
export function formatBaseline(report) {
  const sorted = {};
  for (const key of KEY_ORDER) {
    if (key in report) sorted[key] = report[key];
  }
  return sorted;
}

/**
 * Format a markdown summary suitable for `dist/test-ratio-summary.md`.
 * @param {object} report — output of computeTestRatioReport
 * @param {object} comparison — output of compareToBaseline (or null for first run)
 * @returns {string}
 */
export function formatMarkdown(report, comparison) {
  const pct = (ratio) => (ratio * 100).toFixed(1);
  const lines = [
    `# Test Ratio Report — ${report.updatedAt ?? new Date().toISOString()}`,
    "",
    `| Metric | Value |`,
    `| ------ | ----- |`,
    `| Rolling window | ${report.rollingWindowSize} PRs (${report.windowCompleted ? "complete" : report.totalCount + " eligible"}) |`,
    `| Fix-with-test ratio | ${pct(report.fixWithTestRatio)}% (${report.fixWithTestCount}/${report.fixCount}) |`,
    `| All-with-test ratio | ${pct(report.allWithTestRatio)}% (${report.allWithTestCount}/${report.totalCount}) |`,
    `| Skipped PRs | ${report.skippedCount} |`,
    "",
  ];

  if (comparison) {
    if (comparison.errors.length > 0) {
      lines.push("## Regressions", "");
      for (const e of comparison.errors) {
        lines.push(`- **${e.kind}**: ${e.message}`);
      }
      lines.push("");
    }
    if (comparison.notices.length > 0) {
      lines.push("## Notices", "");
      for (const n of comparison.notices) {
        lines.push(`- ${n.kind}: ${n.message}`);
      }
      lines.push("");
    }
  }

  if (!report.windowCompleted) {
    lines.push(
      "> **Note:** Fewer than the target number of eligible PRs were available. The window may be incomplete.",
      ""
    );
  }

  return lines.join("\n");
}
