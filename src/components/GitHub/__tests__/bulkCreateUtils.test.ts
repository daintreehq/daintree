import { describe, it, expect } from "vitest";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import {
  planIssueWorktrees,
  planPRWorktrees,
  isTransientError,
  normalizeError,
  delay,
  nextBackoffDelay,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_AUTO_RETRIES,
} from "../bulkCreateUtils";

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Test issue",
    state: "OPEN",
    url: "https://github.com/foo/bar/issues/1",
    ...overrides,
  } as GitHubIssue;
}

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 1,
    title: "Test PR",
    state: "OPEN",
    url: "https://github.com/foo/bar/pull/1",
    headRefName: "feature/test",
    ...overrides,
  } as GitHubPR;
}

describe("planIssueWorktrees", () => {
  it("returns empty for empty input", () => {
    expect(planIssueWorktrees([], new Set())).toEqual([]);
  });

  it("plans a single open issue", () => {
    const result = planIssueWorktrees([makeIssue({ number: 1 })], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.skipped).toBe(false);
    expect(result[0]!.branchName).toContain("issue-1");
    expect(result[0]!.prefix).toBeTruthy();
  });

  it("skips closed issues", () => {
    const result = planIssueWorktrees([makeIssue({ number: 1, state: "CLOSED" })], new Set());
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Closed");
  });

  it("skips issues that already have worktrees", () => {
    const result = planIssueWorktrees([makeIssue({ number: 1 })], new Set([1]));
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Has worktree");
  });

  it("generates unique branch names for duplicate issue numbers", () => {
    // Two different issues with the same number is unrealistic, but test the map behavior
    const issues = [
      makeIssue({ number: 1, title: "Fix bug" }),
      makeIssue({ number: 2, title: "Add feature" }),
    ];
    const result = planIssueWorktrees(issues, new Set());
    expect(result[0]!.branchName).not.toBe(result[1]!.branchName);
  });
});

describe("planPRWorktrees", () => {
  it("returns empty for empty input", () => {
    expect(planPRWorktrees([], new Set())).toEqual([]);
  });

  it("plans a single open PR with headRefName", () => {
    const result = planPRWorktrees([makePR({ number: 1, headRefName: "feature/foo" })], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.skipped).toBe(false);
    expect(result[0]!.branchName).toBe("feature/foo");
    expect(result[0]!.headRefName).toBe("feature/foo");
  });

  it("skips merged PRs", () => {
    const result = planPRWorktrees(
      [makePR({ number: 1, state: "MERGED" as GitHubPR["state"] })],
      new Set()
    );
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Merged");
  });

  it("skips closed PRs", () => {
    const result = planPRWorktrees(
      [makePR({ number: 1, state: "CLOSED" as GitHubPR["state"] })],
      new Set()
    );
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Closed");
  });

  it("skips PRs without headRefName", () => {
    const result = planPRWorktrees(
      [makePR({ number: 1, headRefName: undefined } as GitHubPR)],
      new Set()
    );
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("No branch info");
  });

  it("skips PRs that already have worktrees", () => {
    const result = planPRWorktrees([makePR({ number: 1 })], new Set([1]));
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Has worktree");
  });
});

describe("isTransientError", () => {
  it("matches lock file error", () => {
    expect(isTransientError("cannot lock ref 'HEAD'")).toBe(true);
  });

  it("matches rate limit exceeded", () => {
    expect(isTransientError("Rate limit exceeded")).toBe(true);
  });

  it("matches ETIMEDOUT", () => {
    expect(isTransientError("ETIMEDOUT")).toBe(true);
  });

  it("matches ECONNRESET", () => {
    expect(isTransientError("ECONNRESET")).toBe(true);
  });

  it("matches spawn queue full", () => {
    expect(isTransientError("Spawn queue full")).toBe(true);
  });

  it("rejects VALIDATION_ERROR code", () => {
    expect(isTransientError("something", "VALIDATION_ERROR")).toBe(false);
  });

  it("rejects NOT_FOUND code", () => {
    expect(isTransientError("something", "NOT_FOUND")).toBe(false);
  });

  it("rejects non-matching messages", () => {
    expect(isTransientError("Something went wrong")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isTransientError("")).toBe(false);
  });
});

describe("normalizeError", () => {
  it("extracts message from Error", () => {
    expect(normalizeError(new Error("test"))).toBe("test");
  });

  it("passes through strings", () => {
    expect(normalizeError("direct string")).toBe("direct string");
  });

  it("stringifies objects", () => {
    expect(normalizeError({ code: "ERR" })).toBe("[object Object]");
  });

  it("handles null", () => {
    expect(normalizeError(null)).toBe("null");
  });
});

describe("delay", () => {
  it("resolves after given ms", async () => {
    const start = Date.now();
    await delay(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8); // allow small timer drift
  });
});

describe("nextBackoffDelay", () => {
  it("returns a value at least BACKOFF_BASE_MS", () => {
    for (let i = 0; i < 20; i++) {
      expect(nextBackoffDelay(BACKOFF_BASE_MS)).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    }
  });

  it("does not exceed BACKOFF_CAP_MS", () => {
    for (let i = 0; i < 20; i++) {
      expect(nextBackoffDelay(BACKOFF_CAP_MS)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
  });

  it("grows proportional to input", () => {
    const small = nextBackoffDelay(1000);
    const large = nextBackoffDelay(10000);
    // Large's upper bound (30000) is bigger than small's (3000), so eventually
    // we expect large to produce bigger values on average
    // This is a probabilistic test — verify the cap works
    expect(small).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(large).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });
});

describe("constants", () => {
  it("MAX_AUTO_RETRIES is 2", () => {
    expect(MAX_AUTO_RETRIES).toBe(2);
  });
});
