import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_COMMIT_LIMIT,
  buildGitRemoteOperationPreview,
  formatGitRemoteOperationPreviewLines,
} from "../gitRemoteOperationPreview";

function stubGit(overrides: {
  currentBranch?: string | null;
  pushDestination?: { remote: string; branch: string } | null;
  pullSource?: { remote: string; branch: string } | null;
  items?: Array<{ hash: string; message: string; author: { name: string } }>;
  reject?: boolean;
  rejectCommits?: boolean;
}) {
  // `??` would swallow an explicit null, which is exactly the detached-HEAD
  // case under test — key off presence instead.
  const currentBranch = "currentBranch" in overrides ? overrides.currentBranch : "main";
  const pushDestination =
    "pushDestination" in overrides
      ? overrides.pushDestination
      : { remote: "origin", branch: currentBranch ?? "main" };
  const pullSource =
    "pullSource" in overrides
      ? overrides.pullSource
      : { remote: "origin", branch: currentBranch ?? "main" };
  const getStagingStatus = vi.fn(() =>
    overrides.reject
      ? Promise.reject(new Error("git status failed"))
      : Promise.resolve({ currentBranch, pushDestination, pullSource })
  );
  const listCommits = vi.fn(() =>
    overrides.rejectCommits
      ? Promise.reject(new Error("git log failed"))
      : Promise.resolve({ items: overrides.items ?? [] })
  );
  Object.defineProperty(globalThis, "window", {
    value: { electron: { git: { getStagingStatus, listCommits } } },
    configurable: true,
    writable: true,
  });
  return { getStagingStatus, listCommits };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
});

describe("buildGitRemoteOperationPreview", () => {
  it("reads branch and commits fresh from the same cwd on every call", async () => {
    const { getStagingStatus, listCommits } = stubGit({ currentBranch: "feature/x" });
    await buildGitRemoteOperationPreview("/repo");
    await buildGitRemoteOperationPreview("/repo");
    expect(getStagingStatus).toHaveBeenCalledTimes(2);
    expect(getStagingStatus).toHaveBeenCalledWith("/repo");
    expect(listCommits).toHaveBeenCalledTimes(2);
    expect(listCommits).toHaveBeenCalledWith({ cwd: "/repo", limit: PREVIEW_COMMIT_LIMIT });
  });

  it("flattens the commit author to a display name", async () => {
    stubGit({
      items: [{ hash: "abcdef1234", message: "Fix the thing", author: { name: "Ada" } }],
    });
    const preview = await buildGitRemoteOperationPreview("/repo");
    expect(preview).toEqual({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [{ hash: "abcdef1234", message: "Fix the thing", author: "Ada" }],
    });
  });

  it("carries the resolved push destination through from the staging status", async () => {
    stubGit({ pushDestination: { remote: "fork", branch: "release/topic" } });
    await expect(buildGitRemoteOperationPreview("/repo")).resolves.toMatchObject({
      destination: { remote: "fork", branch: "release/topic" },
    });
  });

  it("preserves a null destination rather than inventing origin", async () => {
    stubGit({ pushDestination: null });
    await expect(buildGitRemoteOperationPreview("/repo")).resolves.toMatchObject({
      destination: null,
    });
  });

  it("carries the upstream separately from the push destination", async () => {
    // A triangular branch pulls from one repository and pushes to another; the
    // pull-rebase confirm must name the former, not the latter (#11746).
    stubGit({
      pushDestination: { remote: "fork", branch: "topic" },
      pullSource: { remote: "origin", branch: "release/topic" },
    });
    await expect(buildGitRemoteOperationPreview("/repo")).resolves.toMatchObject({
      destination: { remote: "fork", branch: "topic" },
      pullSource: { remote: "origin", branch: "release/topic" },
    });
  });

  it("preserves a null branch rather than inventing one for detached HEAD", async () => {
    stubGit({ currentBranch: null });
    await expect(buildGitRemoteOperationPreview("/repo")).resolves.toMatchObject({ branch: null });
  });

  it("rejects when the status read fails so callers can distinguish it from an empty repo", async () => {
    stubGit({ reject: true });
    await expect(buildGitRemoteOperationPreview("/repo")).rejects.toThrow("git status failed");
  });

  // A commit-read failure must NOT be laundered into an empty commit list —
  // that would render as "no local commits" and enable approval on a preview
  // that never loaded.
  it("propagates a commit-read rejection instead of substituting an empty list", async () => {
    stubGit({ rejectCommits: true });
    await expect(buildGitRemoteOperationPreview("/repo")).rejects.toThrow("git log failed");
  });
});

describe("formatGitRemoteOperationPreviewLines", () => {
  it("shows the branch and one short-hash row per commit", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "feature/x",
        destination: { remote: "origin", branch: "feature/x" },
        pullSource: { remote: "origin", branch: "feature/x" },
        commits: [
          { hash: "abcdef1234567", message: "First", author: "Ada" },
          { hash: "9876543210fed", message: "Second", author: "Bob" },
        ],
      },
      "none",
      "push"
    );
    expect(lines[0]).toBe("Destination: origin/feature/x");
    expect(lines[1]).toBe("Branch: feature/x");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("abcdef1");
    expect(lines[2]).not.toContain("abcdef1234567");
    expect(lines[2]).toContain("First");
    expect(lines[2]).toContain("Ada");
  });

  it("names a destination whose remote branch differs from the local one", () => {
    // The fork case #11746 is about: the branch name alone would tell an
    // approver nothing about which repository is being written to.
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "topic",
        destination: { remote: "fork", branch: "release/topic" },
        pullSource: { remote: "fork", branch: "release/topic" },
        commits: [],
      },
      "none",
      "push"
    );
    expect(lines[0]).toBe("Destination: fork/release/topic");
  });

  it("names the upstream, not the push target, for a pull-rebase", () => {
    // The triangular case: pushing to `fork` while tracking `origin` means the
    // rebase integrates history the push line would never mention (#11746).
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "topic",
        destination: { remote: "fork", branch: "topic" },
        pullSource: { remote: "origin", branch: "release/topic" },
        commits: [],
      },
      "none",
      "pull-rebase"
    );
    expect(lines[0]).toBe("Rebases onto: origin/release/topic");
    expect(lines[0]).not.toContain("fork");
  });

  it("warns explicitly when no push destination is configured", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      { branch: "topic", destination: null, pullSource: null, commits: [] },
      "none",
      "push"
    );
    expect(lines[0]).toContain("No push destination");
    expect(lines[1]).toBe("Branch: topic");
  });

  it("warns about a missing upstream for a pull-rebase, even when a push target resolves", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "topic",
        destination: { remote: "fork", branch: "topic" },
        pullSource: null,
        commits: [],
      },
      "none",
      "pull-rebase"
    );
    expect(lines[0]).toBe(
      "⚠ This branch has no upstream to rebase onto — this operation will be refused."
    );
  });

  it("does not warn about a pull-rebase when only the push destination is missing", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "topic",
        destination: null,
        pullSource: { remote: "origin", branch: "topic" },
        commits: [],
      },
      "none",
      "pull-rebase"
    );
    expect(lines[0]).toBe("Rebases onto: origin/topic");
  });

  it("treats an empty commit list as a valid loaded state, not a failure", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
      },
      "No local commits found on this branch.",
      "push"
    );
    expect(lines).toEqual([
      "Destination: origin/main",
      "Branch: main",
      "No local commits found on this branch.",
    ]);
    expect(lines.join(" ")).not.toContain("Could not verify");
  });

  it("labels a detached HEAD instead of rendering a null branch", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: null,
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
      },
      "none",
      "push"
    );
    expect(lines[1]).toBe("Branch: (detached HEAD)");
  });

  it("surfaces an explicit couldn't-verify warning for a failed fetch", () => {
    const lines = formatGitRemoteOperationPreviewLines(null, "none", "push");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Could not verify");
    // Must never read as "nothing to push" — that's the whole point of the
    // null sentinel being distinct from an empty commit list.
    expect(lines[0]).not.toContain("Branch:");
  });
});
