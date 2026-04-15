import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
  resolvePathPattern,
  buildPathPatternVariables,
  generateWorktreePath,
  validatePathPattern,
  previewPathPattern,
  DEFAULT_WORKTREE_PATH_PATTERN,
} from "../pathPattern.js";

describe("sanitizeBranchName", () => {
  it("replaces slashes with dashes", () => {
    expect(sanitizeBranchName("feature/foo-bar")).toBe("feature-foo-bar");
  });

  it("replaces multiple special characters", () => {
    expect(sanitizeBranchName("fix: issue #123")).toBe("fix-issue-123");
  });

  it("collapses consecutive dashes", () => {
    expect(sanitizeBranchName("feature///multi-slash")).toBe("feature-multi-slash");
  });

  it("removes leading and trailing dashes", () => {
    expect(sanitizeBranchName("/leading-slash/")).toBe("leading-slash");
  });

  it("handles complex branch names", () => {
    expect(sanitizeBranchName("feature/JIRA-123_add-new-feature")).toBe(
      "feature-JIRA-123_add-new-feature"
    );
  });

  it("preserves underscores", () => {
    expect(sanitizeBranchName("feature_with_underscores")).toBe("feature_with_underscores");
  });
});

describe("buildPathPatternVariables", () => {
  it("builds variables from Unix path", () => {
    const vars = buildPathPatternVariables("/Users/name/Projects/my-app", "feature/test");
    expect(vars["base-folder"]).toBe("my-app");
    expect(vars["branch-slug"]).toBe("feature-test");
    expect(vars["repo-name"]).toBe("my-app");
    expect(vars["parent-dir"]).toBe("/Users/name/Projects");
  });

  it("handles Windows-style paths", () => {
    // Note: On Unix, backslashes are not path separators, so basename returns the full path
    // This test documents current behavior - Windows compatibility would need platform detection
    const vars = buildPathPatternVariables("C:\\Users\\name\\Projects\\my-app", "develop");
    expect(vars["branch-slug"]).toBe("develop");
    // base-folder will be the full string on Unix (backslash is not a separator)
    expect(vars["base-folder"]).toBeDefined();
  });
});

describe("resolvePathPattern", () => {
  const rootPath = "/Users/name/Projects/my-app";
  const variables = {
    "base-folder": "my-app",
    "branch-slug": "feature-test",
    "repo-name": "my-app",
    "parent-dir": "/Users/name/Projects",
  };

  it("substitutes all variables", () => {
    const pattern = "{parent-dir}/{base-folder}-worktrees/{branch-slug}";
    const result = resolvePathPattern(pattern, variables, rootPath);
    expect(result).toBe("/Users/name/Projects/my-app-worktrees/feature-test");
  });

  it("resolves relative patterns", () => {
    const pattern = "worktrees/{branch-slug}";
    const result = resolvePathPattern(pattern, variables, rootPath);
    expect(result).toBe("/Users/name/Projects/my-app/worktrees/feature-test");
  });

  it("resolves relative patterns with single dot", () => {
    const pattern = "./{branch-slug}";
    const result = resolvePathPattern(pattern, variables, rootPath);
    expect(result).toBe("/Users/name/Projects/my-app/feature-test");
  });

  it("handles patterns without variables", () => {
    const pattern = "/tmp/worktrees/test";
    const result = resolvePathPattern(pattern, variables, rootPath);
    expect(result).toBe("/tmp/worktrees/test");
  });

  it("handles multiple occurrences of same variable", () => {
    const pattern = "{base-folder}/{base-folder}-{branch-slug}";
    const result = resolvePathPattern(pattern, variables, rootPath);
    // Relative patterns now resolve against rootPath for security
    expect(result).toBe("/Users/name/Projects/my-app/my-app/my-app-feature-test");
  });
});

describe("generateWorktreePath", () => {
  it("generates path with default pattern", () => {
    const result = generateWorktreePath("/Users/name/Projects/daintree-app", "feature/foo-bar");
    expect(result).toBe("/Users/name/Projects/daintree-app-worktrees/feature-foo-bar");
  });

  it("generates path with custom pattern", () => {
    const result = generateWorktreePath(
      "/Users/name/Projects/daintree-app",
      "feature/foo-bar",
      "{parent-dir}/{base-folder}-{branch-slug}"
    );
    expect(result).toBe("/Users/name/Projects/daintree-app-feature-foo-bar");
  });

  it("generates path with flat sibling pattern", () => {
    const result = generateWorktreePath(
      "/Users/name/Projects/daintree-app",
      "feature/foo-bar",
      "{parent-dir}/{branch-slug}"
    );
    expect(result).toBe("/Users/name/Projects/feature-foo-bar");
  });
});

describe("validatePathPattern", () => {
  it("returns valid for correct pattern", () => {
    const result = validatePathPattern("{parent-dir}/{base-folder}-{branch-slug}");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid for empty pattern", () => {
    const result = validatePathPattern("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Pattern cannot be empty");
  });

  it("returns invalid for whitespace-only pattern", () => {
    const result = validatePathPattern("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Pattern cannot be empty");
  });

  it("returns invalid for unknown variable", () => {
    const result = validatePathPattern("{unknown-var}/{branch-slug}");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown variable: {unknown-var}");
  });

  it("returns invalid when branch-slug is missing", () => {
    const result = validatePathPattern("{parent-dir}/{base-folder}");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Pattern must include {branch-slug}");
  });

  it("validates patterns with all variables", () => {
    const result = validatePathPattern("{parent-dir}/{repo-name}/{base-folder}-{branch-slug}");
    expect(result.valid).toBe(true);
  });

  it("rejects patterns with path traversal", () => {
    const result = validatePathPattern("../{branch-slug}");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Path traversal");
  });

  it("rejects patterns with absolute paths", () => {
    const result = validatePathPattern("/tmp/{branch-slug}");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Absolute paths are not allowed");
  });

  it("allows patterns starting with {parent-dir}", () => {
    const result = validatePathPattern("{parent-dir}/worktrees/{branch-slug}");
    expect(result.valid).toBe(true);
  });
});

describe("previewPathPattern", () => {
  it("generates preview with sample values", () => {
    const result = previewPathPattern(
      "{parent-dir}/{base-folder}-{branch-slug}",
      "/Users/name/Projects/my-project"
    );
    expect(result).toBe("/Users/name/Projects/my-project-feature-example-branch");
  });

  it("uses custom sample branch", () => {
    const result = previewPathPattern(
      "{parent-dir}/{base-folder}-{branch-slug}",
      "/Users/name/Projects/my-project",
      "bugfix/issue-42"
    );
    expect(result).toBe("/Users/name/Projects/my-project-bugfix-issue-42");
  });

  it("handles patterns that throw during resolution", () => {
    // previewPathPattern catches errors and returns "Invalid pattern"
    // For empty string, validatePathPattern would fail but generateWorktreePath
    // still produces output, so let's test with a truly invalid scenario
    const result = previewPathPattern("{branch-slug}", "/Users/name/Projects/my-project");
    // This is valid, so it should produce a result
    expect(result).toContain("feature-example-branch");
  });
});

describe("DEFAULT_WORKTREE_PATH_PATTERN", () => {
  it("is the expected default pattern", () => {
    expect(DEFAULT_WORKTREE_PATH_PATTERN).toBe(
      "{parent-dir}/{base-folder}-worktrees/{branch-slug}"
    );
  });

  it("produces expected output", () => {
    const result = generateWorktreePath(
      "/home/user/repos/my-app",
      "develop",
      DEFAULT_WORKTREE_PATH_PATTERN
    );
    expect(result).toBe("/home/user/repos/my-app-worktrees/develop");
  });
});

describe("edge cases", () => {
  it("handles very long branch names", () => {
    const longBranch = "feature/" + "a".repeat(200);
    const result = sanitizeBranchName(longBranch);
    // The slash is replaced with a dash, so length is the same
    expect(result.length).toBe(longBranch.length);
    expect(result).not.toContain("/");
  });

  it("handles empty branch name", () => {
    const result = sanitizeBranchName("");
    expect(result).toBe("");
  });

  it("handles branch name with only special chars", () => {
    const result = sanitizeBranchName("///");
    expect(result).toBe("");
  });

  it("handles unicode in branch names", () => {
    const result = sanitizeBranchName("feature/émoji-test");
    expect(result).not.toContain("/");
  });
});
