import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { PR } from "../../../../shared/types/forge.js";
import {
  evaluateMergedWorktrees,
  type ListedWorktree,
  type MergedWorktreeReads,
} from "../evaluateMergedWorktrees.js";

// Independent of the production constant, so a changed grace fails here.
const DAY = 24 * 60 * 60 * 1000;
const HEAD = "a".repeat(40);
const MERGED_AT = 1_700_000_000_000;
const NOW = MERGED_AT + DAY + 1;
const WT = path.resolve("/repo-worktrees/feature-x");

const main: ListedWorktree = {
  path: "/repo",
  branch: "develop",
  bare: false,
  isMainWorktree: true,
};
const feature: ListedWorktree = {
  path: WT,
  branch: "feature/x",
  bare: false,
  isMainWorktree: false,
};

function pr(overrides: Partial<PR> = {}): PR {
  return {
    number: 42,
    title: "Add x",
    body: "",
    state: "merged",
    rawState: "MERGED",
    isDraft: false,
    merged: true,
    url: "https://forge.test/o/r/pull/42",
    author: { login: "someone" },
    baseRef: "develop",
    headRef: "feature/x",
    headSha: HEAD,
    createdAt: MERGED_AT - 1000,
    updatedAt: MERGED_AT,
    // Later than the merge, so a grace counted from the close would still wait.
    closedAt: MERGED_AT + DAY,
    mergedAt: MERGED_AT,
    rawData: null,
    ...overrides,
  } as PR;
}

function reads(overrides: Partial<MergedWorktreeReads> = {}): MergedWorktreeReads {
  return {
    pathExists: vi.fn(async () => true),
    readGitDir: vi.fn(async () => "/repo/.git/worktrees/feature-x"),
    readStamp: vi.fn(async () => ({ createdAt: 1, branch: "feature/x" })),
    readStatus: vi.fn(async () => ({
      headOid: HEAD,
      branch: "feature/x",
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      changedEntries: 0,
      hiddenFromStatus: 0,
    })),
    countTerminals: vi.fn(async () => ({ count: 0, complete: true })),
    readSavedLayout: vi.fn(async () => ({ panels: [] })),
    resolveForge: vi.fn(async () => ({
      findPRByBranch: vi.fn(async () => pr()),
      getPR: vi.fn(async () => pr()),
    })),
    now: () => NOW,
    ...overrides,
  };
}

async function judge(overrides: Partial<MergedWorktreeReads> = {}) {
  const [result] = await evaluateMergedWorktrees([main, feature], reads(overrides));
  return result;
}

describe("evaluateMergedWorktrees", () => {
  it("finds a clean Daintree worktree removable a day after its PR merged at HEAD", async () => {
    const result = await judge();
    expect(result).toEqual({
      worktreePath: WT,
      branch: "feature/x",
      status: "removable",
      head: HEAD,
      pr: { number: 42, title: "Add x", url: pr().url, mergedAt: MERGED_AT },
    });
  });

  it("never lists the main or a bare worktree", async () => {
    const results = await evaluateMergedWorktrees(
      [main, { ...feature, path: "/bare", bare: true }],
      reads()
    );
    expect(results).toEqual([]);
  });

  it("waits until 24 hours after the forge's mergedAt, counted exactly", async () => {
    const early = await judge({ now: () => MERGED_AT + DAY - 1 });
    expect(early).toMatchObject({ status: "waiting", removableAt: MERGED_AT + DAY });
    const onTheDot = await judge({ now: () => MERGED_AT + DAY });
    expect(onTheDot.status).toBe("removable");
  });

  it.each([
    ["detached", { reads: {}, worktree: { ...feature, branch: "" } }],
    ["missing", { reads: { pathExists: vi.fn(async () => false) } }],
    ["not-created-by-daintree", { reads: { readStamp: vi.fn(async () => null) } }],
  ] as const)("skips a %s worktree", async (reason, setup) => {
    const worktree = "worktree" in setup ? setup.worktree : feature;
    const [result] = await evaluateMergedWorktrees([worktree], reads(setup.reads));
    expect(result).toMatchObject({ status: "skipped", reason });
  });

  it.each(["staged", "unstaged", "untracked", "conflicted", "hiddenFromStatus"] as const)(
    "skips a worktree with %s entries",
    async (field) => {
      const result = await judge({
        readStatus: vi.fn(async () => ({
          headOid: HEAD,
          branch: "feature/x",
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
          changedEntries: 0,
          hiddenFromStatus: 0,
          [field]: 1,
        })),
      });
      expect(result).toMatchObject({ status: "skipped", reason: "has-changes" });
    }
  );

  it("skips a worktree any terminal record sits in, and one the census couldn't place", async () => {
    expect(
      await judge({ countTerminals: vi.fn(async () => ({ count: 1, complete: true })) })
    ).toMatchObject({ reason: "has-terminals" });
    expect(
      await judge({ countTerminals: vi.fn(async () => ({ count: 0, complete: false })) })
    ).toMatchObject({ reason: "unverified" });
  });

  it("skips a worktree with a saved panel, by worktree id or by folder, and the active one", async () => {
    expect(
      await judge({ readSavedLayout: vi.fn(async () => ({ panels: [{ worktreeId: WT }] })) })
    ).toMatchObject({ reason: "has-panels" });
    expect(
      await judge({
        readSavedLayout: vi.fn(async () => ({
          panels: [{ cwd: path.join(WT, "packages", "app") }],
        })),
      })
    ).toMatchObject({ reason: "has-panels" });
    expect(
      await judge({
        readSavedLayout: vi.fn(async () => ({ panels: [{ cwd: path.join(WT, "..cache") }] })),
      })
    ).toMatchObject({ reason: "has-panels" });
    expect(
      await judge({
        readSavedLayout: vi.fn(async () => ({
          panels: [{ worktreeId: "/moved/away", worktreeGitDir: "/repo/.git/worktrees/feature-x" }],
        })),
      })
    ).toMatchObject({ reason: "has-panels" });
    expect(
      await judge({
        readSavedLayout: vi.fn(async () => ({
          panels: [{ cwd: `${WT}-other`, worktreeGitDir: "/repo/.git/worktrees/other" }],
        })),
      })
    ).toMatchObject({ status: "removable" });
    expect(
      await judge({ readSavedLayout: vi.fn(async () => ({ panels: [], activeWorktreeId: WT })) })
    ).toMatchObject({ reason: "active" });
  });

  it("skips when the branch has no PR, an unmerged PR, or a PR whose head isn't HEAD", async () => {
    const forge = (found: PR | null, fresh: PR | null) =>
      vi.fn(async () => ({
        findPRByBranch: vi.fn(async () => found),
        getPR: vi.fn(async () => fresh),
      }));
    expect(await judge({ resolveForge: forge(null, null) })).toMatchObject({ reason: "no-pr" });
    expect(
      await judge({ resolveForge: forge(pr(), pr({ state: "open", merged: false })) })
    ).toMatchObject({ reason: "pr-not-merged" });
    expect(
      await judge({ resolveForge: forge(pr(), pr({ state: "closed", merged: false })) })
    ).toMatchObject({ reason: "pr-not-merged" });
    expect(
      await judge({ resolveForge: forge(pr(), pr({ state: "merged", merged: false })) })
    ).toMatchObject({ reason: "pr-not-merged" });
    expect(
      await judge({ resolveForge: forge(pr(), pr({ state: "open", merged: true })) })
    ).toMatchObject({ reason: "pr-not-merged" });
    expect(
      await judge({ resolveForge: forge(pr(), pr({ headSha: "b".repeat(40) })) })
    ).toMatchObject({ reason: "head-moved", pr: { number: 42 } });
  });

  it("decides on the PR read by number, not the branch search's copy", async () => {
    const getPR = vi.fn(async () => pr({ state: "open", merged: false }));
    const result = await judge({
      resolveForge: vi.fn(async () => ({ findPRByBranch: vi.fn(async () => pr()), getPR })),
    });
    expect(getPR).toHaveBeenCalledWith(42);
    expect(result).toMatchObject({ reason: "pr-not-merged" });
  });

  it("compares the forge's head case-insensitively", async () => {
    const result = await judge({
      resolveForge: vi.fn(async () => ({
        findPRByBranch: vi.fn(async () => pr()),
        getPR: vi.fn(async () => pr({ headSha: HEAD.toUpperCase() })),
      })),
    });
    expect(result.status).toBe("removable");
  });

  it.each([
    ["no head commit", { headSha: undefined }],
    ["a short head commit", { headSha: "abc1234" }],
    ["no merge time", { mergedAt: null }],
    ["another head branch", { headRef: "feature/y" }],
  ] as const)("leaves a PR with %s unverified", async (_label, overrides) => {
    const result = await judge({
      resolveForge: vi.fn(async () => ({
        findPRByBranch: vi.fn(async () => pr()),
        getPR: vi.fn(async () => pr(overrides as Partial<PR>)),
      })),
    });
    expect(result).toMatchObject({ status: "skipped", reason: "unverified" });
  });

  it.each([
    ["the git dir", { readGitDir: vi.fn(async () => Promise.reject(new Error("boom"))) }],
    ["the stamp", { readStamp: vi.fn(async () => Promise.reject(new Error("malformed"))) }],
    ["the status", { readStatus: vi.fn(async () => Promise.reject(new Error("timeout"))) }],
    ["the census", { countTerminals: vi.fn(async () => Promise.reject(new Error("shard"))) }],
    ["the layout", { readSavedLayout: vi.fn(async () => Promise.reject(new Error("bad"))) }],
    ["the forge", { resolveForge: vi.fn(async () => Promise.reject(new Error("no auth"))) }],
  ] as const)("fails closed when %s can't be read", async (_label, overrides) => {
    const result = await judge(overrides as Partial<MergedWorktreeReads>);
    expect(result).toMatchObject({ status: "skipped", reason: "unverified" });
    expect(result.status === "skipped" && result.detail).toBeTruthy();
  });

  it("leaves a worktree unverified when status names another branch than the list", async () => {
    const result = await judge({
      readStatus: vi.fn(async () => ({
        headOid: HEAD,
        branch: "feature/other",
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        changedEntries: 0,
        hiddenFromStatus: 0,
      })),
    });
    expect(result).toMatchObject({ reason: "unverified" });
  });

  it("reads the forge only for worktrees that pass the local checks, and resolves it once", async () => {
    const findPRByBranch = vi.fn(async () => pr());
    const resolveForge = vi.fn(async () => ({
      findPRByBranch,
      getPR: vi.fn(async () => pr()),
    }));
    const dirty = { ...feature, path: "/repo-worktrees/dirty", branch: "feature/dirty" };
    const results = await evaluateMergedWorktrees(
      [feature, dirty, { ...feature, path: "/repo-worktrees/x2" }],
      reads({
        resolveForge,
        readStatus: vi.fn(async (worktreePath: string) => ({
          headOid: HEAD,
          branch: worktreePath.endsWith("dirty") ? "feature/dirty" : "feature/x",
          staged: worktreePath.endsWith("dirty") ? 1 : 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
          changedEntries: 0,
          hiddenFromStatus: 0,
        })),
      })
    );
    expect(results.map((result) => result.status)).toEqual(["removable", "skipped", "removable"]);
    expect(resolveForge).toHaveBeenCalledTimes(1);
    expect(findPRByBranch.mock.calls).toEqual([["feature/x"], ["feature/x"]]);
  });

  describe("the host's own refusals", () => {
    it("lists a worktree the host would refuse as skipped, keeping its PR", async () => {
      const readHostRefusal = vi.fn(async () => "teardown" as const);
      const result = await judge({ readHostRefusal });
      expect(readHostRefusal).toHaveBeenCalledWith(WT);
      expect(result).toMatchObject({ status: "skipped", reason: "teardown", pr: { number: 42 } });
      expect(
        await judge({ readHostRefusal: vi.fn(async () => "submodules" as const) })
      ).toMatchObject({ reason: "submodules" });
    });

    it("keeps a worktree the host would take, or that no running host can be asked about", async () => {
      expect((await judge({ readHostRefusal: vi.fn(async () => null) })).status).toBe("removable");
      expect(
        (await judge({ readHostRefusal: vi.fn(async () => null), now: () => MERGED_AT })).status
      ).toBe("waiting");
    });

    it("leaves the worktree unverified when the host can't say, and asks only about ones that qualify", async () => {
      expect(
        await judge({ readHostRefusal: vi.fn(async () => Promise.reject(new Error("unreadable"))) })
      ).toMatchObject({ reason: "unverified" });
      const readHostRefusal = vi.fn(async () => null);
      await judge({ readHostRefusal, readStamp: vi.fn(async () => null) });
      expect(readHostRefusal).not.toHaveBeenCalled();
    });
  });
});
