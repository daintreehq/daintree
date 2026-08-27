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
  pushCommits?: Array<{ hash: string; message: string; author: string }>;
  pushTotal?: number;
  rangeBasis?: "tracked" | "creates" | "unverified";
  reject?: boolean;
  rejectCommits?: boolean;
  rejectPushCommits?: boolean;
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
  const pushCommits = overrides.pushCommits ?? [];
  const listPushCommits = vi.fn(() =>
    overrides.rejectPushCommits
      ? Promise.reject(new Error("git log range failed"))
      : Promise.resolve({
          destination: pushDestination,
          rangeBasis: overrides.rangeBasis ?? "tracked",
          commits: pushCommits,
          total: overrides.pushTotal ?? pushCommits.length,
        })
  );
  Object.defineProperty(globalThis, "window", {
    value: { electron: { git: { getStagingStatus, listCommits, listPushCommits } } },
    configurable: true,
    writable: true,
  });
  return { getStagingStatus, listCommits, listPushCommits };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
});

describe("buildGitRemoteOperationPreview", () => {
  it("reads fresh from the same cwd on every call", async () => {
    const { getStagingStatus, listPushCommits } = stubGit({ currentBranch: "feature/x" });
    await buildGitRemoteOperationPreview("/repo", "push");
    await buildGitRemoteOperationPreview("/repo", "push");
    expect(getStagingStatus).toHaveBeenCalledTimes(2);
    expect(getStagingStatus).toHaveBeenCalledWith("/repo");
    expect(listPushCommits).toHaveBeenCalledTimes(2);
  });

  // The #11979 invariant. A push preview must describe the range the push would
  // publish; the generic recent-history read describes the branch instead, and
  // the two diverge for every branch that is not entirely unpushed.
  it("measures a push against the resolved destination, never as recent history", async () => {
    const { listCommits, listPushCommits } = stubGit({ currentBranch: "feature/x" });
    await buildGitRemoteOperationPreview("/repo", "push");
    expect(listPushCommits).toHaveBeenCalledWith("/repo", "feature/x", PREVIEW_COMMIT_LIMIT);
    expect(listCommits).not.toHaveBeenCalled();
  });

  // Named explicitly rather than left to main to re-resolve: anything that
  // checks out another branch between the two reads would otherwise move the
  // range onto a branch the approver never saw.
  it("names the branch the status just reported when it asks for the range", async () => {
    const { listPushCommits } = stubGit({ currentBranch: "release/topic" });
    await buildGitRemoteOperationPreview("/repo", "push");
    expect(listPushCommits).toHaveBeenCalledWith("/repo", "release/topic", PREVIEW_COMMIT_LIMIT);
  });

  it("carries the range total and the creates-branch flag through for the push tail", async () => {
    stubGit({
      pushCommits: [{ hash: "abcdef1234", message: "First", author: "Ada" }],
      pushTotal: 9,
      rangeBasis: "unverified" as const,
    });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).resolves.toMatchObject({
      commits: [{ hash: "abcdef1234", message: "First", author: "Ada" }],
      pushRange: { total: 9, rangeBasis: "unverified" as const },
    });
  });

  // A destination nobody can name has no range to measure, and asking for one
  // anyway would surface the resolver's refusal as a load error rather than as
  // the actionable "set an upstream" state.
  it("skips the range read and reports no range when the destination is unresolved", async () => {
    const { listPushCommits } = stubGit({ pushDestination: null });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).resolves.toMatchObject({
      destination: null,
      commits: [],
      pushRange: null,
    });
    expect(listPushCommits).not.toHaveBeenCalled();
  });

  it("skips the range read for a detached HEAD", async () => {
    const { listPushCommits } = stubGit({ currentBranch: null });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).resolves.toMatchObject({
      branch: null,
      pushRange: null,
    });
    expect(listPushCommits).not.toHaveBeenCalled();
  });

  // Fail closed. "The read broke" must never arrive looking like "there is
  // nothing to publish", which is the reassuring answer and the wrong one.
  it("propagates a push-range rejection instead of substituting an empty range", async () => {
    stubGit({ rejectPushCommits: true });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).rejects.toThrow(
      "git log range failed"
    );
  });

  it("prefers the destination the range was actually measured against", async () => {
    // Main resolves independently for the ranged read. If the two ever disagree,
    // the rows on screen belong to main's answer, so that is the one to render.
    const { listPushCommits } = stubGit({ pushDestination: { remote: "fork", branch: "topic" } });
    listPushCommits.mockResolvedValueOnce({
      destination: { remote: "fork", branch: "renamed-topic" },
      rangeBasis: "tracked" as const,
      commits: [],
      total: 0,
    });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).resolves.toMatchObject({
      destination: { remote: "fork", branch: "renamed-topic" },
    });
  });

  it("keeps reading recent local history for a pull-rebase", async () => {
    const { listCommits, listPushCommits } = stubGit({
      items: [{ hash: "abcdef1234", message: "Fix the thing", author: { name: "Ada" } }],
    });
    await expect(buildGitRemoteOperationPreview("/repo", "pull-rebase")).resolves.toMatchObject({
      commits: [{ hash: "abcdef1234", message: "Fix the thing", author: "Ada" }],
      pushRange: null,
    });
    expect(listCommits).toHaveBeenCalledWith({ cwd: "/repo", limit: PREVIEW_COMMIT_LIMIT });
    expect(listPushCommits).not.toHaveBeenCalled();
  });

  it("carries the resolved push destination through from the staging status", async () => {
    stubGit({ pushDestination: { remote: "fork", branch: "release/topic" } });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).resolves.toMatchObject({
      destination: { remote: "fork", branch: "release/topic" },
    });
  });

  it("preserves a null destination rather than inventing origin", async () => {
    stubGit({ pushDestination: null });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).resolves.toMatchObject({
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
    await expect(buildGitRemoteOperationPreview("/repo", "pull-rebase")).resolves.toMatchObject({
      destination: { remote: "fork", branch: "topic" },
      pullSource: { remote: "origin", branch: "release/topic" },
    });
  });

  it("rejects when the status read fails so callers can distinguish it from an empty repo", async () => {
    stubGit({ reject: true });
    await expect(buildGitRemoteOperationPreview("/repo", "push")).rejects.toThrow(
      "git status failed"
    );
  });

  it("propagates a commit-read rejection instead of substituting an empty list", async () => {
    stubGit({ rejectCommits: true });
    await expect(buildGitRemoteOperationPreview("/repo", "pull-rebase")).rejects.toThrow(
      "git log failed"
    );
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
        pushRange: null,
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
        pushRange: null,
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
        pushRange: null,
      },
      "none",
      "pull-rebase"
    );
    expect(lines[0]).toBe("Rebases onto: origin/release/topic");
    expect(lines[0]).not.toContain("fork");
  });

  it("warns explicitly when no push destination is configured", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      { branch: "topic", destination: null, pullSource: null, commits: [], pushRange: null },
      "Nothing to publish — the destination already has everything on this branch.",
      "push"
    );
    expect(lines[0]).toContain("No push destination");
    expect(lines[1]).toBe("Branch: topic");
    // Nothing was compared, so the in-sync note would contradict the warning
    // one line above it — the line that says the push will be refused.
    expect(lines.join(" ")).not.toContain("already has everything");
  });

  it("warns about a missing upstream for a pull-rebase, even when a push target resolves", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "topic",
        destination: { remote: "fork", branch: "topic" },
        pullSource: null,
        commits: [],
        pushRange: null,
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
        pushRange: null,
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
        pushRange: null,
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
        pushRange: null,
      },
      "none",
      "push"
    );
    expect(lines[1]).toBe("Branch: (detached HEAD)");
  });

  // The tail is only honest while it is measured over the SAME range the rows
  // came from — a count from anywhere else describes a different set of commits.
  it("states the hidden tail from the measured push range", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [{ hash: "abcdef1234567", message: "First", author: "Ada" }],
        pushRange: { total: 4, rangeBasis: "tracked" as const },
      },
      "none",
      "push"
    );
    expect(lines[lines.length - 1]).toBe("  \u2026and 3 more");
  });

  it("omits a tail when the rows are the whole measured range", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [{ hash: "abcdef1234567", message: "First", author: "Ada" }],
        pushRange: { total: 1, rangeBasis: "tracked" as const },
      },
      "none",
      "push"
    );
    expect(lines.join(" ")).not.toContain("more");
  });

  // No range was measured, so no tail may be claimed — deriving one from the
  // row count would assert a total nothing counted.
  it("claims no tail when no range was measured", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [{ hash: "abcdef1234567", message: "First", author: "Ada" }],
        pushRange: null,
      },
      "none",
      "pull-rebase"
    );
    expect(lines.join(" ")).not.toContain("more");
  });

  // A creation claim is only made from a `creates` basis, which main sets only
  // after the REMOTE said it has no such branch — never from a missing local ref.
  it("says a push creates the branch only when the remote confirmed it", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "spike",
        destination: { remote: "origin", branch: "spike" },
        pullSource: null,
        commits: [],
        pushRange: { total: 0, rangeBasis: "creates" as const },
      },
      "none",
      "push"
    );
    expect(lines[0]).toBe("Destination: origin/spike (this push creates the branch)");
  });

  it("says unverified, not creates, when the remote could not be reached", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "spike",
        destination: { remote: "origin", branch: "spike" },
        pullSource: null,
        commits: [],
        pushRange: { total: 0, rangeBasis: "unverified" as const },
      },
      "none",
      "push"
    );
    expect(lines[0]).toContain("unverified");
    expect(lines[0]).not.toContain("creates");
  });

  // An empty `unverified` range means "nothing found locally", never "the
  // destination is up to date" — the caller's note asserts the second, so it
  // must not reach an approver who was told the remote was unreachable.
  it("refuses the in-sync note for an empty range the remote never confirmed", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "spike",
        destination: { remote: "fork", branch: "release/spike" },
        pullSource: null,
        commits: [],
        pushRange: { total: 0, rangeBasis: "unverified" as const },
      },
      "Nothing to publish — the destination already has everything on this branch.",
      "push"
    );
    const body = lines.join(" ");
    expect(body).not.toContain("already has everything");
    expect(body).toContain("fork");
    expect(body).toContain("isn't confirmed");
  });

  // The same range basis with a settled `tracked` answer IS the in-sync case,
  // so the guard above must not be swallowing the note in every empty state.
  it("still states in sync when the range settled against the destination", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      {
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: null,
        commits: [],
        pushRange: { total: 0, rangeBasis: "tracked" as const },
      },
      "Nothing to publish — the destination already has everything on this branch.",
      "push"
    );
    expect(lines[2]).toContain("already has everything");
  });

  // The pull-rebase note claims nothing about a remote, so it survives states
  // that silence the push one.
  it("keeps the pull-rebase note when there is no upstream to rebase onto", () => {
    const lines = formatGitRemoteOperationPreviewLines(
      { branch: "topic", destination: null, pullSource: null, commits: [], pushRange: null },
      "No local commits to replay.",
      "pull-rebase"
    );
    expect(lines[2]).toBe("No local commits to replay.");
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
