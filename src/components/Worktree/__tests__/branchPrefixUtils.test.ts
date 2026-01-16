import { describe, it, expect } from "vitest";
import {
  parseBranchInput,
  suggestPrefixes,
  detectPrefixFromIssue,
  buildBranchName,
} from "../branchPrefixUtils";
import type { GitHubIssue, GitHubLabel } from "@shared/types/github";

function createTestIssue(title: string, labels: GitHubLabel[] = []): GitHubIssue {
  return {
    number: 123,
    title,
    url: "https://github.com/test/test/issues/123",
    state: "OPEN",
    updatedAt: "2024-01-01",
    author: { login: "testuser", avatarUrl: "" },
    assignees: [],
    commentCount: 0,
    labels,
  };
}

describe("parseBranchInput", () => {
  it("parses branch with known prefix", () => {
    const result = parseBranchInput("feature/add-auth");
    expect(result).toEqual({
      prefix: "feature",
      slug: "add-auth",
      fullBranchName: "feature/add-auth",
      hasPrefix: true,
    });
  });

  it("parses branch with alias prefix", () => {
    const result = parseBranchInput("feat/add-auth");
    expect(result).toEqual({
      prefix: "feature", // normalized to canonical
      slug: "add-auth",
      fullBranchName: "feature/add-auth",
      hasPrefix: true,
    });
  });

  it("parses branch with custom unknown prefix", () => {
    const result = parseBranchInput("spike/experiment");
    expect(result).toEqual({
      prefix: "spike",
      slug: "experiment",
      fullBranchName: "spike/experiment",
      hasPrefix: true,
    });
  });

  it("parses branch without prefix", () => {
    const result = parseBranchInput("quick-fix");
    expect(result).toEqual({
      prefix: "",
      slug: "quick-fix",
      fullBranchName: "quick-fix",
      hasPrefix: false,
    });
  });

  it("handles empty input", () => {
    const result = parseBranchInput("");
    expect(result).toEqual({
      prefix: "",
      slug: "",
      fullBranchName: "",
      hasPrefix: false,
    });
  });

  it("handles input with multiple slashes", () => {
    const result = parseBranchInput("feature/sub/path");
    expect(result).toEqual({
      prefix: "feature",
      slug: "sub/path",
      fullBranchName: "feature/sub/path",
      hasPrefix: true,
    });
  });

  it("handles trailing slash", () => {
    const result = parseBranchInput("feature/");
    expect(result).toEqual({
      prefix: "feature",
      slug: "",
      fullBranchName: "feature/",
      hasPrefix: true,
    });
  });

  it("normalizes prefix case for known prefixes", () => {
    const result = parseBranchInput("FEATURE/add-auth");
    expect(result).toEqual({
      prefix: "feature",
      slug: "add-auth",
      fullBranchName: "feature/add-auth",
      hasPrefix: true,
    });
  });

  it("preserves case for unknown/custom prefixes", () => {
    const result = parseBranchInput("MyCustomPrefix/branch");
    expect(result).toEqual({
      prefix: "MyCustomPrefix",
      slug: "branch",
      fullBranchName: "MyCustomPrefix/branch",
      hasPrefix: true,
    });
  });

  it("treats leading slash as no prefix", () => {
    const result = parseBranchInput("/my-branch");
    expect(result).toEqual({
      prefix: "",
      slug: "/my-branch",
      fullBranchName: "/my-branch",
      hasPrefix: false,
    });
  });

  it("handles whitespace-only input", () => {
    const result = parseBranchInput("   ");
    expect(result).toEqual({
      prefix: "",
      slug: "",
      fullBranchName: "",
      hasPrefix: false,
    });
  });
});

describe("suggestPrefixes", () => {
  it("returns all prefixes when query is empty", () => {
    const suggestions = suggestPrefixes("");
    expect(suggestions.length).toBe(12); // All BRANCH_TYPES
    expect(suggestions.every((s) => s.matchScore === 1)).toBe(true);
  });

  it("suggests prefixes matching at start", () => {
    const suggestions = suggestPrefixes("fea");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].type.prefix).toBe("feature");
    expect(suggestions[0].matchScore).toBeGreaterThan(0);
  });

  it("suggests exact match with highest score", () => {
    const suggestions = suggestPrefixes("feature");
    expect(suggestions[0].type.prefix).toBe("feature");
    expect(suggestions[0].matchScore).toBe(100);
  });

  it("suggests aliases", () => {
    const suggestions = suggestPrefixes("fix");
    const hasBugfix = suggestions.some((s) => s.type.prefix === "bugfix");
    expect(hasBugfix).toBe(true);
  });

  it("returns empty for non-matching query", () => {
    const suggestions = suggestPrefixes("xyz123");
    expect(suggestions.length).toBe(0);
  });

  it("handles case-insensitive matching", () => {
    const suggestions = suggestPrefixes("FEAT");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].type.prefix).toBe("feature");
  });

  it("sorts by match score descending", () => {
    const suggestions = suggestPrefixes("f");
    if (suggestions.length > 1) {
      for (let i = 0; i < suggestions.length - 1; i++) {
        expect(suggestions[i].matchScore).toBeGreaterThanOrEqual(suggestions[i + 1].matchScore);
      }
    }
  });
});

describe("detectPrefixFromIssue", () => {
  it("returns null for null issue", () => {
    expect(detectPrefixFromIssue(null)).toBeNull();
  });

  it("detects bugfix from bug label", () => {
    const issue = createTestIssue("Something is broken", [{ name: "bug", color: "red" }]);
    expect(detectPrefixFromIssue(issue)).toBe("bugfix");
  });

  it("detects feature from enhancement label", () => {
    const issue = createTestIssue("Add new feature", [{ name: "enhancement", color: "green" }]);
    expect(detectPrefixFromIssue(issue)).toBe("feature");
  });

  it("detects docs from documentation label", () => {
    const issue = createTestIssue("Update README", [{ name: "documentation", color: "blue" }]);
    expect(detectPrefixFromIssue(issue)).toBe("docs");
  });

  it("detects refactor from refactoring label", () => {
    const issue = createTestIssue("Restructure code", [{ name: "refactoring", color: "orange" }]);
    expect(detectPrefixFromIssue(issue)).toBe("refactor");
  });

  it("detects bugfix from title with 'fix' keyword", () => {
    const issue = createTestIssue("Fix authentication error");
    expect(detectPrefixFromIssue(issue)).toBe("bugfix");
  });

  it("detects feature from title with 'add' keyword", () => {
    const issue = createTestIssue("Add dark mode support");
    expect(detectPrefixFromIssue(issue)).toBe("feature");
  });

  it("detects feature from title with 'implement' keyword", () => {
    const issue = createTestIssue("Implement user authentication");
    expect(detectPrefixFromIssue(issue)).toBe("feature");
  });

  it("detects refactor from title with 'refactor' keyword", () => {
    const issue = createTestIssue("Refactor API handlers");
    expect(detectPrefixFromIssue(issue)).toBe("refactor");
  });

  it("detects feature from title with 'improve' keyword", () => {
    const issue = createTestIssue("Improve performance");
    expect(detectPrefixFromIssue(issue)).toBe("feature");
  });

  it("prefers label detection over title keywords", () => {
    // Title has "Fix" keyword (would detect bugfix), but label should win (feature)
    const issue = createTestIssue("Fix and add support for workflow", [
      { name: "enhancement", color: "green" },
    ]);
    expect(detectPrefixFromIssue(issue)).toBe("feature");
  });

  it("returns null for ambiguous issue", () => {
    const issue = createTestIssue("Some random task");
    expect(detectPrefixFromIssue(issue)).toBeNull();
  });

  it("handles case-insensitive label matching", () => {
    const issue = createTestIssue("Something", [{ name: "BUG", color: "red" }]);
    expect(detectPrefixFromIssue(issue)).toBe("bugfix");
  });

  it("detects chore from label", () => {
    const issue = createTestIssue("Update dependencies", [{ name: "chore", color: "gray" }]);
    expect(detectPrefixFromIssue(issue)).toBe("chore");
  });

  it("detects test from label", () => {
    const issue = createTestIssue("Add missing tests", [{ name: "test", color: "amber" }]);
    expect(detectPrefixFromIssue(issue)).toBe("test");
  });

  it("detects perf from label", () => {
    const issue = createTestIssue("Optimize query", [{ name: "performance", color: "teal" }]);
    expect(detectPrefixFromIssue(issue)).toBe("perf");
  });

  it("detects feature from 'update' keyword in title", () => {
    const issue = createTestIssue("Update authentication flow");
    expect(detectPrefixFromIssue(issue)).toBe("feature");
  });

  it("does not falsely match keyword in middle of word", () => {
    const issue = createTestIssue("Debug prefix handler");
    expect(detectPrefixFromIssue(issue)).toBeNull();
  });
});

describe("buildBranchName", () => {
  it("builds branch with prefix and slash", () => {
    expect(buildBranchName("feature", "add-auth")).toBe("feature/add-auth");
  });

  it("builds branch without prefix", () => {
    expect(buildBranchName("", "quick-fix")).toBe("quick-fix");
  });

  it("handles empty slug", () => {
    expect(buildBranchName("feature", "")).toBe("feature/");
  });

  it("handles empty prefix and slug", () => {
    expect(buildBranchName("", "")).toBe("");
  });
});
