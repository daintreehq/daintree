import { describe, expect, it } from "vitest";
import type { BranchCheck } from "@shared/types/ipc/hostSwitch";
import {
  candidateRelation,
  describeBranchHandoff,
  describeCloneFailure,
  describePlacedWorktree,
  destinationInFolder,
  hostDisplayName,
  initialView,
} from "../hostSwitchModel";

const handoff = (branchCheck: BranchCheck | null, branch: string | null = "feature/host-chip") =>
  describeBranchHandoff({ branch, branchCheck }, "This Mac");

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

  it("offers a push for unpushed commits, run on the source with its own credentials", () => {
    const result = handoff({ kind: "ahead", remote: "upstream", ahead: 3 });
    expect(result.summary).toBe("feature/host-chip has 3 unpushed commits on This Mac");
    expect(result.choices.map((c) => c.plan)).toEqual(["push-then-worktree", "worktree"]);
    expect(result.choices[0]!.description).toContain("upstream from This Mac");
    expect(result.defaultPlan).toBe("worktree");
  });

  it("never offers a push for a diverged branch", () => {
    const result = handoff({ kind: "diverged", remote: "origin" });
    expect(result.summary).toBe("feature/host-chip has diverged from origin on This Mac");
    expect(result.choices).toEqual([]);
    expect(result.defaultPlan).toBe("worktree");
  });

  it("offers to push a branch the remote doesn't have, or to start from the default branch", () => {
    const result = handoff({ kind: "not-on-remote", remote: "origin", upstream: "origin/renamed" });
    expect(result.summary).toBe("feature/host-chip only exists on This Mac");
    expect(result.detail).toContain("origin/renamed");
    expect(result.choices.map((c) => c.plan)).toEqual(["push-then-worktree", "no-worktree"]);
    expect(result.defaultPlan).toBe("no-worktree");
    const nowhere = handoff({ kind: "not-on-remote", remote: null, upstream: null });
    expect(nowhere.choices.map((c) => c.plan)).toEqual(["no-worktree"]);
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

  it("marks a clone of the fork and a clone of the upstream", () => {
    expect(
      candidateRelation(
        { remotes: [{ name: "origin", url: "https://github.com/greg/daintree" }] },
        source
      )
    ).toBe("Clone of your fork");
    expect(
      candidateRelation(
        { remotes: [{ name: "origin", url: "git@github.com:daintreehq/daintree.git" }] },
        source
      )
    ).toBe("Clone of upstream");
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
    expect(initialView({ candidates: [], remotes: [{ name: "origin", url: "x" }] })).toBe("clone");
    expect(initialView({ candidates: [], remotes: [] })).toBe("local-only");
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
