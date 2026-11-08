import { describe, expect, it } from "vitest";
import {
  replaceRecipeVariables,
  detectUnresolvedVariables,
  getAvailableVariables,
  hasRecipeVariables,
  recipeContextFromWorktree,
  recipeIssueContextFromIssue,
  segmentRecipePrompt,
} from "../recipeVariables";
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

  it("resolves {{number}} to issueNumber when present", () => {
    expect(replaceRecipeVariables("{{number}}", { issueNumber: 42 })).toBe("#42");
  });

  it("resolves {{number}} to prNumber when issueNumber is absent", () => {
    expect(replaceRecipeVariables("{{number}}", { prNumber: 99 })).toBe("#99");
  });

  it("prefers issueNumber over prNumber for {{number}}", () => {
    expect(replaceRecipeVariables("{{number}}", { issueNumber: 10, prNumber: 20 })).toBe("#10");
  });

  it("resolves {{number}} to empty string when neither is set", () => {
    expect(replaceRecipeVariables("{{number}}", {})).toBe("");
  });
});

describe("detectUnresolvedVariables", () => {
  const fullContext: RecipeContext = {
    issueNumber: 123,
    prNumber: 456,
    worktreePath: "/tmp/wt",
    branchName: "feature/test",
  };

  it("returns empty array when all variables are resolved", () => {
    const text = "Issue {{issue_number}} PR {{pr_number}}";
    expect(detectUnresolvedVariables(text, fullContext)).toEqual([]);
  });

  it("detects missing issueNumber", () => {
    const text = "fix {{issue_number}} on {{branch_name}}";
    expect(detectUnresolvedVariables(text, { branchName: "main" })).toEqual(["issue_number"]);
  });

  it("detects multiple missing variables", () => {
    const text = "{{issue_number}} {{pr_number}} {{branch_name}}";
    expect(detectUnresolvedVariables(text, {})).toEqual([
      "issue_number",
      "pr_number",
      "branch_name",
    ]);
  });

  it("does not include unknown variables", () => {
    const text = "{{unknown}} {{issue_number}}";
    expect(detectUnresolvedVariables(text, {})).toEqual(["issue_number"]);
  });

  it("returns empty for text with no variables", () => {
    expect(detectUnresolvedVariables("plain text", {})).toEqual([]);
  });

  it("treats zero as present", () => {
    expect(detectUnresolvedVariables("{{issue_number}}", { issueNumber: 0 })).toEqual([]);
  });

  it("marks {{number}} as unresolved when both issueNumber and prNumber are absent", () => {
    expect(detectUnresolvedVariables("{{number}}", {})).toEqual(["number"]);
  });

  it("marks {{number}} as resolved when issueNumber is set", () => {
    expect(detectUnresolvedVariables("{{number}}", { issueNumber: 1 })).toEqual([]);
  });

  it("marks {{number}} as resolved when prNumber is set", () => {
    expect(detectUnresolvedVariables("{{number}}", { prNumber: 1 })).toEqual([]);
  });

  it("deduplicates repeated variables", () => {
    const text = "{{issue_number}} and {{issue_number}}";
    expect(detectUnresolvedVariables(text, {})).toEqual(["issue_number"]);
  });

  it("is case-insensitive", () => {
    expect(detectUnresolvedVariables("{{ISSUE_NUMBER}}", {})).toEqual(["issue_number"]);
  });
});

describe("segmentRecipePrompt", () => {
  const joined = (text: string, context: RecipeContext | null) =>
    segmentRecipePrompt(text, context)
      .map((s) => (s.kind === "missing" ? "" : s.text))
      .join("");

  it("reassembles to exactly what launch sends", () => {
    const context: RecipeContext = { branchName: "main", worktreePath: "/w" };
    const prompts = [
      "  Fix {{issue_number}} on {{branch_name}} at {{WORKTREE_PATH}}  ",
      "{{foo}} {{number}}\n{{pr_number}}",
      "no variables",
      "{{ issue_number }} and {{issue-number}} and {{{branch_name}}}",
    ];
    for (const prompt of prompts) {
      expect(joined(prompt, context)).toBe(replaceRecipeVariables(prompt.trim(), context));
    }
  });

  it("classifies each token by what launch will do with it", () => {
    const kinds = segmentRecipePrompt("{{branch_name}} {{issue_number}} {{foo}}", {
      branchName: "main",
    })
      .filter((s) => s.kind !== "text")
      .map((s) => s.kind);
    expect(kinds).toEqual(["value", "missing", "unknown"]);
  });

  it("keeps known tokens as run-time variables when there is no context", () => {
    const kinds = segmentRecipePrompt("{{Branch_Name}} {{foo}}", null)
      .filter((s) => s.kind !== "text")
      .map((s) => s.kind);
    expect(kinds).toEqual(["variable", "unknown"]);
  });

  it("reports malformed spellings as unknown rather than dropping them", () => {
    const unknown = segmentRecipePrompt("{{ issue_number }} {{issue-number}}", {})
      .filter((s) => s.kind === "unknown")
      .map((s) => s.text);
    expect(unknown).toEqual(["{{ issue_number }}", "{{issue-number}}"]);
  });
});

describe("plugin recipe variables (#13797)", () => {
  const withValues = (values: Record<string, string>): RecipeContext => ({
    branchName: "feature/x",
    pluginVariables: values,
  });

  it("fills {{plugin.<name>}} from the plugin's values alongside host variables", () => {
    expect(
      replaceRecipeVariables(
        "Review {{plugin.record_title}} on {{branch_name}}",
        withValues({ record_title: "Invoice 42" })
      )
    ).toBe("Review Invoice 42 on feature/x");
  });

  it("inserts a value literally — no replacement patterns, no second expansion", () => {
    const text = "A {{plugin.a}} B {{plugin.b}}";
    expect(
      replaceRecipeVariables(text, withValues({ a: "$& $1 {{branch_name}}", b: "{{plugin.a}}" }))
    ).toBe("A $& $1 {{branch_name}} B {{plugin.a}}");
  });

  it("leaves a declared variable with no value empty, like a host variable", () => {
    expect(replaceRecipeVariables("Record: {{plugin.record_id}}.", withValues({}))).toBe(
      "Record: ."
    );
    expect(detectUnresolvedVariables("Record: {{plugin.record_id}}", withValues({}))).toEqual([
      "plugin.record_id",
    ]);
    expect(
      detectUnresolvedVariables("Record: {{plugin.record_id}}", withValues({ record_id: "7" }))
    ).toEqual([]);
  });

  it("keeps {{plugin.<name>}} as typed text outside a plugin's own recipe", () => {
    const user: RecipeContext = { branchName: "feature/x" };
    expect(replaceRecipeVariables("Explain {{plugin.foo}} on {{branch_name}}", user)).toBe(
      "Explain {{plugin.foo}} on feature/x"
    );
    expect(detectUnresolvedVariables("Explain {{plugin.foo}}", user)).toEqual([]);
    expect(segmentRecipePrompt("Explain {{plugin.foo}}", user)).toEqual([
      { kind: "text", text: "Explain " },
      { kind: "unknown", text: "{{plugin.foo}}", name: "plugin.foo" },
    ]);
  });

  it("never resolves a name through the prototype chain", () => {
    expect(replaceRecipeVariables("[{{plugin.constructor}}]", withValues({}))).toBe("[]");
    expect(replaceRecipeVariables("[{{plugin.toString}}]", withValues({}))).toBe("[]");
  });

  it("previews plugin variables as values or missing", () => {
    expect(
      segmentRecipePrompt("Open {{plugin.record_id}}", withValues({ record_id: "7" }))
    ).toEqual([
      { kind: "text", text: "Open " },
      { kind: "value", text: "7", name: "plugin.record_id" },
    ]);
    expect(segmentRecipePrompt("Open {{plugin.record_id}}", withValues({}))).toEqual([
      { kind: "text", text: "Open " },
      { kind: "missing", text: "{{plugin.record_id}}", name: "plugin.record_id" },
    ]);
  });
});

describe("tracker issues (#16381)", () => {
  const linear: RecipeContext = {
    issueNumber: 42,
    issueKey: "ENG-42",
    issueTitle: "Fix the login race",
    branchName: "eng-42-fix-login",
  };

  it("names a provider-served issue by its tracker key", () => {
    expect(replaceRecipeVariables("Work on {{issue_number}}", linear)).toBe("Work on ENG-42");
    expect(replaceRecipeVariables("Work on {{number}}", { ...linear, prNumber: 7 })).toBe(
      "Work on ENG-42"
    );
  });

  it("still renders a code-forge issue as #n", () => {
    expect(replaceRecipeVariables("{{issue_number}} {{number}}", { issueNumber: 42 })).toBe(
      "#42 #42"
    );
  });

  it("fills {{issue_title}} from the linked issue", () => {
    expect(replaceRecipeVariables("{{number}}: {{issue_title}}", linear)).toBe(
      "ENG-42: Fix the login race"
    );
    expect(replaceRecipeVariables("[{{issue_title}}]", { issueNumber: 1 })).toBe("[]");
    expect(detectUnresolvedVariables("{{issue_title}}", { issueNumber: 1 })).toEqual([
      "issue_title",
    ]);
    expect(detectUnresolvedVariables("{{issue_title}} {{issue_number}}", linear)).toEqual([]);
  });

  it("previews {{issue_title}} as a known variable", () => {
    expect(segmentRecipePrompt("About {{issue_title}}", linear)).toEqual([
      { kind: "text", text: "About " },
      { kind: "value", text: "Fix the login race", name: "issue_title" },
    ]);
  });

  it("names the issue by its key even without a number, and before a PR", () => {
    expect(replaceRecipeVariables("{{issue_number}} {{number}}", { issueKey: "ENG-9" })).toBe(
      "ENG-9 ENG-9"
    );
    expect(detectUnresolvedVariables("{{issue_number}} {{number}}", { issueKey: "ENG-9" })).toEqual(
      []
    );
    expect(replaceRecipeVariables("{{number}}", { issueKey: "  ", prNumber: 5 })).toBe("#5");
  });

  it("keeps a title or key to one line of printable text", () => {
    const context: RecipeContext = {
      issueKey: "ENG-\u001b[2J42",
      issueTitle: "  Fix\r\nthe\tlogin\u2028race\u0007\u009b31m  ",
    };
    expect(replaceRecipeVariables("{{issue_number}}: {{issue_title}}", context)).toBe(
      "ENG-[2J42: Fix the login race31m"
    );
  });

  it("treats a title with nothing printable as missing, everywhere launch looks", () => {
    const context: RecipeContext = { issueNumber: 3, issueTitle: "\r\n\u0007 " };
    expect(replaceRecipeVariables("[{{issue_title}}]", context)).toBe("[]");
    expect(detectUnresolvedVariables("{{issue_title}}", context)).toEqual(["issue_title"]);
    expect(segmentRecipePrompt("{{issue_title}}", context)).toEqual([
      { kind: "missing", text: "{{issue_title}}", name: "issue_title" },
    ]);
  });

  it("inserts a title literally, never expanding what it contains", () => {
    expect(
      replaceRecipeVariables("{{issue_title}}", {
        issueTitle: "$& {{branch_name}}",
        branchName: "main",
      })
    ).toBe("$& {{branch_name}}");
  });

  it("lists {{issue_title}} wherever the known variables are read", () => {
    expect(getAvailableVariables().map((v) => v.name)).toContain("issue_title");
    expect(hasRecipeVariables("About {{ISSUE_TITLE}}")).toBe(true);
  });

  it("takes a worktree's key only with the provider that owns it", () => {
    const base = { path: "/w", branch: "eng-42", issueNumber: 42, issueTitle: "Fix it" };
    expect(
      recipeContextFromWorktree({ ...base, issueProviderId: "linear", issueKey: "ENG-42" })
    ).toMatchObject({ issueNumber: 42, issueKey: "ENG-42", issueTitle: "Fix it" });
    expect(recipeContextFromWorktree({ ...base, issueKey: "ENG-42" }).issueKey).toBeUndefined();
  });

  it("takes an issue's key only when a provider served it", () => {
    const issue = { number: 42, title: "Fix it", key: "ENG-42" };
    expect(recipeIssueContextFromIssue({ ...issue, providerId: "linear" })).toEqual({
      issueNumber: 42,
      issueKey: "ENG-42",
      issueTitle: "Fix it",
    });
    expect(recipeIssueContextFromIssue(issue).issueKey).toBeUndefined();
  });
});
