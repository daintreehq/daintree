import { describe, expect, it } from "vitest";
import { replaceRecipeVariables, getAvailableVariables } from "../recipeVariables";
import type { RecipeContext } from "../recipeVariables";

describe("replaceRecipeVariables", () => {
  const fullContext: RecipeContext = {
    issueNumber: 123,
    prNumber: 456,
    worktreePath: "/home/user/project/worktrees/feature-123",
    branchName: "feature/issue-123-add-variables",
  };

  it("replaces all supported variables", () => {
    const text =
      "Issue {{issue_number}}, PR {{pr_number}}, path: {{worktree_path}}, branch: {{branch_name}}";
    expect(replaceRecipeVariables(text, fullContext)).toBe(
      "Issue #123, PR #456, path: /home/user/project/worktrees/feature-123, branch: feature/issue-123-add-variables"
    );
  });

  it("replaces missing context values with empty string", () => {
    const text = "Issue {{issue_number}} on {{branch_name}}";
    expect(replaceRecipeVariables(text, {})).toBe("Issue  on ");
  });

  it("leaves unknown variables unchanged", () => {
    const text = "Hello {{unknown_var}} world";
    expect(replaceRecipeVariables(text, fullContext)).toBe("Hello {{unknown_var}} world");
  });

  it("handles multiple occurrences of the same variable", () => {
    const text = "{{issue_number}} and {{issue_number}}";
    expect(replaceRecipeVariables(text, { issueNumber: 42 })).toBe("#42 and #42");
  });

  it("handles empty string input", () => {
    expect(replaceRecipeVariables("", fullContext)).toBe("");
  });

  it("handles string with no variables", () => {
    const text = "Just plain text";
    expect(replaceRecipeVariables(text, fullContext)).toBe("Just plain text");
  });

  it("is case-insensitive for variable names", () => {
    const text = "{{ISSUE_NUMBER}} {{Issue_Number}} {{issue_number}}";
    expect(replaceRecipeVariables(text, { issueNumber: 7 })).toBe("#7 #7 #7");
  });

  it("does not replace malformed syntax", () => {
    const text = "{ {issue_number}} {{issue_number} } {issue_number}";
    expect(replaceRecipeVariables(text, { issueNumber: 1 })).toBe(
      "{ {issue_number}} {{issue_number} } {issue_number}"
    );
  });

  it("handles undefined vs zero for numeric values", () => {
    expect(replaceRecipeVariables("{{issue_number}}", { issueNumber: 0 })).toBe("#0");
    expect(replaceRecipeVariables("{{issue_number}}", {})).toBe("");
  });
});

describe("getAvailableVariables", () => {
  it("returns all supported variables", () => {
    const vars = getAvailableVariables();
    const names = vars.map((v) => v.name);
    expect(names).toContain("issue_number");
    expect(names).toContain("pr_number");
    expect(names).toContain("worktree_path");
    expect(names).toContain("branch_name");
  });

  it("includes descriptions for all variables", () => {
    const vars = getAvailableVariables();
    for (const v of vars) {
      expect(v.description).toBeTruthy();
    }
  });
});
