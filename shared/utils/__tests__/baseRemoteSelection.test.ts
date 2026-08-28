import { describe, it, expect } from "vitest";
import {
  resolveBaseCompareRef,
  planFetchRemotes,
  parseKnownRemoteBranch,
} from "../baseRemoteSelection.js";

describe("resolveBaseCompareRef", () => {
  it("resolves nothing when the repo has no remotes", () => {
    expect(
      resolveBaseCompareRef({
        baseBranch: "main",
        trackedRef: null,
        remotesWithBaseRef: [],
        availableRemotes: [],
      })
    ).toEqual({ compareRef: null, remote: null });
  });

  it("uses the base branch's own tracking ref over any heuristic", () => {
    const { compareRef, remote } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: "refs/remotes/upstream/main",
      remotesWithBaseRef: ["origin", "upstream"],
      availableRemotes: ["origin", "upstream"],
    });
    expect(compareRef).toBe("upstream/main");
    expect(remote).toBe("upstream");
  });

  it("keeps the tracked ref's own branch name when it differs from the base branch", () => {
    // `branch.develop.merge = refs/heads/main` — the remote branch is named
    // differently, so appending the base branch would build a ref that doesn't
    // exist.
    const { compareRef } = resolveBaseCompareRef({
      baseBranch: "develop",
      trackedRef: "refs/remotes/upstream/main",
      remotesWithBaseRef: [],
      availableRemotes: ["origin", "upstream"],
    });
    expect(compareRef).toBe("upstream/main");
  });

  it("prefers upstream over origin when both carry the base and nothing is configured", () => {
    // The reported bug: origin is the fork, so measuring against it reads ~0
    // behind while the branch trails the canonical repo.
    const { compareRef, remote } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: null,
      remotesWithBaseRef: ["origin", "upstream"],
      availableRemotes: ["origin", "upstream"],
    });
    expect(compareRef).toBe("upstream/main");
    expect(remote).toBe("upstream");
  });

  it("selects origin when it is the only remote carrying the base branch", () => {
    const { compareRef, remote } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: null,
      remotesWithBaseRef: ["origin"],
      availableRemotes: ["origin", "heroku"],
    });
    expect(compareRef).toBe("origin/main");
    expect(remote).toBe("origin");
  });

  it("falls back to listing order when neither preferred name is present", () => {
    const { remote } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: null,
      remotesWithBaseRef: ["mirror", "canonical"],
      availableRemotes: ["mirror", "canonical"],
    });
    expect(remote).toBe("mirror");
  });

  it("preserves a slash-bearing base branch in the compare ref", () => {
    const { compareRef } = resolveBaseCompareRef({
      baseBranch: "release/2.0",
      trackedRef: null,
      remotesWithBaseRef: ["origin"],
      availableRemotes: ["origin"],
    });
    expect(compareRef).toBe("origin/release/2.0");
  });

  it("splits a slash-bearing remote name at the right boundary", () => {
    const { compareRef, remote } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: "refs/remotes/team/fork/main",
      remotesWithBaseRef: [],
      availableRemotes: ["team/fork"],
    });
    expect(remote).toBe("team/fork");
    expect(compareRef).toBe("team/fork/main");
  });

  it("treats the local pseudo-remote as unresolved rather than fetchable", () => {
    // `branch.main.remote = .` tracks another local branch; there is no
    // remote-tracking ref to diff against and nothing to fetch.
    expect(
      resolveBaseCompareRef({
        baseBranch: "main",
        trackedRef: null,
        remotesWithBaseRef: ["."],
        availableRemotes: ["."],
      })
    ).toEqual({ compareRef: null, remote: null });
  });

  it("ignores candidates that are not in the remote table", () => {
    // A leftover refs/remotes/ tree after `git remote remove` must not become
    // a fetch target.
    const { compareRef, remote } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: null,
      remotesWithBaseRef: ["ghost", "origin"],
      availableRemotes: ["origin"],
    });
    expect(remote).toBe("origin");
    expect(compareRef).toBe("origin/main");
  });

  it("ignores a tracked ref whose remote is no longer in the table", () => {
    const { compareRef } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: "refs/remotes/gone/main",
      remotesWithBaseRef: [],
      availableRemotes: ["origin"],
    });
    expect(compareRef).toBeNull();
  });

  it("ignores a tracked ref that is not under refs/remotes", () => {
    const { compareRef } = resolveBaseCompareRef({
      baseBranch: "main",
      trackedRef: "refs/heads/main",
      remotesWithBaseRef: [],
      availableRemotes: ["origin"],
    });
    expect(compareRef).toBeNull();
  });
});

describe("planFetchRemotes", () => {
  it("fetches exactly one remote for a single-remote repo", () => {
    const plan = planFetchRemotes({ baseRemote: "origin", availableRemotes: ["origin"] });
    expect(plan.remotes).toEqual(["origin"]);
    expect(plan.primaryRemote).toBe("origin");
  });

  it("defaults to origin before the first resolution has run", () => {
    const plan = planFetchRemotes({ baseRemote: null, availableRemotes: [] });
    expect(plan.remotes).toEqual(["origin"]);
    expect(plan.primaryRemote).toBe("origin");
  });

  it("fetches the base remote and origin when they differ, base first", () => {
    const plan = planFetchRemotes({
      baseRemote: "upstream",
      availableRemotes: ["origin", "upstream"],
    });
    // Base remote leads: its result is what the card renders, so it must not
    // queue behind a slow auxiliary fetch.
    expect(plan.remotes).toEqual(["upstream", "origin"]);
    expect(plan.primaryRemote).toBe("upstream");
  });

  it("omits origin when the repo does not have one", () => {
    const plan = planFetchRemotes({ baseRemote: "upstream", availableRemotes: ["upstream"] });
    expect(plan.remotes).toEqual(["upstream"]);
  });

  it("does not invent an origin fetch for a repo whose only remote is named otherwise", () => {
    const plan = planFetchRemotes({ baseRemote: null, availableRemotes: ["canonical"] });
    expect(plan.remotes).toEqual(["canonical"]);
    expect(plan.primaryRemote).toBe("canonical");
  });

  it("never repeats a remote", () => {
    const plan = planFetchRemotes({
      baseRemote: "origin",
      availableRemotes: ["origin", "upstream"],
    });
    expect(plan.remotes).toEqual(["origin"]);
  });

  it("leaves deploy-remote layouts fetching only origin", () => {
    // origin genuinely is the code remote; heroku/dokku must stay off the poll
    // loop.
    const plan = planFetchRemotes({
      baseRemote: "origin",
      availableRemotes: ["origin", "heroku", "dokku"],
    });
    expect(plan.remotes).toEqual(["origin"]);
  });
});

describe("parseKnownRemoteBranch", () => {
  it("splits at the remote boundary rather than the first slash", () => {
    expect(parseKnownRemoteBranch("origin/release/1.x", ["origin"])).toEqual({
      remote: "origin",
      branch: "release/1.x",
    });
  });

  it("prefers the longer remote when one name prefixes another", () => {
    // `team` and `team/fork` both prefix this ref; only the longer one leaves a
    // branch the remote actually carries.
    expect(parseKnownRemoteBranch("team/fork/topic", ["team", "team/fork"])).toEqual({
      remote: "team/fork",
      branch: "topic",
    });
  });

  it("returns null for a local branch that merely looks remote-shaped", () => {
    // `origin/develop` is a legal local branch name in a repo with no `origin`.
    expect(parseKnownRemoteBranch("origin/develop", ["upstream"])).toBeNull();
  });

  it("returns null for a bare remote name with no branch after it", () => {
    expect(parseKnownRemoteBranch("origin/", ["origin"])).toBeNull();
    expect(parseKnownRemoteBranch("origin", ["origin"])).toBeNull();
  });

  it("ignores the local pseudo-remote", () => {
    // `branch.<n>.remote = .` tracks a local branch; there is no remote ref.
    expect(parseKnownRemoteBranch("./develop", ["."])).toBeNull();
  });

  it("matches case-sensitively, as git ref names are", () => {
    expect(parseKnownRemoteBranch("Origin/develop", ["origin"])).toBeNull();
  });

  it("returns null when the repository has no remotes at all", () => {
    expect(parseKnownRemoteBranch("origin/develop", [])).toBeNull();
  });
});
