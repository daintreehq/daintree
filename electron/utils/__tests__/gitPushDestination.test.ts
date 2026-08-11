import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import {
  resolveGitPushDestination,
  formatGitPushDestination,
  describeUnresolvedPushDestination,
  describeUnresolvedUpstream,
} from "../gitPushDestination.js";
import { classifyGitError } from "../../../shared/utils/gitOperationErrors.js";

/**
 * Real git fixtures rather than mocks: the whole point of this resolver is that
 * git owns the push-destination precedence chain, so a mock asserting our idea
 * of that chain would prove nothing about the case #11746 reports. Follows the
 * isolation pattern in `hardenedGit.hooks.test.ts`.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

let tmpRoot: string;
let bareCounter = 0;

function makeBare(): string {
  const dir = path.join(tmpRoot, `bare-${++bareCounter}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--bare", "-q"]);
  return dir;
}

/** A repo with one commit on `topic` and no push configuration at all. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "topic"]);
  return dir;
}

function resolve(repo: string, branch = "topic") {
  return resolveGitPushDestination(simpleGit(repo), branch);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-dest-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveGitPushDestination — precedence", () => {
  it("prefers branch.<name>.pushRemote over remote.pushDefault and branch.<name>.remote", async () => {
    const repo = makeRepo();
    git(repo, ["remote", "add", "publish", makeBare()]);
    git(repo, ["remote", "add", "mirror", makeBare()]);
    git(repo, ["remote", "add", "upstream", makeBare()]);
    git(repo, ["config", "branch.topic.pushRemote", "publish"]);
    git(repo, ["config", "remote.pushDefault", "mirror"]);
    git(repo, ["config", "branch.topic.remote", "upstream"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/topic"]);
    git(repo, ["config", "push.default", "current"]);

    const result = await resolve(repo);

    expect(result).toEqual({
      status: "resolved",
      destination: {
        remote: "publish",
        branch: "topic",
        remoteTrackingRef: "refs/remotes/publish/topic",
      },
    });
  });

  it("falls to remote.pushDefault when the branch names no pushRemote", async () => {
    const repo = makeRepo();
    git(repo, ["remote", "add", "upstream", makeBare()]);
    git(repo, ["remote", "add", "mirror", makeBare()]);
    git(repo, ["config", "remote.pushDefault", "mirror"]);
    git(repo, ["config", "branch.topic.remote", "upstream"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/topic"]);
    git(repo, ["config", "push.default", "current"]);

    const result = await resolve(repo);

    expect(result.status).toBe("resolved");
    expect(result.status === "resolved" && result.destination.remote).toBe("mirror");
  });

  it("refuses when push.default=nothing names a remote but no destination", async () => {
    // git deliberately has no default push destination here; assuming the
    // same-name branch would invent one it never sanctioned.
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "fork", makeBare()]);
    git(repo, ["config", "branch.topic.pushRemote", "fork"]);
    git(repo, ["config", "branch.topic.remote", "origin"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/release/topic"]);
    git(repo, ["config", "push.default", "nothing"]);

    const result = await resolve(repo);

    expect(result).toEqual({ status: "unresolved", reason: "not-configured" });
  });

  it("resolves from remote.pushDefault alone, with no branch config at all", async () => {
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "mirror", makeBare()]);
    git(repo, ["config", "remote.pushDefault", "mirror"]);
    git(repo, ["config", "push.default", "current"]);

    const result = await resolve(repo);

    expect(result.status === "resolved" && result.destination).toEqual({
      remote: "mirror",
      branch: "topic",
      remoteTrackingRef: "refs/remotes/mirror/topic",
    });
  });

  it("falls to branch.<name>.remote when nothing else is set", async () => {
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "upstream", makeBare()]);
    git(repo, ["config", "branch.topic.remote", "upstream"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/topic"]);

    const result = await resolve(repo);

    expect(result.status === "resolved" && result.destination.remote).toBe("upstream");
  });
});

describe("resolveGitPushDestination — remote-side branch name", () => {
  it("keeps the local name under push.default=current even when branch.merge differs", async () => {
    // The trap this resolver exists to avoid: deriving the remote branch from
    // `branch.<name>.merge` would wrongly say `release/topic` here.
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "fork", makeBare()]);
    git(repo, ["config", "branch.topic.pushRemote", "fork"]);
    git(repo, ["config", "branch.topic.remote", "origin"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/release/topic"]);
    git(repo, ["config", "push.default", "current"]);

    const result = await resolve(repo);

    expect(result.status === "resolved" && result.destination).toEqual({
      remote: "fork",
      branch: "topic",
      remoteTrackingRef: "refs/remotes/fork/topic",
    });
  });

  it("uses the merge ref under push.default=upstream, where remotename and push ref disagree", async () => {
    // git reports remotename `fork` while rendering the push ref under the
    // FETCH remote (`refs/remotes/origin/release/topic`). Stripping the
    // remotename off the short form would call this repo unresolvable.
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "fork", makeBare()]);
    git(repo, ["config", "branch.topic.pushRemote", "fork"]);
    git(repo, ["config", "branch.topic.remote", "origin"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/release/topic"]);
    git(repo, ["config", "push.default", "upstream"]);

    const result = await resolve(repo);

    expect(result.status).toBe("resolved");
    expect(result.status === "resolved" && result.destination.remote).toBe("fork");
    expect(result.status === "resolved" && result.destination.branch).toBe("release/topic");
    // The tracking ref follows the PUSH remote, not the fetch remote git named
    // in `%(push)` — leasing or previewing against origin's ref would describe
    // a repository this push never touches.
    expect(result.status === "resolved" && result.destination.remoteTrackingRef).toBe(
      "refs/remotes/fork/release/topic"
    );
  });

  it("resolves a remote whose own name contains a slash without splitting it", async () => {
    // No sibling `team` remote: git refuses to create one alongside `team/fork`
    // ("is a subset of existing remote"). The longest-match logic is covered by
    // the stubbed cases below, which don't go through git's naming rules.
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "team/fork", makeBare()]);
    git(repo, ["config", "branch.topic.pushRemote", "team/fork"]);
    git(repo, ["config", "branch.topic.merge", "refs/heads/topic"]);
    git(repo, ["config", "push.default", "current"]);

    const result = await resolve(repo);

    expect(result.status === "resolved" && result.destination).toEqual({
      remote: "team/fork",
      branch: "topic",
      remoteTrackingRef: "refs/remotes/team/fork/topic",
    });
  });
});

describe("resolveGitPushDestination — fails closed", () => {
  it("uses the sole remote when the branch has no configuration", async () => {
    // The fresh-worktree-branch state. One remote is the only answer the repo
    // has, not a guess, and the D2 confirm renders it before anything is written.
    const repo = makeRepo();
    git(repo, ["remote", "add", "fork", makeBare()]);

    const result = await resolve(repo);

    expect(result.status === "resolved" && result.destination).toEqual({
      remote: "fork",
      branch: "topic",
      remoteTrackingRef: "refs/remotes/fork/topic",
    });
  });

  it("refuses an unconfigured branch when several remotes exist, even with an origin", async () => {
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "fork", makeBare()]);

    const result = await resolve(repo);

    expect(result).toEqual({ status: "unresolved", reason: "ambiguous" });
  });

  it("refuses when the repository has no remotes", async () => {
    const result = await resolve(makeRepo());

    expect(result).toEqual({ status: "unresolved", reason: "not-configured" });
  });

  it("refuses a branch that does not exist", async () => {
    const repo = makeRepo();
    git(repo, ["remote", "add", "origin", makeBare()]);
    git(repo, ["remote", "add", "fork", makeBare()]);

    const result = await resolve(repo, "no-such-branch");

    expect(result.status).toBe("unresolved");
  });

  it("refuses a detached HEAD without invoking git", async () => {
    const result = await resolveGitPushDestination(
      {
        raw: () => {
          throw new Error("must not run git for a detached HEAD");
        },
        getRemotes: () => {
          throw new Error("must not run git for a detached HEAD");
        },
      } as never,
      "HEAD"
    );

    expect(result).toEqual({ status: "unresolved", reason: "not-configured" });
  });
});

describe("resolveGitPushDestination — argv hardening", () => {
  // Driven through a stub: git itself rejects most of these at config time, but
  // the guard has to hold for a config file written by hand or by another tool.
  const stub = (remoteName: string, pushRef: string) =>
    ({
      raw: async () => `refs/heads/topic\u0000${remoteName}\u0000${pushRef}`,
      getRemotes: async () => [{ name: remoteName, refs: { fetch: "", push: "" } }],
    }) as never;

  it.each([
    ["--upload-pack=touch /tmp/pwned", "leading double dash"],
    ["-x", "leading dash"],
    ["re mote", "embedded space"],
    ["re\tmote", "embedded tab"],
    [`re${String.fromCharCode(127)}mote`, "embedded DEL"],
    [`re${String.fromCharCode(0x85)}mote`, "embedded C1"],
  ])("refuses the remote name %j (%s)", async (name) => {
    const result = await resolveGitPushDestination(
      stub(name, `refs/remotes/${name}/topic`),
      "topic"
    );

    expect(result).toEqual({ status: "unresolved", reason: "unsafe-remote" });
  });

  it("refuses a padded remote name rather than normalizing it to a different remote", async () => {
    // `" origin"` and `"origin"` can be two remotes pointing at two different
    // repositories. Trimming the field before validating would silently
    // redirect the write to the wrong one — the original #11746 failure.
    const result = await resolveGitPushDestination(
      {
        raw: async () => "refs/heads/topic\u0000 origin\u0000refs/remotes/ origin/topic",
        getRemotes: async () => [
          { name: " origin", refs: { fetch: "", push: "" } },
          { name: "origin", refs: { fetch: "", push: "" } },
        ],
      } as never,
      "topic"
    );

    expect(result).toEqual({ status: "unresolved", reason: "unsafe-remote" });
  });

  it("refuses a remote name carrying the field separator itself", async () => {
    // A NUL can't reach us intact through a NUL-delimited format — it splits the
    // record — so this is refused as a malformed ref rather than an unsafe name.
    // What matters is that it is refused and never reaches argv.
    const name = `re${String.fromCharCode(0)}mote`;
    const result = await resolveGitPushDestination(
      stub(name, `refs/remotes/${name}/topic`),
      "topic"
    );

    expect(result.status).toBe("unresolved");
  });

  it("refuses a remote git names but does not list", async () => {
    const result = await resolveGitPushDestination(
      {
        raw: async () => "refs/heads/topic\u0000ghost\u0000refs/remotes/ghost/topic",
        getRemotes: async () => [{ name: "origin", refs: { fetch: "", push: "" } }],
      } as never,
      "topic"
    );

    expect(result).toEqual({ status: "unresolved", reason: "invalid-push-ref" });
  });

  it("refuses a push ref outside the remote-tracking namespace", async () => {
    const result = await resolveGitPushDestination(
      {
        raw: async () => "refs/heads/topic\u0000origin\u0000refs/heads/topic",
        getRemotes: async () => [{ name: "origin", refs: { fetch: "", push: "" } }],
      } as never,
      "topic"
    );

    expect(result).toEqual({ status: "unresolved", reason: "invalid-push-ref" });
  });

  it("picks the exact branch record when a sibling ref shares its name as a prefix", async () => {
    // `refs/heads/topic` as a for-each-ref pattern also matches
    // `refs/heads/topic/sub`, so the record has to be selected by exact refname
    // rather than assumed to be the only one. Stubbed because git itself
    // refuses to create `topic/sub` while `topic` exists — but the resolver
    // reads whatever refs a repo already has, including from other tools.
    const result = await resolveGitPushDestination(
      {
        raw: async () =>
          [
            "refs/heads/topic/sub\u0000fork\u0000refs/remotes/fork/topic/sub",
            "refs/heads/topic\u0000origin\u0000refs/remotes/origin/topic",
          ].join("\n"),
        getRemotes: async () => [
          { name: "origin", refs: { fetch: "", push: "" } },
          { name: "fork", refs: { fetch: "", push: "" } },
        ],
      } as never,
      "topic"
    );

    expect(result.status === "resolved" && result.destination).toEqual({
      remote: "origin",
      branch: "topic",
      remoteTrackingRef: "refs/remotes/origin/topic",
    });
  });

  it("strips the longest matching remote, not the first path segment", async () => {
    // Defensive: modern git refuses to create `team/fork` alongside `team`, but
    // the prefix walk must not depend on that rule holding for every repo it
    // reads, so it matches the longest remote rather than splitting on `/`.
    const result = await resolveGitPushDestination(
      {
        raw: async () => `refs/heads/topic\u0000team/fork\u0000refs/remotes/team/fork/topic`,
        getRemotes: async () => [
          { name: "team", refs: { fetch: "", push: "" } },
          { name: "team/fork", refs: { fetch: "", push: "" } },
        ],
      } as never,
      "topic"
    );

    expect(result.status === "resolved" && result.destination).toEqual({
      remote: "team/fork",
      branch: "topic",
      remoteTrackingRef: "refs/remotes/team/fork/topic",
    });
  });

  it("allows a legitimate slash-bearing remote name through the guard", async () => {
    const result = await resolveGitPushDestination(
      stub("team/fork", "refs/remotes/team/fork/topic"),
      "topic"
    );

    expect(result.status).toBe("resolved");
  });
});

describe("formatGitPushDestination", () => {
  it("joins remote and branch, preserving slashes on both sides", () => {
    expect(formatGitPushDestination({ remote: "team/fork", branch: "release/topic" })).toBe(
      "team/fork/release/topic"
    );
  });
});

describe("describeUnresolvedPushDestination", () => {
  it("names the branch in every reason", () => {
    const reasons = ["not-configured", "ambiguous", "unsafe-remote", "invalid-push-ref"] as const;
    for (const reason of reasons) {
      expect(describeUnresolvedPushDestination(reason, "topic")).toContain("topic");
    }
  });
});

describe("describeUnresolvedUpstream", () => {
  const reasons = ["not-configured", "ambiguous", "unsafe-remote", "invalid-push-ref"] as const;

  it("names the branch in every reason and never mentions pushing", () => {
    for (const reason of reasons) {
      const message = describeUnresolvedUpstream(reason, "topic");
      expect(message).toContain("topic");
      expect(message).not.toMatch(/push/i);
    }
  });

  it("stays inside the config-missing bucket so the renderer keeps its recovery hint", () => {
    for (const reason of reasons) {
      expect(classifyGitError(new Error(describeUnresolvedUpstream(reason, "topic")))).toBe(
        "config-missing"
      );
    }
  });
});
