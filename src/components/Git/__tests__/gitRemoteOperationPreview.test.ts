import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_COMMIT_LIMIT,
  buildGitRemoteOperationPreview,
  formatGitRemoteOperationPreviewLines,
} from "../gitRemoteOperationPreview";

function stubGit(overrides: {
  currentBranch?: string | null;
  items?: Array<{ hash: string; message: string; author: { name: string } }>;
  reject?: boolean;
}) {
  // `??` would swallow an explicit null, which is exactly the detached-HEAD
  // case under test — key off presence instead.
  const currentBranch = "currentBranch" in overrides ? overrides.currentBranch : "main";
  const getStagingStatus = vi.fn(() =>
    overrides.reject
      ? Promise.reject(new Error("git status failed"))
      : Promise.resolve({ currentBranch })
  );
  const listCommits = vi.fn(() => Promise.resolve({ items: overrides.items ?? [] }));
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
      commits: [{ hash: "abcdef1234", message: "Fix the thing", author: "Ada" }],
    });
  });

  it("preserves a null branch rather than inventing one for detached HEAD", async () => {
    stubGit({ currentBranch: null });
    await expect(buildGitRemoteOperationPreview("/repo")).resolves.toMatchObject({ branch: null });
  });

  it("rejects when a read fails so callers can distinguish it from an empty repo", async () => {
    stubGit({ reject: true });
    await expect(buildGitRemoteOperationPreview("/repo")).rejects.toThrow("git status failed");
  });
});

describe("formatGitRemoteOperationPreviewLines", () => {
  it("shows the branch and one short-hash row per commit", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "feature/x",
        commits: [
          { hash: "abcdef1234567", message: "First", author: "Ada" },
          { hash: "9876543210fed", message: "Second", author: "Bob" },
        ],
      },
      "none"
    );
    expect(lines[0]).toBe("Branch: feature/x");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("abcdef1");
    expect(lines[1]).not.toContain("abcdef1234567");
    expect(lines[1]).toContain("First");
    expect(lines[1]).toContain("Ada");
  });

  it("treats an empty commit list as a valid loaded state, not a failure", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      { branch: "main", commits: [] },
      "No local commits found on this branch."
    );
    expect(lines).toEqual(["Branch: main", "No local commits found on this branch."]);
    expect(lines.join(" ")).not.toContain("Could not verify");
  });

  it("labels a detached HEAD instead of rendering a null branch", () => {
    const lines = formatGitRemoteOperationPreviewLines({ branch: null, commits: [] }, "none");
    expect(lines[0]).toBe("Branch: (detached HEAD)");
  });

  it("surfaces an explicit couldn't-verify warning for a failed fetch", () => {
    const lines = formatGitRemoteOperationPreviewLines(null, "none");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Could not verify");
    // Must never read as "nothing to push" — that's the whole point of the
    // null sentinel being distinct from an empty commit list.
    expect(lines[0]).not.toContain("Branch:");
  });
});
