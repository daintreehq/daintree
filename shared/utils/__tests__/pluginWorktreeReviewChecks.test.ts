import { describe, expect, it } from "vitest";
import {
  PLUGIN_WORKTREE_REVIEW_CHECKS_MAX,
  PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX,
  PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX,
} from "../../types/plugin.js";
import {
  sameWorktreeReviewChecks,
  validatePluginWorktreeReviewChecks,
} from "../pluginWorktreeReviewChecks.js";

function vet(worktreeId: unknown, checks: unknown, instanceId = "acme.lint") {
  return validatePluginWorktreeReviewChecks(worktreeId, checks, "acme.lint", instanceId);
}

describe("validatePluginWorktreeReviewChecks", () => {
  it("accepts checks, trimmed, as fresh plain copies in order", () => {
    const input = [
      { label: "  3 broken links ", severity: "warning", detail: " in docs/ \n" },
      { label: "Schema ok", severity: "info" },
    ];
    const result = vet("/repo/wt", input);
    expect(result).toEqual({
      ok: true,
      worktreeId: "/repo/wt",
      checks: [
        { label: "3 broken links", severity: "warning", detail: "in docs/" },
        { label: "Schema ok", severity: "info" },
      ],
    });
    expect(result.ok && result.checks?.[0]).not.toBe(input[0]);
  });

  it.each([null, undefined, []])("treats %j as a clear", (value) => {
    expect(vet("/wt", value)).toEqual({ ok: true, worktreeId: "/wt", checks: null });
  });

  it("drops a blank detail rather than storing it", () => {
    const result = vet("/wt", [{ label: "x", severity: "info", detail: "  " }]);
    expect(result).toEqual({
      ok: true,
      worktreeId: "/wt",
      checks: [{ label: "x", severity: "info" }],
    });
  });

  it.each([
    ["an empty worktree id", "", [{ label: "x", severity: "info" }], "worktreeId"],
    ["a non-array", "/wt", { label: "x", severity: "info" }, "checks must be an array"],
    ["a non-object entry", "/wt", ["x"], "checks[0] must be an object"],
    ["a missing label", "/wt", [{ severity: "info" }], "label must be a string"],
    ["a blank label", "/wt", [{ label: " ", severity: "info" }], "must not be empty"],
    ["a multi-line label", "/wt", [{ label: "a\nb", severity: "info" }], "single line"],
    ["a blocker severity", "/wt", [{ label: "x", severity: "blocker" }], 'must be "warning" or'],
    ["a missing severity", "/wt", [{ label: "x" }], "severity"],
    ["an unknown field", "/wt", [{ label: "x", severity: "info", blocking: true }], '"blocking"'],
    ["a non-string detail", "/wt", [{ label: "x", severity: "info", detail: 3 }], "detail"],
  ])("rejects %s", (_name, worktreeId, checks, message) => {
    const result = vet(worktreeId, checks);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it("rejects the whole list when one entry is bad", () => {
    const result = vet("/wt", [
      { label: "fine", severity: "info" },
      { label: "", severity: "info" },
    ]);
    expect(!result.ok && result.error).toContain("checks[1].label");
  });

  it("enforces the limits exactly", () => {
    const label = (n: number) => "a".repeat(n);
    expect(
      vet("/wt", [{ label: label(PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX), severity: "info" }]).ok
    ).toBe(true);
    expect(
      vet("/wt", [{ label: label(PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX + 1), severity: "info" }])
        .ok
    ).toBe(false);
    const detail = (n: number) => [{ label: "x", severity: "info", detail: "d".repeat(n) }];
    expect(vet("/wt", detail(PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX)).ok).toBe(true);
    expect(vet("/wt", detail(PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX + 1)).ok).toBe(false);
    const many = (n: number) => Array.from({ length: n }, () => ({ label: "x", severity: "info" }));
    expect(vet("/wt", many(PLUGIN_WORKTREE_REVIEW_CHECKS_MAX)).ok).toBe(true);
    expect(vet("/wt", many(PLUGIN_WORKTREE_REVIEW_CHECKS_MAX + 1)).ok).toBe(false);
  });

  it("does not run a getter on plugin data", () => {
    const check = {
      severity: "info",
      get label(): string {
        throw new Error("boom");
      },
    };
    expect(() => vet("/wt", [check])).not.toThrow();
    expect(vet("/wt", [check]).ok).toBe(false);
  });

  describe("command", () => {
    it("rewrites an own action into the instance namespace", () => {
      const result = vet(
        "/wt",
        [{ label: "x", severity: "info", command: "acme.lint.openReport" }],
        "acme.lint@proj1"
      );
      expect(result.ok && result.checks?.[0]?.command).toBe("acme.lint@proj1.openReport");
    });

    it.each([
      ["another plugin's action", "other.plugin.run"],
      ["a built-in action", "git.push"],
      ["a non-string", 7],
      ["the bare prefix", "acme.lint."],
    ])("rejects %s", (_name, command) => {
      expect(vet("/wt", [{ label: "x", severity: "info", command }]).ok).toBe(false);
    });
  });
});

describe("sameWorktreeReviewChecks", () => {
  const a = [{ label: "x", severity: "info" as const }];
  it("compares every field in order", () => {
    expect(sameWorktreeReviewChecks(a, [{ label: "x", severity: "info" }])).toBe(true);
    expect(sameWorktreeReviewChecks(undefined, a)).toBe(false);
    expect(sameWorktreeReviewChecks(a, [{ label: "x", severity: "warning" }])).toBe(false);
    expect(sameWorktreeReviewChecks(a, [...a, ...a])).toBe(false);
    expect(sameWorktreeReviewChecks(a, [{ label: "x", severity: "info", detail: "d" }])).toBe(
      false
    );
  });
});
