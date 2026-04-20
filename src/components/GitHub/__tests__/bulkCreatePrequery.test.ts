import { describe, it, expect, vi } from "vitest";
import { resolveIssuePrequeries } from "../bulkCreatePrequery";
import type { GitHubIssue } from "@shared/types";

describe("resolveIssuePrequeries", () => {
  const mockIssue = (number: number): GitHubIssue => ({
    number,
    title: `Test Issue ${number}`,
    state: "OPEN",
    url: `https://github.com/test/repo/issues/${number}`,
    updatedAt: new Date().toISOString(),
    author: { login: "testuser", avatarUrl: "https://example.com/avatar.png" },
    assignees: [],
    commentCount: 0,
    labels: [],
  });

  const mockPlanned = (number: number, branchName: string = `feature/issue-${number}`) => ({
    item: mockIssue(number),
    mode: "issue" as const,
    branchName,
    skipped: false,
  });

  it("resolves branch and path for a single item", async () => {
    const getAvailableBranch = vi.fn().mockResolvedValue("feature/issue-1");
    const getDefaultPath = vi.fn().mockResolvedValue("/path/to/issue-1");

    const { results, failedItems } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1)],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.size).toBe(1);
    expect(results.get(1)).toEqual({ branch: "feature/issue-1", path: "/path/to/issue-1" });
    expect(failedItems.length).toBe(0);
    expect(getAvailableBranch).toHaveBeenCalledWith("/repo", "feature/issue-1");
    expect(getDefaultPath).toHaveBeenCalledWith("/repo", "feature/issue-1");
  });

  it("resolves multiple items concurrently", async () => {
    const getAvailableBranch = vi.fn((_, name) => Promise.resolve(name));
    const getDefaultPath = vi.fn((_, branch) => Promise.resolve(`/path/${branch}`));

    const { results, failedItems } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1), mockPlanned(2), mockPlanned(3)],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.size).toBe(3);
    expect(results.get(1)).toEqual({ branch: "feature/issue-1", path: "/path/feature/issue-1" });
    expect(results.get(2)).toEqual({ branch: "feature/issue-2", path: "/path/feature/issue-2" });
    expect(results.get(3)).toEqual({ branch: "feature/issue-3", path: "/path/feature/issue-3" });
    expect(failedItems.length).toBe(0);
  });

  it("applies deterministic suffixes for colliding branch names", async () => {
    const getAvailableBranch = vi.fn().mockResolvedValue("feature/issue-1");
    const getDefaultPath = vi.fn((_, branch) => Promise.resolve(`/path/${branch}`));

    const { results } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [
        mockPlanned(1, "feature/issue-1"),
        mockPlanned(2, "feature/issue-1"),
        mockPlanned(3, "feature/issue-1"),
      ],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.size).toBe(3);
    expect(results.get(1)?.branch).toBe("feature/issue-1");
    expect(results.get(2)?.branch).toBe("feature/issue-1-2");
    expect(results.get(3)?.branch).toBe("feature/issue-1-3");
    expect(getDefaultPath).toHaveBeenCalledWith("/repo", "feature/issue-1");
    expect(getDefaultPath).toHaveBeenCalledWith("/repo", "feature/issue-1-2");
    expect(getDefaultPath).toHaveBeenCalledWith("/repo", "feature/issue-1-3");
  });

  it("handles branch name collisions across items in the same batch", async () => {
    const getAvailableBranch = vi.fn().mockResolvedValue("feature/issue-1");
    const getDefaultPath = vi.fn((_, branch) => Promise.resolve(`/path/${branch}`));

    const { results } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1, "feature/issue-1"), mockPlanned(2, "feature/issue-1")],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.get(1)?.branch).toBe("feature/issue-1");
    expect(results.get(2)?.branch).toBe("feature/issue-1-2");
  });

  it("handles partial failures gracefully", async () => {
    const getAvailableBranch = vi.fn((_, name) => {
      if (name === "feature/issue-2") throw new Error("Branch lookup failed");
      return Promise.resolve(name);
    });
    const getDefaultPath = vi.fn().mockResolvedValue("/path");

    const { results, failedItems } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1), mockPlanned(2), mockPlanned(3)],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.size).toBe(2);
    expect(failedItems.some((f) => f.number === 2)).toBe(true);
    expect(results.get(1)).toBeDefined();
    expect(results.get(3)).toBeDefined();
  });

  it("stops early on stale run", async () => {
    let callCount = 0;
    const getAvailableBranch = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "branch";
    });
    const getDefaultPath = vi.fn().mockResolvedValue("/path");

    let isStale = false;
    const { results: _, failedItems } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1), mockPlanned(2), mockPlanned(3)],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => isStale,
    });

    setTimeout(() => {
      isStale = true;
    }, 5);

    expect(failedItems.length).toBeGreaterThanOrEqual(0);
    expect(callCount).toBeGreaterThan(0);
  });

  it("returns empty results for zero items", async () => {
    const { results, failedItems } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [],
      existingBranches: null,
      getAvailableBranch: vi.fn(),
      getDefaultPath: vi.fn(),
      isStaleRun: () => false,
    });

    expect(results.size).toBe(0);
    expect(failedItems.length).toBe(0);
  });

  it("filters out skipped and non-issue items", async () => {
    const getAvailableBranch = vi.fn().mockResolvedValue("branch");
    const getDefaultPath = vi.fn().mockResolvedValue("/path");

    const { results } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [
        mockPlanned(1),
        { ...mockPlanned(2), skipped: true },
        { ...mockPlanned(3), mode: "pr" as const },
      ],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.size).toBe(1);
    expect(results.has(1)).toBe(true);
  });

  it("handles path lookup failures", async () => {
    const getAvailableBranch = vi.fn().mockResolvedValue("branch");
    const getDefaultPath = vi.fn().mockRejectedValue(new Error("Path lookup failed"));

    const { results, failedItems } = await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1)],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
    });

    expect(results.size).toBe(0);
    expect(failedItems.some((f) => f.number === 1)).toBe(true);
  });

  it("calls onProgress callback with completion stats", async () => {
    const getAvailableBranch = vi.fn().mockResolvedValue("branch");
    const getDefaultPath = vi.fn().mockResolvedValue("/path");
    const onProgress = vi.fn();

    await resolveIssuePrequeries({
      rootPath: "/repo",
      items: [mockPlanned(1), mockPlanned(2), mockPlanned(3)],
      existingBranches: null,
      getAvailableBranch,
      getDefaultPath,
      isStaleRun: () => false,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });
});
