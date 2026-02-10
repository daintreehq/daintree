import { describe, expect, it } from "vitest";
import { extractIssueNumber, extractIssueNumberSync } from "../issueExtractor.js";

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
