#!/usr/bin/env node

// Linked-issue gate for the budget override labels. Each budget category has a
// dedicated `*-override` label that lets a PR intentionally accept a regression
// instead of refreshing the baseline. To keep that escape hatch auditable, this
// gate fails CI when any override label is applied without a tracking issue
// referenced in the PR body (`Fixes #N` / `Resolves #N` / `Closes #N`).
//
// Reads the PR body and label names from the environment (injected by the CI
// workflow) rather than the shell, so PR-body metacharacters never reach a
// command line:
//   PR_BODY   — github.event.pull_request.body
//   PR_LABELS — toJson(github.event.pull_request.labels.*.name) (a JSON array)
//
// When PR_BODY is unset (push / workflow_dispatch — no PR context) the gate
// skips cleanly, since there's no body to validate. Mirrors the standalone
// ESM ratchet style of lint-ratchet.mjs / ipc-handwritten-ratchet.mjs.
//
// Usage (CI only):
//   PR_BODY="$BODY" PR_LABELS='["renderer-bundle-override"]' \
//     node scripts/check-budget-override-gate.mjs

import { pathToFileURL } from "node:url";

// One label per budget category. The slug matches the npm `*:check` script name
// (renderer-bundle-budget:check → renderer-bundle-override) so the label-to-gate
// mapping is grep-able. Only renderer-bundle and first-render-chunk have a
// regression path wired today; the rest are reserved so the gate stays uniform
// as the remaining budgets gain override support.
export const BUDGET_OVERRIDE_LABELS = [
  "renderer-bundle-override",
  "first-render-chunk-override",
  "compiler-budget-override",
  "import-budget-override",
  "renderer-import-budget-override",
];

// Matches a GitHub closing keyword followed by an issue number anywhere in the
// body. Deliberately narrow: only `fixes`/`resolves`/`closes` (the keywords the
// issue spec names) and a bare `#N` — `Fixed #1`, `see #1`, or `#abc` don't
// count, so the reference is an explicit, intentional link.
const ISSUE_REF_RE = /\b(?:fixes|resolves|closes)\s+#\d+\b/i;

export function hasLinkedIssueReference(body) {
  if (typeof body !== "string") return false;
  return ISSUE_REF_RE.test(body);
}

// Parse the JSON array of label names. toJson() on an empty label set yields
// "[]"; an empty/absent label field can surface as the string "null". Anything
// that isn't a JSON array of strings — non-JSON, a non-array, or an array with
// a non-string member — returns { error } so the caller fails closed rather
// than silently waving the gate through. The non-string-member guard matters
// if the workflow expression ever drifts from `labels.*.name` (string names) to
// the full label-object array: that would otherwise parse to [] and pass.
export function parseLabels(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `PR_LABELS is not valid JSON: ${raw}` };
  }
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) {
    return { error: `PR_LABELS is not a JSON array: ${raw}` };
  }
  if (!parsed.every((l) => typeof l === "string")) {
    return { error: `PR_LABELS is not an array of strings: ${raw}` };
  }
  return parsed;
}

// Pure gate decision. Returns { skipped } when there's no PR context, otherwise
// { ok, matchedLabels } — ok is false only when an override label is present
// without a linked issue. `parseError` fails closed.
export function validateBudgetOverrideGate({ body, labels }) {
  if (body === undefined || body === null) return { skipped: true };

  const parsed = parseLabels(labels);
  if (parsed && parsed.error) return { ok: false, parseError: parsed.error };

  const matchedLabels = BUDGET_OVERRIDE_LABELS.filter((l) => parsed.includes(l));
  if (matchedLabels.length === 0) return { ok: true, matchedLabels };

  return { ok: hasLinkedIssueReference(body), matchedLabels };
}

function main() {
  const result = validateBudgetOverrideGate({
    body: process.env.PR_BODY,
    labels: process.env.PR_LABELS,
  });

  if (result.skipped) {
    console.log("[check-budget-override-gate] no PR context — skipping.");
    return;
  }

  if (result.parseError) {
    console.error(`::error::${result.parseError}`);
    process.exit(1);
  }

  if (result.matchedLabels.length === 0) {
    console.log("[check-budget-override-gate] OK — no budget override labels applied.");
    return;
  }

  if (result.ok) {
    console.log(
      `[check-budget-override-gate] OK — override label(s) ${result.matchedLabels.join(", ")} backed by a linked issue.`
    );
    return;
  }

  console.error(
    `::error::Budget override label(s) ${result.matchedLabels.join(", ")} require a tracking issue. ` +
      "Add `Fixes #N`, `Resolves #N`, or `Closes #N` to the PR body, or remove the label and refresh the baseline instead."
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
