import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
  resolvePathPattern,
  buildPathPatternVariables,
  generateWorktreePath,
  validatePathPattern,
  validateBranchName,
  previewPathPattern,
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

  it("builds variables from a WSL UNC root path", () => {
    const vars = buildPathPatternVariables("\\\\wsl$\\Ubuntu\\home\\user\\my-app", "feature/foo");
    expect(vars["base-folder"]).toBe("my-app");
    expect(vars["branch-slug"]).toBe("feature-foo");
    expect(vars["repo-name"]).toBe("my-app");
    expect(vars["parent-dir"]).toBe("//wsl$/Ubuntu/home/user");
  });

  it("treats a UNC share root as the parent dir with empty base-folder", () => {
    // \\server\share is the unescapable UNC root — basename returns ""
    // and dirname returns the share itself (matches path.win32 semantics).
    const vars = buildPathPatternVariables("\\\\server\\share", "develop");
    expect(vars["base-folder"]).toBe("");
    expect(vars["repo-name"]).toBe("");
    expect(vars["parent-dir"]).toBe("//server/share");
    expect(vars["branch-slug"]).toBe("develop");
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

  it("preserves the leading double-slash for a UNC parent-dir", () => {
    const uncVariables = {
      "base-folder": "my-app",
      "branch-slug": "feature-test",
      "repo-name": "my-app",
      "parent-dir": "//server/share/projects",
    };
    const pattern = "{parent-dir}/{base-folder}-worktrees/{branch-slug}";
    const result = resolvePathPattern(pattern, uncVariables, "//server/share/projects/my-app");
    expect(result).toBe("//server/share/projects/my-app-worktrees/feature-test");
  });

  it("normalizes a backslash UNC parent-dir without collapsing the prefix", () => {
    const uncVariables = {
      "base-folder": "my-app",
      "branch-slug": "feature-test",
      "repo-name": "my-app",
      "parent-dir": "\\\\server\\share\\projects",
    };
    const pattern = "{parent-dir}/{base-folder}-worktrees/{branch-slug}";
    const result = resolvePathPattern(pattern, uncVariables, "\\\\server\\share\\projects\\my-app");
    expect(result).toBe("//server/share/projects/my-app-worktrees/feature-test");
  });

  it("resolves relative patterns against a UNC root path", () => {
    const uncVariables = {
      "base-folder": "my-app",
      "branch-slug": "feature-test",
      "repo-name": "my-app",
      "parent-dir": "//wsl$/Ubuntu/home/user",
    };
    const pattern = "worktrees/{branch-slug}";
    const result = resolvePathPattern(
      pattern,
      uncVariables,
      "\\\\wsl$\\Ubuntu\\home\\user\\my-app"
    );
    expect(result).toBe("//wsl$/Ubuntu/home/user/my-app/worktrees/feature-test");
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

  it("preserves the UNC prefix for a WSL root path", () => {
    const result = generateWorktreePath("\\\\wsl$\\Ubuntu\\home\\user\\my-app", "feature/foo-bar");
    expect(result).toBe("//wsl$/Ubuntu/home/user/my-app-worktrees/feature-foo-bar");
  });

  it("preserves the UNC prefix for the \\\\server\\share\\dir fixture from issue #7948", () => {
    const result = generateWorktreePath("\\\\server\\share\\dir", "main");
    expect(result).toBe("//server/share/dir-worktrees/main");
  });

  it("anchors the path at the share when the root path IS the bare UNC share", () => {
    // \\server\share resolves to base-folder="" and parent-dir="//server/share",
    // so the default pattern produces a path immediately under the share root —
    // the share itself is the unescapable floor.
    const result = generateWorktreePath("\\\\server\\share", "main");
    expect(result).toBe("//server/share/-worktrees/main");
  });

  it("preserves the UNC prefix when using a custom pattern with UNC-derived variables", () => {
    const result = generateWorktreePath(
      "\\\\server\\share\\dir",
      "feature/foo",
      "{parent-dir}/{branch-slug}"
    );
    expect(result).toBe("//server/share/feature-foo");
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

  it("preserves the UNC prefix for a UNC root path", () => {
    const result = previewPathPattern(
      "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
      "\\\\server\\share\\projects\\my-app"
    );
    expect(result).toBe("//server/share/projects/my-app-worktrees/feature-example-branch");
  });
});

describe("validateBranchName", () => {
  it("accepts simple valid names", () => {
    expect(validateBranchName("feature/foo").valid).toBe(true);
    expect(validateBranchName("bugfix/issue-7033").valid).toBe(true);
    expect(validateBranchName("release/v1.2.3").valid).toBe(true);
    expect(validateBranchName("develop").valid).toBe(true);
  });

  it("rejects empty / blank input", () => {
    expect(validateBranchName("").valid).toBe(false);
    expect(validateBranchName("   ").valid).toBe(false);
  });

  it("rejects 'HEAD' (exact, case-sensitive)", () => {
    expect(validateBranchName("HEAD").valid).toBe(false);
    // 'head' is a perfectly valid git branch name.
    expect(validateBranchName("head").valid).toBe(true);
  });

  it("rejects '@' alone", () => {
    expect(validateBranchName("@").valid).toBe(false);
    // 'foo@bar' is fine — only the bare '@' is reserved.
    expect(validateBranchName("foo@bar").valid).toBe(true);
  });

  it("rejects names that start with '-'", () => {
    expect(validateBranchName("-bad").valid).toBe(false);
  });

  it("rejects forbidden punctuation: space ~ ^ : ? * [ \\", () => {
    expect(validateBranchName("feature foo").valid).toBe(false);
    expect(validateBranchName("feature~foo").valid).toBe(false);
    expect(validateBranchName("feature^foo").valid).toBe(false);
    expect(validateBranchName("feature:foo").valid).toBe(false);
    expect(validateBranchName("feature?foo").valid).toBe(false);
    expect(validateBranchName("feature*foo").valid).toBe(false);
    expect(validateBranchName("feature[foo").valid).toBe(false);
    expect(validateBranchName("feature\\foo").valid).toBe(false);
  });

  it("rejects '..' and '@{' substrings", () => {
    expect(validateBranchName("feature..foo").valid).toBe(false);
    expect(validateBranchName("feature@{foo").valid).toBe(false);
  });

  it("rejects consecutive slashes and leading/trailing slashes", () => {
    expect(validateBranchName("feature//foo").valid).toBe(false);
    expect(validateBranchName("/feature").valid).toBe(false);
    expect(validateBranchName("feature/").valid).toBe(false);
  });

  it("rejects components starting with '.' or ending with '.' / '.lock'", () => {
    expect(validateBranchName("feature/.hidden").valid).toBe(false);
    expect(validateBranchName(".feature").valid).toBe(false);
    expect(validateBranchName("feature/foo.").valid).toBe(false);
    expect(validateBranchName("feature.").valid).toBe(false);
    expect(validateBranchName("feature/foo.lock").valid).toBe(false);
    expect(validateBranchName("feature.lock").valid).toBe(false);
  });

  it("rejects '.lock' on a middle path component", () => {
    // git check-ref-format rejects component-level .lock anywhere, not just
    // the final component. The split-by-'/' loop must catch the middle case.
    expect(validateBranchName("feature/foo.lock/bar").valid).toBe(false);
  });

  it("rejects ASCII control characters", () => {
    expect(validateBranchName("feat\x01ure").valid).toBe(false);
    expect(validateBranchName("feat\x09ure").valid).toBe(false); // tab
    expect(validateBranchName("feat\x7fure").valid).toBe(false); // DEL
  });

  it("rejects Windows reserved names in any component, case-insensitively", () => {
    expect(validateBranchName("CON").valid).toBe(false);
    expect(validateBranchName("con").valid).toBe(false);
    expect(validateBranchName("Nul").valid).toBe(false);
    expect(validateBranchName("PRN").valid).toBe(false);
    expect(validateBranchName("AUX").valid).toBe(false);
    expect(validateBranchName("COM0").valid).toBe(false);
    expect(validateBranchName("COM9").valid).toBe(false);
    expect(validateBranchName("LPT1").valid).toBe(false);
    expect(validateBranchName("LPT0").valid).toBe(false);
    expect(validateBranchName("feature/nul").valid).toBe(false);
    expect(validateBranchName("nul/feature").valid).toBe(false);
  });

  it("rejects Windows reserved names with extension suffixes", () => {
    expect(validateBranchName("NUL.txt").valid).toBe(false);
    expect(validateBranchName("feature/CON.md").valid).toBe(false);
    expect(validateBranchName("prn.lock").valid).toBe(false);
  });

  it("does not reject names that merely contain a reserved substring", () => {
    expect(validateBranchName("nullable").valid).toBe(true);
    expect(validateBranchName("connection").valid).toBe(true);
    expect(validateBranchName("auxiliary").valid).toBe(true);
  });

  it("returns a descriptive error for the failure cause", () => {
    const result = validateBranchName("feature@{x");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("@{");

    const reservedResult = validateBranchName("feature/NUL");
    expect(reservedResult.valid).toBe(false);
    expect(reservedResult.error).toMatch(/Windows-reserved/);
  });
});

describe("edge cases", () => {
  it("handles empty branch name", () => {
    const result = sanitizeBranchName("");
    expect(result).toBe("");
  });

  it("handles branch name with only special chars", () => {
    const result = sanitizeBranchName("///");
    expect(result).toBe("");
  });
});
