import { describe, expect, it } from "vitest";
import {
  deriveIssueTitleFromBranch,
  extractIssueNumber,
  extractIssueNumberSync,
} from "../issueExtractor.js";

let seed = 0;
function unique(value: string): string {
  seed += 1;
  return `${value}-${seed}`;
}

describe("issueExtractor", () => {
  it("returns null for invalid or empty branch names", () => {
    expect(extractIssueNumberSync("" as unknown as string)).toBeNull();
    expect(extractIssueNumberSync("   ")).toBeNull();
    expect(extractIssueNumberSync(null as unknown as string)).toBeNull();
    expect(extractIssueNumberSync(undefined as unknown as string)).toBeNull();
  });

  it("extracts issue numbers from issue-* branch pattern", () => {
    expect(extractIssueNumberSync(unique("feature/issue-123-add-tests"))).toBe(123);
    expect(extractIssueNumberSync(unique("FEATURE/ISSUE-456"))).toBe(456);
  });

  it("extracts issue numbers from issues/* branch pattern", () => {
    expect(extractIssueNumberSync(unique("chore/issues/789-cleanup"))).toBe(789);
  });

  it("extracts issue numbers from hash pattern", () => {
    expect(extractIssueNumberSync(unique("feature/#1779-fix"))).toBe(1779);
  });

  it("extracts issue numbers from gh-* and jira-* patterns", () => {
    expect(extractIssueNumberSync(unique("feature/gh-42-something"))).toBe(42);
    expect(extractIssueNumberSync(unique("feature/jira-318"))).toBe(318);
  });

  it("ignores invalid issue numbers (zero and negatives)", () => {
    expect(extractIssueNumberSync(unique("feature/issue-0"))).toBeNull();
    expect(extractIssueNumberSync(unique("feature/#0"))).toBeNull();
  });

  it("returns null for skip branches", () => {
    expect(extractIssueNumberSync(unique("main"))).toBeNull();
    expect(extractIssueNumberSync(unique("master"))).toBeNull();
    expect(extractIssueNumberSync(unique("develop"))).toBeNull();
    expect(extractIssueNumberSync(unique("staging"))).toBeNull();
    expect(extractIssueNumberSync(unique("production"))).toBeNull();
    expect(extractIssueNumberSync(unique("release"))).toBeNull();
    expect(extractIssueNumberSync(unique("hotfix"))).toBeNull();
  });

  it("returns null for skip branch prefixes", () => {
    expect(extractIssueNumberSync(unique("main/experimental"))).toBeNull();
    expect(extractIssueNumberSync(unique("release/v2.0.0"))).toBeNull();
    expect(extractIssueNumberSync(unique("hotfix/urgent"))).toBeNull();
  });

  it("falls back to folder name when branch has no issue number", () => {
    expect(extractIssueNumberSync(unique("feature/without-id"), unique("issue-999-worktree"))).toBe(
      999
    );
  });

  it("prefers branch match over folder match when both exist", () => {
    expect(extractIssueNumberSync(unique("feature/issue-101"), unique("issue-202"))).toBe(101);
  });

  it("trims branch and folder names before parsing", () => {
    expect(extractIssueNumberSync(`  ${unique("feature/issue-700")}  `)).toBe(700);
    expect(extractIssueNumberSync(unique("feature/no-id"), `  ${unique("jira-321")}  `)).toBe(321);
  });

  it("async extractIssueNumber returns same result as sync extractor", async () => {
    const branch = unique("feature/issue-314");
    const folder = unique("worktree-issue-159");

    await expect(extractIssueNumber(branch, folder)).resolves.toBe(
      extractIssueNumberSync(branch, folder)
    );
  });
});

describe("deriveIssueTitleFromBranch", () => {
  it("returns undefined for invalid or empty branch names", () => {
    expect(deriveIssueTitleFromBranch("")).toBeUndefined();
    expect(deriveIssueTitleFromBranch("   ")).toBeUndefined();
    expect(deriveIssueTitleFromBranch(null as unknown as string)).toBeUndefined();
    expect(deriveIssueTitleFromBranch(undefined as unknown as string)).toBeUndefined();
  });

  it("returns undefined when the branch has no issue-<n>-<slug> pattern", () => {
    expect(deriveIssueTitleFromBranch("main")).toBeUndefined();
    expect(deriveIssueTitleFromBranch("feature/my-work")).toBeUndefined();
    expect(deriveIssueTitleFromBranch("issue-123")).toBeUndefined(); // no slug
    expect(deriveIssueTitleFromBranch("issue-123-")).toBeUndefined(); // empty slug
  });

  it("derives a sentence-cased title from issue-<n>-<slug>", () => {
    expect(deriveIssueTitleFromBranch("issue-8773-surface-assistant-launch")).toBe(
      "Surface assistant launch"
    );
  });

  it("strips a single branch prefix segment before parsing", () => {
    expect(deriveIssueTitleFromBranch("feature/issue-8773-surface-assistant-launch")).toBe(
      "Surface assistant launch"
    );
    expect(deriveIssueTitleFromBranch("bugfix/issue-42-fix-edge-case")).toBe("Fix edge case");
  });

  it("supports the slug-style prefix without a path separator", () => {
    expect(deriveIssueTitleFromBranch("feature-123-add-tests")).toBe("Add tests");
  });

  it("leaves non-leading words lowercase (sentence case, not title case)", () => {
    expect(deriveIssueTitleFromBranch("issue-7-add-oauth-support")).toBe("Add oauth support");
    expect(deriveIssueTitleFromBranch("issue-9-fix-api-rate-limit")).toBe("Fix api rate limit");
  });

  it("collapses multiple separator characters into single spaces", () => {
    expect(deriveIssueTitleFromBranch("issue-1-a--b--c")).toBe("A b c");
  });

  it("uses only the last path segment to find the slug", () => {
    expect(deriveIssueTitleFromBranch("user/feature/issue-99-deep-nested")).toBe("Deep nested");
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(deriveIssueTitleFromBranch("  issue-1-hello-world  ")).toBe("Hello world");
  });
});
