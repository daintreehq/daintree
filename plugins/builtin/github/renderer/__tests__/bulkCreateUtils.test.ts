import { describe, it, expect, vi } from "vitest";
import type { Issue, PR } from "@shared/types/forge";
import {
  planIssueWorktrees,
  planPRWorktrees,
  isTransientError,
  normalizeError,
  cancellableDelay,
  nextBackoffDelay,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  ASSIGNMENT_BACKOFF_CAP_MS,
  MAX_TRANSIENT_RETRY_MS,
  planBulkRecipeSpawnBatches,
} from "../components/bulkCreateUtils";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test issue",
    state: "open",
    url: "https://github.com/foo/bar/issues/1",
    ...overrides,
  } as Issue;
}

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    number: 1,
    title: "Test PR",
    state: "open",
    url: "https://github.com/foo/bar/pull/1",
    headRef: "feature/test",
    ...overrides,
  } as PR;
}

describe("planIssueWorktrees", () => {
  it("plans a single open issue", () => {
    const result = planIssueWorktrees([makeIssue({ number: 1 })], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.skipped).toBe(false);
    expect(result[0]!.branchName).toContain("issue-1");
    expect(result[0]!.prefix).toBeTruthy();
  });

  it("skips closed issues", () => {
    const result = planIssueWorktrees([makeIssue({ number: 1, state: "closed" })], new Set());
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Closed");
  });

  it("skips issues that already have worktrees", () => {
    const result = planIssueWorktrees([makeIssue({ number: 1 })], new Set([1]));
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Has worktree");
  });
});

describe("planBulkRecipeSpawnBatches", () => {
  it("shares one admission across single-terminal recipes for ten worktrees", () => {
    const batches = planBulkRecipeSpawnBatches(
      Array.from({ length: 10 }, (_, index) => index + 1),
      1,
      () => "batch-a"
    );

    expect(batches).toHaveLength(10);
    expect(new Set([...batches.values()].map((batch) => batch.id))).toEqual(new Set(["batch-a"]));
    expect([...batches.values()].every((batch) => batch.size === batches.size)).toBe(true);
  });

  it("splits larger operations into bounded groups without splitting a recipe", () => {
    let nextId = 0;
    const batches = planBulkRecipeSpawnBatches(
      Array.from({ length: 7 }, (_, index) => index + 1),
      5,
      () => `batch-${++nextId}`
    );

    const groups = new Map<string, Array<{ id: string; size: number }>>();
    for (const batch of batches.values()) {
      const group = groups.get(batch.id) ?? [];
      group.push(batch);
      groups.set(batch.id, group);
    }
    expect(groups.size).toBe(2);
    expect(groups.get("batch-1")).toHaveLength(6);
    expect(groups.get("batch-1")?.every((batch) => batch.size === 30)).toBe(true);
    expect(groups.get("batch-2")).toHaveLength(1);
    expect(groups.get("batch-2")?.[0]?.size).toBe(5);
  });

  it("does not attach batch metadata to one single-terminal launch", () => {
    expect(planBulkRecipeSpawnBatches([1], 1, () => "unused")).toEqual(new Map());
  });
});

describe("planPRWorktrees", () => {
  it("plans a single open PR with headRef", () => {
    const result = planPRWorktrees([makePR({ number: 1, headRef: "feature/foo" })], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.skipped).toBe(false);
    expect(result[0]!.branchName).toBe("feature/foo");
    expect(result[0]!.headRefName).toBe("feature/foo");
  });

  it("skips merged PRs", () => {
    const result = planPRWorktrees([makePR({ number: 1, state: "merged" })], new Set());
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Merged");
  });

  it("skips closed PRs", () => {
    const result = planPRWorktrees([makePR({ number: 1, state: "closed" })], new Set());
    expect(result[0]!.skipped).toBe(true);
    expect(result[0]!.skipReason).toBe("Closed");
  });

  it("skips PRs without headRef", () => {
    const result = planPRWorktrees(
      [makePR({ number: 1, headRef: undefined as unknown as string })],
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

  it("matches GitHub temporary unavailability (5xx)", () => {
    expect(isTransientError("GitHub is temporarily unavailable. Please retry.")).toBe(true);
  });

  it("matches GitHub network unreachable", () => {
    expect(isTransientError("Cannot reach GitHub. Check your internet connection.")).toBe(true);
  });

  it("matches GitHub secondary rate limit", () => {
    expect(isTransientError("GitHub secondary rate limit triggered. Slow down requests.")).toBe(
      true
    );
  });

  it("matches the raw GitHub secondary rate limit message body", () => {
    expect(
      isTransientError("You have exceeded a secondary rate limit. Please wait a few minutes.")
    ).toBe(true);
  });

  it("rejects GitHub permission errors as non-transient", () => {
    expect(isTransientError("Issue not found")).toBe(false);
    expect(isTransientError("Forbidden — check token scopes")).toBe(false);
    expect(isTransientError("Unauthorized — invalid token")).toBe(false);
  });

  it("rejects non-matching messages", () => {
    expect(isTransientError("Something went wrong")).toBe(false);
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
});

describe("cancellableDelay", () => {
  it("resolves after the full duration when never cancelled", async () => {
    vi.useFakeTimers();
    try {
      const promise = cancellableDelay(5000, () => false);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns early once the cancel guard flips, within one poll interval", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const promise = cancellableDelay(60000, () => cancelled);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      // Cancel mid-sleep; the poll interval is capped at 1s, so the next tick exits.
      await vi.advanceTimersByTimeAsync(3000);
      expect(settled).toBe(false);
      cancelled = true;
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves immediately for a non-positive duration", async () => {
    // No timers should be needed — a zero-ms wait must not block.
    await expect(cancellableDelay(0, () => false)).resolves.toBeUndefined();
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

  it("honors a per-call cap above the default", () => {
    for (let i = 0; i < 20; i++) {
      const value = nextBackoffDelay(50000, ASSIGNMENT_BACKOFF_CAP_MS);
      expect(value).toBeLessThanOrEqual(ASSIGNMENT_BACKOFF_CAP_MS);
      // With a 50s prior delay the max term in the formula is 150s; only the
      // 60s cap keeps the result bounded, proving the cap parameter is wired.
      expect(value).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    }
  });
});

describe("constants", () => {
  it("the transient retry ceiling outlasts the longest per-sleep backoff cap", () => {
    // The wall-clock ceiling must leave room for several full-length backoff
    // sleeps so a secondary rate limit can actually clear before we give up.
    expect(MAX_TRANSIENT_RETRY_MS).toBeGreaterThan(ASSIGNMENT_BACKOFF_CAP_MS);
    expect(MAX_TRANSIENT_RETRY_MS).toBeGreaterThan(BACKOFF_CAP_MS);
  });
});
