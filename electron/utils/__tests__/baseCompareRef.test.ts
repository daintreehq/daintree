import { describe, it, expect, vi } from "vitest";
import {
  gatherBaseCompareRefInputs,
  gatherBaseCompareRefInputsWithRemoteStatus,
  readRemotes,
  readRemotesCarrying,
  readSymbolicRef,
  resolveExistingBaseCompareTarget,
} from "../baseCompareRef.js";

/**
 * A git double driven by exact argv, so a change that reaches for a different
 * command fails here rather than silently returning the fallback.
 *
 * Anything not matched rejects, which is the honest simulation: git exits
 * non-zero for an unknown ref and simple-git surfaces that as a rejection.
 */
function fakeGit(responses: Record<string, string>) {
  const raw = vi.fn(async (args: string[]) => {
    const key = args.join(" ");
    if (key in responses) return responses[key]!;
    throw new Error(`fatal: unexpected git invocation: ${key}`);
  });
  return { git: { raw }, raw };
}

const FOR_EACH_REF = (remotes: string[], base: string) =>
  ["for-each-ref", "--format=%(refname)", "--", ...remotes.map((r) => `refs/remotes/${r}/${base}`)]
    .join(" ")
    .trim();

describe("readRemotes", () => {
  it("returns trimmed, non-empty remote names", async () => {
    const { git } = fakeGit({ remote: "origin\n  upstream  \n\n" });
    expect(await readRemotes(git)).toEqual(["origin", "upstream"]);
  });

  it("fails soft to an empty list", async () => {
    const { git } = fakeGit({});
    expect(await readRemotes(git)).toEqual([]);
  });
});

describe("readSymbolicRef", () => {
  it("returns the resolved full ref", async () => {
    const { git } = fakeGit({
      "rev-parse --symbolic-full-name develop@{upstream}": "refs/remotes/origin/develop\n",
    });
    expect(await readSymbolicRef(git, "develop@{upstream}")).toBe("refs/remotes/origin/develop");
  });

  it("returns null when the revision has no upstream", async () => {
    const { git } = fakeGit({});
    expect(await readSymbolicRef(git, "develop@{upstream}")).toBeNull();
  });

  it("returns null for empty output rather than an empty ref", async () => {
    const { git } = fakeGit({ "rev-parse --symbolic-full-name @{u}": "  \n" });
    expect(await readSymbolicRef(git, "@{u}")).toBeNull();
  });
});

describe("readRemotesCarrying", () => {
  it("spawns nothing when there are no remotes", async () => {
    const { git, raw } = fakeGit({});
    expect(await readRemotesCarrying(git, "develop", [])).toEqual([]);
    expect(raw).not.toHaveBeenCalled();
  });

  it("finds a remote whose own name contains a slash", async () => {
    // The reason for one literal pattern per remote instead of a glob: git's
    // ref-filter wildcard does not cross `/`, so `team/fork` would never appear.
    const remotes = ["origin", "team/fork"];
    const { git } = fakeGit({
      [FOR_EACH_REF(remotes, "develop")]: "refs/remotes/team/fork/develop\n",
    });
    expect(await readRemotesCarrying(git, "develop", remotes)).toEqual(["team/fork"]);
  });

  it("ignores refs that do not exactly match <remote>/<base>", async () => {
    const remotes = ["origin"];
    const { git } = fakeGit({
      [FOR_EACH_REF(remotes, "develop")]:
        "refs/remotes/origin/develop-old\nrefs/heads/develop\nrefs/remotes/origin/develop\n",
    });
    expect(await readRemotesCarrying(git, "develop", remotes)).toEqual(["origin"]);
  });
});

describe("gatherBaseCompareRefInputs", () => {
  it("distinguishes a repository with no remotes from a failed remote read", async () => {
    const successful = fakeGit({ remote: "" });
    const failed = fakeGit({});

    expect(
      (await gatherBaseCompareRefInputsWithRemoteStatus(successful.git, "develop"))
        .remotesReadSucceeded
    ).toBe(true);
    expect(
      (await gatherBaseCompareRefInputsWithRemoteStatus(failed.git, "develop")).remotesReadSucceeded
    ).toBe(false);
  });

  it("skips the for-each-ref spawn when the base branch tracks something", async () => {
    const { git, raw } = fakeGit({
      remote: "origin\n",
      "rev-parse --symbolic-full-name develop@{upstream}": "refs/remotes/origin/develop\n",
    });
    const inputs = await gatherBaseCompareRefInputs(git, "develop");
    expect(inputs).toEqual({
      baseBranch: "develop",
      trackedRef: "refs/remotes/origin/develop",
      remotesWithBaseRef: [],
      availableRemotes: ["origin"],
    });
    expect(raw.mock.calls.map((c) => c[0][0])).toEqual(["remote", "rev-parse"]);
  });

  it("reads which remotes carry the base branch when it tracks nothing", async () => {
    const remotes = ["origin", "upstream"];
    const { git } = fakeGit({
      remote: "origin\nupstream\n",
      [FOR_EACH_REF(remotes, "main")]: "refs/remotes/upstream/main\n",
    });
    expect(await gatherBaseCompareRefInputs(git, "main")).toEqual({
      baseBranch: "main",
      trackedRef: null,
      remotesWithBaseRef: ["upstream"],
      availableRemotes: remotes,
    });
  });
});

describe("resolveExistingBaseCompareTarget", () => {
  it("prefers the base branch's own tracking ref and names it both ways", async () => {
    const { git } = fakeGit({
      remote: "origin\nupstream\n",
      "rev-parse --symbolic-full-name develop@{upstream}": "refs/remotes/upstream/develop\n",
      "rev-parse --verify --quiet refs/remotes/upstream/develop^{commit}": "abc123\n",
    });
    expect(await resolveExistingBaseCompareTarget(git, "develop")).toEqual({
      compareRef: "upstream/develop",
      fullRef: "refs/remotes/upstream/develop",
      remote: "upstream",
    });
  });

  it("defaults an unresolved ref to origin/<base>, exactly as the behind count does", async () => {
    // `BaseDivergence.compute()` uses `resolution?.compareRef ?? origin/<base>`.
    // Anything else here would target a different commit from the one the card
    // measured, with nothing on screen to give it away.
    const { git } = fakeGit({
      remote: "origin\n",
      // No tracking ref and no for-each-ref hit, so the resolver declines.
      "rev-parse --verify --quiet refs/remotes/origin/develop^{commit}": "def456\n",
    });
    expect(await resolveExistingBaseCompareTarget(git, "develop")).toEqual({
      compareRef: "origin/develop",
      fullRef: "refs/remotes/origin/develop",
      remote: "origin",
    });
  });

  it("skips origin and falls straight to LOCAL when a resolved ref is pruned", async () => {
    // The case a third `origin/<base>` rung would have quietly changed. The
    // base tracks `upstream/develop`, that ref is gone, and `origin/develop`
    // exists — `compute()` falls through to the local branch here, so this must
    // too, or the badge counts against `develop` while the menu rebases onto
    // `origin/develop`.
    const remotes = ["origin", "upstream"];
    const { git } = fakeGit({
      remote: "origin\nupstream\n",
      [FOR_EACH_REF(remotes, "develop")]: "refs/remotes/upstream/develop\n",
      "rev-parse --verify --quiet refs/remotes/origin/develop^{commit}": "def456\n",
      "rev-parse --verify --quiet refs/heads/develop^{commit}": "aaa111\n",
    });
    expect(await resolveExistingBaseCompareTarget(git, "develop")).toEqual({
      compareRef: "develop",
      fullRef: "refs/heads/develop",
      remote: null,
    });
  });

  it("falls back to the LOCAL base branch in a repo with no remote", async () => {
    // The no-remote case the issue calls out: rebasing ONTO a local `develop`
    // from a linked worktree is fine — only writing to it is refused.
    const { git } = fakeGit({
      remote: "",
      "rev-parse --verify --quiet refs/heads/develop^{commit}": "aaa111\n",
    });
    expect(await resolveExistingBaseCompareTarget(git, "develop")).toEqual({
      compareRef: "develop",
      fullRef: "refs/heads/develop",
      remote: null,
    });
  });

  it("returns null rather than guessing when nothing resolves", async () => {
    // Fail-closed: every rung was tried and none exists. Handing back an
    // unverified `origin/<base>` would be the reassuring answer and the wrong
    // one (#11746).
    const { git } = fakeGit({ remote: "origin\n" });
    expect(await resolveExistingBaseCompareTarget(git, "develop")).toBeNull();
  });

  it("never offers a bare short ref to argv — every candidate is fully qualified", async () => {
    // A branch named like a flag must be unrepresentable as one. Both prefixes
    // guarantee that, so this asserts the property rather than one example.
    const { git } = fakeGit({
      remote: "",
      "rev-parse --verify --quiet refs/heads/--force^{commit}": "bbb222\n",
    });
    const target = await resolveExistingBaseCompareTarget(git, "--force");
    expect(target?.fullRef.startsWith("refs/")).toBe(true);
    expect(target?.fullRef.startsWith("-")).toBe(false);
  });

  it("peels to a commit, so a tag-shaped ref is not offered as a rebase target", async () => {
    // Behavioural, not a suffix check: the double answers ONLY the peeled
    // spelling, so a resolver that dropped `^{commit}` would find nothing and
    // return null instead of this target.
    const { git, raw } = fakeGit({
      remote: "",
      "rev-parse --verify --quiet refs/heads/develop^{commit}": "ccc333\n",
    });
    expect(await resolveExistingBaseCompareTarget(git, "develop")).toEqual({
      compareRef: "develop",
      fullRef: "refs/heads/develop",
      remote: null,
    });
    const verifyCalls = raw.mock.calls
      .map((c) => c[0] as string[])
      .filter((args) => args[0] === "rev-parse" && args[1] === "--verify");
    expect(verifyCalls.length).toBeGreaterThan(0);
  });
});
