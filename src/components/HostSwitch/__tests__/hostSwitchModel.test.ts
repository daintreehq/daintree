import { describe, expect, it } from "vitest";
import type { BranchCheck } from "@shared/types/ipc/hostSwitch";
import {
  opensWithoutQuestion,
  candidateRelation,
  describeBranchHandoff,
  describeCloneFailure,
  describePlacedWorktree,
  destinationInFolder,
  hostDisplayName,
  initialView,
} from "../hostSwitchModel";

const PUSHES_TO_ORIGIN = { remote: "origin", branch: "feature/host-chip" };

const handoff = (
  branchCheck: BranchCheck | null,
  branch: string | null = "feature/host-chip",
  overrides: Partial<Parameters<typeof describeBranchHandoff>[0]> = {},
  existingCopy = false
) =>
  describeBranchHandoff(
    {
      branch,
      branchCheck,
      pushDestination: PUSHES_TO_ORIGIN,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      unpushedCommitCount: 0,
      isUnborn: false,
      ...overrides,
    },
    "This Mac",
    existingCopy
  );

describe("describeBranchHandoff", () => {
  it("creates the worktree without asking when the remote has the same tip or more", () => {
    expect(handoff({ kind: "same-tip", remote: "origin", sha: "a" })).toMatchObject({
      summary: "On origin at the same commit",
      choices: [],
      defaultPlan: "worktree",
    });
    expect(handoff({ kind: "behind", remote: "origin", behind: 2, sha: "b" })).toMatchObject({
      summary: "On origin, which has 2 newer commits",
      defaultPlan: "worktree",
    });
  });

  it("offers a push for unpushed commits, naming where git pushes them", () => {
    const result = handoff({ kind: "ahead", remote: "origin", ahead: 3 }, undefined, {
      unpushedCommitCount: 3,
    });
    expect(result.summary).toBe("feature/host-chip has 3 unpushed commits on This Mac");
    expect(result.choices.map((c) => c.plan)).toEqual(["push-then-worktree", "worktree"]);
    expect(result.choices[0]!.label).toBe(
      "Push 3 commits to origin/feature/host-chip, then continue"
    );
    expect(result.choices[0]!.description).toContain("This Mac's credentials");
    expect(result.choices[1]!.label).toBe("Continue from origin's version");
    expect(result.defaultPlan).toBe("worktree");
  });

  it("offers no push when git has no same-named destination for the branch", () => {
    const result = handoff({ kind: "ahead", remote: "origin", ahead: 2 }, undefined, {
      pushDestination: null,
    });
    expect(result.choices).toEqual([]);
    expect(result.detail).toContain("isn't pushed from here");
    expect(result.defaultPlan).toBe("worktree");
    expect(result.tone).toBe("attention");
  });

  it("never offers a push for a diverged branch", () => {
    const result = handoff({ kind: "diverged", remote: "origin" });
    expect(result.summary).toBe("feature/host-chip has diverged from origin on This Mac");
    expect(result.choices).toEqual([]);
    expect(result.defaultPlan).toBe("worktree");
  });

  it("offers to push a branch the remote doesn't have, or to start from the default branch", () => {
    const result = handoff({ kind: "not-on-remote", remote: "origin", upstream: null });
    expect(result.summary).toBe("feature/host-chip only exists on This Mac");
    expect(result.choices.map((c) => c.label)).toEqual([
      "Push feature/host-chip to origin/feature/host-chip, then continue",
      "Start from the default branch",
    ]);
    expect(result.defaultPlan).toBe("no-worktree");
    const nowhere = handoff({ kind: "not-on-remote", remote: null, upstream: null }, undefined, {
      pushDestination: null,
    });
    expect(nowhere.choices.map((c) => c.plan)).toEqual(["no-worktree"]);
  });

  it("never offers to push a branch whose upstream is another branch", () => {
    const result = handoff(
      { kind: "not-on-remote", remote: "origin", upstream: "origin/develop" },
      undefined,
      { pushDestination: null }
    );
    expect(result.detail).toBe(
      "It tracks origin/develop, a different branch, so it isn't pushed from here."
    );
    expect(result.choices.map((c) => c.plan)).toEqual(["no-worktree"]);
  });

  it("opens an existing copy as it is rather than claiming a default branch", () => {
    const result = handoff(
      { kind: "not-on-remote", remote: "origin", upstream: null },
      undefined,
      {},
      true
    );
    expect(result.choices.at(-1)!.label).toBe("Open the copy as it is");
    const detached = handoff({ kind: "detached" }, null, {}, true);
    expect(detached.summary).toBe("No branch is checked out on This Mac (at 01234567)");
    expect(detached.detail).toBe("The copy there opens as it is.");
  });

  it("says a repository with no commits has nothing to hand over", () => {
    const result = handoff({ kind: "not-on-remote", remote: "origin", upstream: null }, undefined, {
      isUnborn: true,
      headSha: null,
    });
    expect(result.summary).toBe("feature/host-chip has no commits on This Mac yet");
    expect(result.choices).toEqual([]);
  });

  it("says what it couldn't reach and carries on with what's known", () => {
    const result = handoff({ kind: "remote-unreachable", remote: "origin", detail: "timed out" });
    expect(result.summary).toBe("Couldn't reach origin from This Mac");
    expect(result.detail).toBe("timed out");
  });

  it("has nothing to hand off with no branch", () => {
    expect(handoff({ kind: "detached" }).defaultPlan).toBe("no-worktree");
    expect(handoff(null, null).choices).toEqual([]);
  });
});

describe("describeCloneFailure", () => {
  it("names the host, keeps git's text and says the host needs its own access", () => {
    const failure = describeCloneFailure({
      reason: "auth-failed",
      message: "Permission denied (publickey).",
      hostName: "studio-01",
      url: "git@github.com:daintreehq/daintree.git",
    });
    expect(failure.title).toBe("studio-01 couldn't clone git@github.com:daintreehq/daintree.git");
    expect(failure.gitText).toBe("Permission denied (publickey).");
    expect(failure.fix).toBe(
      "studio-01 needs its own access to this repo: add an SSH key on studio-01, or connect GitHub on studio-01 (Settings on studio-01 → GitHub)."
    );
  });

  it("keeps the fix generic for forges it doesn't know", () => {
    const failure = describeCloneFailure({
      reason: "repository-not-found",
      message: "not found",
      hostName: "studio-02",
      url: "https://git.example.com/a/b.git",
    });
    expect(failure.fix).toContain("studio-02 needs its own access");
    expect(failure.fix).not.toContain("GitHub");
  });
});

describe("candidateRelation", () => {
  const source = [
    { name: "origin", url: "git@github.com:greg/daintree.git" },
    { name: "upstream", url: "https://github.com/daintreehq/daintree" },
  ];

  it("names the remote a clone matches, without guessing which is a fork", () => {
    expect(
      candidateRelation(
        { remotes: [{ name: "origin", url: "https://github.com/greg/daintree" }] },
        source
      )
    ).toBe("Same repository as your origin");
    expect(
      candidateRelation(
        { remotes: [{ name: "origin", url: "git@github.com:daintreehq/daintree.git" }] },
        source
      )
    ).toBe("Same repository as your upstream");
  });

  it("says nothing when the source tracks one repository", () => {
    expect(
      candidateRelation(
        { remotes: [{ name: "origin", url: "git@github.com:greg/daintree.git" }] },
        [source[0]!]
      )
    ).toBeNull();
  });
});

describe("initialView and hostDisplayName", () => {
  it("opens on what the target has, else the clone, else the local-only copy", () => {
    const candidate = {
      projectId: "p",
      path: "/p",
      name: "p",
      remotes: [],
      source: "registered" as const,
      matchedBy: "remote-url" as const,
      lastOpenedAt: null,
    };
    expect(initialView({ candidates: [candidate], remotes: [] })).toBe("existing");
    expect(
      initialView({
        candidates: [],
        remotes: [{ name: "origin", url: "git@github.com:daintreehq/daintree.git" }],
      })
    ).toBe("clone");
    expect(initialView({ candidates: [], remotes: [] })).toBe("local-only");
  });

  it("sends a copy when the only remotes are on this machine's disk", () => {
    for (const url of ["/srv/git/app.git", "file:///srv/git/app.git", "../app.git"]) {
      expect(initialView({ candidates: [], remotes: [{ name: "origin", url }] })).toBe(
        "local-only"
      );
    }
  });

  it("calls this machine by its local label", () => {
    const hosts = [{ descriptor: { id: "studio-01", name: "Studio" } }];
    expect(hostDisplayName("local", hosts, "This Mac")).toBe("This Mac");
    expect(hostDisplayName("studio-01", hosts, "This Mac")).toBe("Studio");
  });
});

describe("destinationInFolder", () => {
  it("puts the clone's folder inside the picked one, unless the picked one is it", () => {
    expect(destinationInFolder("/data/repos", "/home/g/Projects/daintree", "x")).toBe(
      "/data/repos/daintree"
    );
    expect(destinationInFolder("/data/daintree/", "/home/g/Projects/daintree", "x")).toBe(
      "/data/daintree"
    );
    expect(destinationInFolder("/", "", "daintree")).toBe("/daintree");
  });
});

describe("describePlacedWorktree", () => {
  it("names the base branch and where the worktree goes on the host", () => {
    const base = {
      newBranch: "feature/x",
      baseBranch: "develop",
      fromRemote: true,
      useExistingBranch: false,
      relativePath: "../daintree-worktrees/feature-x",
      recipeId: null,
    };
    expect(describePlacedWorktree(base, "studio-01")).toBe(
      "New branch from develop on the remote, at ../daintree-worktrees/feature-x beside the project."
    );
    expect(
      describePlacedWorktree({ ...base, useExistingBranch: true, relativePath: null }, "studio-01")
    ).toBe("Checks out the existing branch on studio-01, where studio-01 puts new worktrees.");
  });
});

describe("opensWithoutQuestion", () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    projectId: "host-p1",
    path: "/home/greg/code/daintree",
    name: "daintree",
    remotes: [{ name: "origin", url: "https://github.com/daintreehq/daintree" }],
    source: "registered" as const,
    matchedBy: "remote-url" as const,
    lastOpenedAt: null,
    ...overrides,
  });
  const prep = (overrides: Record<string, unknown> = {}) =>
    ({
      candidates: [candidate()],
      branch: "feature/x",
      branchCheck: { kind: "same-tip", remote: "origin", sha: "abc" },
      pushDestination: { remote: "origin", branch: "feature/x" },
      headSha: "abc",
      unpushedCommitCount: 0,
      isUnborn: false,
      hasUncommittedChanges: false,
      usesLfs: false,
      targetGitLfsAvailable: true,
      ...overrides,
    }) as Parameters<typeof opensWithoutQuestion>[0];

  it("opens without asking only when there is exactly nothing to decide", () => {
    expect(opensWithoutQuestion(prep(), false)).toBe(true);
    expect(opensWithoutQuestion(prep(), true)).toBe(false);
    expect(opensWithoutQuestion(prep({ hasUncommittedChanges: true }), false)).toBe(false);
    expect(opensWithoutQuestion(prep({ candidates: [candidate(), candidate()] }), false)).toBe(
      false
    );
    expect(
      opensWithoutQuestion(prep({ candidates: [candidate({ source: "on-disk" })] }), false)
    ).toBe(false);
    expect(
      opensWithoutQuestion(
        prep({ branchCheck: { kind: "ahead", remote: "origin", ahead: 1 } }),
        false
      )
    ).toBe(false);
    expect(opensWithoutQuestion(prep({ usesLfs: true, targetGitLfsAvailable: false }), false)).toBe(
      false
    );
  });

  it("goes straight to the one copy when only navigating, whatever the branch", () => {
    const ahead = prep({
      branchCheck: { kind: "ahead", remote: "origin", ahead: 1 },
      hasUncommittedChanges: true,
    });
    expect(opensWithoutQuestion(ahead, false, true)).toBe(true);
    expect(
      opensWithoutQuestion(prep({ candidates: [candidate(), candidate()] }), false, true)
    ).toBe(false);
    expect(
      opensWithoutQuestion(
        prep({ candidates: [candidate({ matchedBy: "committed-id" })] }),
        false,
        true
      )
    ).toBe(false);
  });

  it("never opens a copy matched only by its committed project id: a fork inherits it", () => {
    expect(
      opensWithoutQuestion(prep({ candidates: [candidate({ matchedBy: "committed-id" })] }), false)
    ).toBe(false);
  });
});
