import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  BUDGET_OVERRIDE_LABELS,
  hasLinkedIssueReference,
  parseLabels,
  validateBudgetOverrideGate,
} from "./check-budget-override-gate.mjs";

const GATE_SCRIPT = fileURLToPath(new URL("./check-budget-override-gate.mjs", import.meta.url));

function runGate(env) {
  return spawnSync(process.execPath, [GATE_SCRIPT], {
    encoding: "utf8",
    // Clear PR_* from the ambient env so the test controls them fully.
    env: { ...process.env, PR_BODY: undefined, PR_LABELS: undefined, ...env },
  });
}

describe("hasLinkedIssueReference", () => {
  it.each(["Fixes #123", "resolves #1", "CLOSES #42", "see also Fixes #7 thanks"])(
    "accepts %j",
    (body) => {
      expect(hasLinkedIssueReference(body)).toBe(true);
    }
  );

  it.each([
    "Fixed #123",
    "fix #123",
    "Fixes #abc",
    "bare #123",
    "fixes#123",
    "fixes 123",
    "Fixes daintreehq/daintree#123",
  ])("rejects %j", (body) => {
    expect(hasLinkedIssueReference(body)).toBe(false);
  });

  it("rejects non-string bodies", () => {
    expect(hasLinkedIssueReference(undefined)).toBe(false);
    expect(hasLinkedIssueReference(null)).toBe(false);
    expect(hasLinkedIssueReference("")).toBe(false);
  });
});

describe("parseLabels", () => {
  it("returns [] for empty / null / undefined input", () => {
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels(null)).toEqual([]);
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels("[]")).toEqual([]);
    expect(parseLabels("null")).toEqual([]);
  });

  it("parses a JSON array of label names", () => {
    expect(parseLabels('["renderer-bundle-override","enhancement"]')).toEqual([
      "renderer-bundle-override",
      "enhancement",
    ]);
  });

  it("fails closed on a non-string array member (expression drift guard)", () => {
    const result = parseLabels('["a",1,null,"b"]');
    expect(result.error).toMatch(/not an array of strings/);
  });

  it("fails closed on an array of label objects", () => {
    const result = parseLabels('[{"name":"renderer-bundle-override"}]');
    expect(result.error).toMatch(/not an array of strings/);
  });

  it("fails closed on malformed JSON", () => {
    const result = parseLabels("[not json");
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("fails closed on non-array JSON", () => {
    const result = parseLabels('{"name":"x"}');
    expect(result.error).toMatch(/not a JSON array/);
  });
});

describe("validateBudgetOverrideGate", () => {
  it("skips when there is no PR body (push / workflow_dispatch)", () => {
    expect(validateBudgetOverrideGate({ body: undefined, labels: "[]" })).toEqual({
      skipped: true,
    });
    expect(validateBudgetOverrideGate({ body: null, labels: undefined })).toEqual({
      skipped: true,
    });
  });

  it("passes when no override labels are applied, regardless of body", () => {
    const result = validateBudgetOverrideGate({
      body: "no issue reference here",
      labels: '["enhancement","infrastructure"]',
    });
    expect(result).toEqual({ ok: true, matchedLabels: [] });
  });

  it("passes when an override label is backed by a linked issue", () => {
    const result = validateBudgetOverrideGate({
      body: "Intentional growth. Fixes #8902",
      labels: '["renderer-bundle-override"]',
    });
    expect(result.ok).toBe(true);
    expect(result.matchedLabels).toEqual(["renderer-bundle-override"]);
  });

  it("fails when an override label has no linked issue", () => {
    const result = validateBudgetOverrideGate({
      body: "just bumping the budget",
      labels: '["first-render-chunk-override"]',
    });
    expect(result.ok).toBe(false);
    expect(result.matchedLabels).toEqual(["first-render-chunk-override"]);
  });

  it("fails when body is an empty string and an override label is present", () => {
    const result = validateBudgetOverrideGate({
      body: "",
      labels: '["compiler-budget-override"]',
    });
    expect(result.ok).toBe(false);
    expect(result.matchedLabels).toEqual(["compiler-budget-override"]);
  });

  it.each(BUDGET_OVERRIDE_LABELS)("recognizes each override label: %s", (label) => {
    const failing = validateBudgetOverrideGate({ body: "nope", labels: JSON.stringify([label]) });
    expect(failing.ok).toBe(false);
    expect(failing.matchedLabels).toEqual([label]);

    const passing = validateBudgetOverrideGate({
      body: "Closes #1",
      labels: JSON.stringify([label]),
    });
    expect(passing.ok).toBe(true);
  });

  it("reports all matched override labels when multiple are applied", () => {
    const result = validateBudgetOverrideGate({
      body: "no link",
      labels: '["renderer-bundle-override","first-render-chunk-override","enhancement"]',
    });
    expect(result.ok).toBe(false);
    expect(result.matchedLabels).toEqual([
      "renderer-bundle-override",
      "first-render-chunk-override",
    ]);
  });

  it("fails closed when PR_LABELS is malformed JSON", () => {
    const result = validateBudgetOverrideGate({ body: "Fixes #1", labels: "[broken" });
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/not valid JSON/);
  });
});

describe("CLI (main)", () => {
  it("exits 0 and skips when PR_BODY is unset (non-PR context)", () => {
    const r = runGate({ PR_LABELS: '["renderer-bundle-override"]' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no PR context/);
  });

  it("exits 0 when no override labels are applied", () => {
    const r = runGate({ PR_BODY: "no link here", PR_LABELS: '["enhancement"]' });
    expect(r.status).toBe(0);
  });

  it("exits 1 with an annotation when an override label lacks a linked issue", () => {
    const r = runGate({ PR_BODY: "just bumping it", PR_LABELS: '["renderer-bundle-override"]' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::/);
    expect(r.stderr).toMatch(/renderer-bundle-override/);
  });

  it("exits 1 for an empty-string body with an override label (not coerced to skip)", () => {
    const r = runGate({ PR_BODY: "", PR_LABELS: '["first-render-chunk-override"]' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::/);
  });

  it("exits 0 when the override label is backed by a linked issue", () => {
    const r = runGate({ PR_BODY: "Fixes #8902", PR_LABELS: '["renderer-bundle-override"]' });
    expect(r.status).toBe(0);
  });

  it("exits 1 (fails closed) when PR_LABELS is malformed JSON", () => {
    const r = runGate({ PR_BODY: "Fixes #1", PR_LABELS: "not-json" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::/);
  });
});
