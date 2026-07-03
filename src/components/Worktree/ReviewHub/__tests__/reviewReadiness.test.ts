import { describe, it, expect } from "vitest";
import type { StagingStatus } from "@shared/types";
import {
  deriveReviewReadiness,
  type ReviewReadinessInput,
  type ReviewReadinessItemId,
} from "../reviewReadiness";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: true,
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
  ...overrides,
});

const derive = (input: Partial<ReviewReadinessInput> & Pick<ReviewReadinessInput, "status">) =>
  deriveReviewReadiness(input);

const itemIds = (items: { id: ReviewReadinessItemId }[]) => items.map((i) => i.id);

const allIds = (summary: ReturnType<typeof deriveReviewReadiness>) => [
  ...itemIds(summary.blockers),
  ...itemIds(summary.warnings),
  ...itemIds(summary.infos),
];

describe("deriveReviewReadiness", () => {
  it("returns unknown with empty items when status has not loaded", () => {
    const summary = derive({ status: null });
    expect(summary.level).toBe("unknown");
    expect(summary.commitReady).toBe(false);
    expect(summary.pushReady).toBe(false);
    expect(summary.prReady).toBe("unknown");
    expect(summary.blockers).toEqual([]);
    expect(summary.warnings).toEqual([]);
    expect(summary.infos).toEqual([]);
    expect(summary.nextActions).toEqual([]);
  });

  it("reports ready for a staged-and-clean worktree with nothing blocking", () => {
    const summary = derive({
      status: makeStatus({ unstaged: [] }),
      aheadCount: 0,
      behindCount: 0,
    });
    expect(summary.level).toBe("ready");
    expect(summary.commitReady).toBe(true);
    expect(summary.blockers).toEqual([]);
    expect(summary.warnings).toEqual([]);
  });

  it("flags a worktree with no remote as info and never push-ready", () => {
    const summary = derive({
      status: makeStatus({ hasRemote: false }),
      aheadCount: 3,
      behindCount: 0,
    });
    expect(summary.pushReady).toBe(false);
    expect(summary.prReady).toBe(false);
    expect(itemIds(summary.infos)).toContain("no-remote");
    // No remote means no PR could exist — pr-missing would be noise.
    expect(allIds(summary)).not.toContain("pr-missing");
  });

  describe("blockers", () => {
    it("reports conflicts as a blocker with a focus action and suppresses nothing-staged", () => {
      const summary = derive({
        status: makeStatus({
          staged: [],
          conflicted: ["src/a.ts", "src/b.ts"],
          conflictedFiles: [
            { path: "src/a.ts", xy: "UU", label: "both modified" },
            { path: "src/b.ts", xy: "UU", label: "both modified" },
          ],
        }),
      });
      expect(summary.level).toBe("blocked");
      expect(summary.commitReady).toBe(false);
      const conflict = summary.blockers.find((i) => i.id === "conflicts");
      expect(conflict).toBeDefined();
      expect(conflict!.label).toBe("2 conflicted files");
      expect(conflict!.action).toEqual({ kind: "focus-conflicts" });
      expect(allIds(summary)).not.toContain("nothing-staged");
    });

    it("folds conflicts into the operation item during a rebase", () => {
      const summary = derive({
        status: makeStatus({
          repoState: "REBASING",
          rebaseStep: 2,
          rebaseTotalSteps: 5,
          conflicted: ["src/a.ts"],
          conflictedFiles: [{ path: "src/a.ts", xy: "UU", label: "both modified" }],
        }),
      });
      expect(itemIds(summary.blockers)).toEqual(["operation-in-progress"]);
      expect(summary.blockers[0]!.label).toBe("Rebase in progress");
      expect(summary.blockers[0]!.detail).toBe("Step 2 of 5 · 1 conflicted file");
      expect(summary.commitReady).toBe(false);
      expect(summary.pushReady).toBe(false);
    });

    it("labels merge, cherry-pick, and revert operations", () => {
      for (const [repoState, label] of [
        ["MERGING", "Merge in progress"],
        ["CHERRY_PICKING", "Cherry-pick in progress"],
        ["REVERTING", "Revert in progress"],
      ] as const) {
        const summary = derive({ status: makeStatus({ repoState }) });
        expect(summary.blockers[0]!.label).toBe(label);
      }
    });

    it("blocks on detached HEAD", () => {
      const summary = derive({
        status: makeStatus({ isDetachedHead: true, currentBranch: null }),
      });
      expect(summary.level).toBe("blocked");
      expect(summary.commitReady).toBe(false);
      expect(itemIds(summary.blockers)).toContain("detached-head");
    });

    it("blocks on a push failure with a recovery hint as detail", () => {
      const summary = derive({
        status: makeStatus(),
        pushError: { reason: "auth-failed" },
      });
      expect(summary.level).toBe("blocked");
      const item = summary.blockers.find((i) => i.id === "push-failed");
      expect(item).toBeDefined();
      expect(item!.detail).toBeTruthy();
      expect(summary.pushReady).toBe(false);
    });

    it("orders conflicts before detached HEAD before push failure", () => {
      const summary = derive({
        status: makeStatus({
          isDetachedHead: true,
          conflicted: ["src/a.ts"],
          conflictedFiles: [{ path: "src/a.ts", xy: "UU", label: "both modified" }],
        }),
        pushError: { reason: "unknown" },
      });
      expect(itemIds(summary.blockers)).toEqual(["conflicts", "detached-head", "push-failed"]);
    });
  });

  describe("divergence", () => {
    it("warns when behind the remote with a pull-rebase action", () => {
      const summary = derive({
        status: makeStatus(),
        aheadCount: 1,
        behindCount: 2,
      });
      const item = summary.warnings.find((i) => i.id === "behind-remote");
      expect(item).toBeDefined();
      expect(item!.label).toBe("Behind remote by 2 commits");
      expect(item!.detail).toBe("1 local commit will be replayed on top");
      expect(item!.action).toEqual({ kind: "pull-rebase" });
      expect(summary.pushReady).toBe(false);
      expect(summary.level).toBe("needs-review");
    });

    it("suppresses the behind-remote row when the push banner already reports the rejection", () => {
      const summary = derive({
        status: makeStatus(),
        aheadCount: 1,
        behindCount: 2,
        pushError: { reason: "push-rejected-outdated" },
      });
      expect(allIds(summary)).not.toContain("behind-remote");
      expect(itemIds(summary.blockers)).toContain("push-failed");
    });

    it("omits the pull-rebase action during an in-progress operation", () => {
      const summary = derive({
        status: makeStatus({ repoState: "MERGING" }),
        behindCount: 2,
      });
      const item = summary.warnings.find((i) => i.id === "behind-remote");
      expect(item!.action).toBeUndefined();
    });

    it("is push-ready with unpushed commits and a clean tree", () => {
      const summary = derive({
        status: makeStatus({ staged: [], unstaged: [], repoState: "CLEAN" }),
        aheadCount: 2,
        behindCount: 0,
      });
      expect(summary.pushReady).toBe(true);
      const item = summary.infos.find((i) => i.id === "unpushed-commits");
      expect(item!.label).toBe("2 commits not pushed");
    });

    it("is not push-ready when ahead/behind counts are unknown", () => {
      const summary = derive({ status: makeStatus({ staged: [], unstaged: [] }) });
      expect(summary.pushReady).toBe(false);
      expect(allIds(summary)).not.toContain("unpushed-commits");
      expect(allIds(summary)).not.toContain("behind-remote");
    });

    it("is not push-ready when only the behind count is unknown", () => {
      // Unknown divergence must never read as pushable, even with known ahead.
      const summary = derive({
        status: makeStatus({ staged: [], unstaged: [], repoState: "CLEAN" }),
        aheadCount: 2,
      });
      expect(summary.pushReady).toBe(false);
    });
  });

  describe("PR and CI signals", () => {
    const pr = (
      overrides?: Partial<NonNullable<ReviewReadinessInput["pr"]>>
    ): NonNullable<ReviewReadinessInput["pr"]> => ({
      number: 42,
      url: "https://example.com/pr/42",
      state: "open",
      ...overrides,
    });

    it("warns on failing CI with an open-pr action and blocks pr-readiness", () => {
      const summary = derive({ status: makeStatus(), pr: pr({ ciState: "failure" }) });
      const item = summary.warnings.find((i) => i.id === "ci-failing");
      expect(item!.label).toBe("CI failing on PR #42");
      expect(item!.action).toEqual({ kind: "open-pr", url: "https://example.com/pr/42" });
      expect(summary.prReady).toBe(false);
    });

    it("reports pending CI as info and pr-readiness unknown", () => {
      const summary = derive({ status: makeStatus(), pr: pr({ ciState: "pending" }) });
      expect(itemIds(summary.infos)).toContain("ci-pending");
      expect(summary.prReady).toBe("unknown");
    });

    it("never reports pr-ready from missing forge data", () => {
      // CI green but the review decision never arrived — "unknown", not true.
      expect(derive({ status: makeStatus(), pr: pr({ ciState: "success" }) }).prReady).toBe(
        "unknown"
      );
      // Review approved but draft status never arrived.
      expect(
        derive({
          status: makeStatus(),
          pr: pr({ ciState: "success", reviewDecision: "APPROVED" }),
        }).prReady
      ).toBe("unknown");
      // No CI data at all.
      expect(derive({ status: makeStatus(), pr: pr() }).prReady).toBe("unknown");
      // Linked-PR data absent entirely on a remote-tracking branch.
      expect(derive({ status: makeStatus(), pr: null }).prReady).toBe("unknown");
    });

    it("is pr-ready when CI passes, the PR is not a draft, and review is approved or not required", () => {
      expect(
        derive({
          status: makeStatus(),
          pr: pr({ ciState: "success", isDraft: false, reviewDecision: "APPROVED" }),
        }).prReady
      ).toBe(true);
      expect(
        derive({
          status: makeStatus(),
          pr: pr({ ciState: "success", isDraft: false, reviewDecision: null }),
        }).prReady
      ).toBe(true);
    });

    it("surfaces requested changes as a warning and required review as info", () => {
      const changes = derive({
        status: makeStatus(),
        pr: pr({ reviewDecision: "CHANGES_REQUESTED" }),
      });
      expect(itemIds(changes.warnings)).toContain("review-changes-requested");
      expect(changes.prReady).toBe(false);

      const required = derive({
        status: makeStatus(),
        pr: pr({ reviewDecision: "REVIEW_REQUIRED" }),
      });
      expect(itemIds(required.infos)).toContain("review-required");
      expect(required.prReady).toBe(false);
    });

    it("treats a draft PR as not pr-ready", () => {
      const summary = derive({ status: makeStatus(), pr: pr({ isDraft: true }) });
      expect(itemIds(summary.infos)).toContain("pr-draft");
      expect(summary.prReady).toBe(false);
    });

    it("reports merged and closed PRs distinctly", () => {
      const merged = derive({ status: makeStatus(), pr: pr({ state: "merged" }) });
      expect(itemIds(merged.infos)).toContain("pr-merged");
      expect(merged.prReady).toBe(false);

      const closed = derive({ status: makeStatus(), pr: pr({ state: "closed" }) });
      expect(itemIds(closed.warnings)).toContain("pr-closed");
      expect(closed.prReady).toBe(false);
    });

    it("skips CI/review items when the PR is not open", () => {
      const summary = derive({
        status: makeStatus(),
        pr: pr({ state: "merged", ciState: "failure", reviewDecision: "CHANGES_REQUESTED" }),
      });
      expect(allIds(summary)).not.toContain("ci-failing");
      expect(allIds(summary)).not.toContain("review-changes-requested");
    });

    it("omits the open-pr action when no URL is available", () => {
      const summary = derive({
        status: makeStatus(),
        pr: pr({ url: undefined, ciState: "failure" }),
      });
      const item = summary.warnings.find((i) => i.id === "ci-failing");
      expect(item!.action).toBeUndefined();
    });

    it("suggests a PR only when there is shippable work", () => {
      const withWork = derive({ status: makeStatus(), aheadCount: 0 });
      expect(itemIds(withWork.infos)).toContain("pr-missing");

      const clean = derive({
        status: makeStatus({ staged: [], unstaged: [], repoState: "CLEAN" }),
        aheadCount: 0,
        behindCount: 0,
      });
      expect(allIds(clean)).not.toContain("pr-missing");
    });
  });

  describe("forge provider health", () => {
    it("warns when auth is unhealthy or the provider is rate limited", () => {
      const summary = derive({
        status: makeStatus(),
        providerHealth: { rateLimitBlocked: true, tokenUnhealthy: true },
      });
      expect(itemIds(summary.warnings)).toEqual(
        expect.arrayContaining(["forge-auth-unhealthy", "forge-rate-limited"])
      );
      expect(summary.level).toBe("needs-review");
    });

    it("stays quiet when provider health is unknown", () => {
      const summary = derive({ status: makeStatus(), providerHealth: null });
      expect(allIds(summary)).not.toContain("forge-auth-unhealthy");
      expect(allIds(summary)).not.toContain("forge-rate-limited");
    });
  });

  describe("working-tree composition", () => {
    it("reports nothing-staged as a warning so the chip never reads Ready while commit-blocked", () => {
      const summary = derive({ status: makeStatus({ staged: [] }) });
      const item = summary.warnings.find((i) => i.id === "nothing-staged");
      expect(item!.detail).toBe("1 changed file");
      expect(item!.action).toEqual({ kind: "focus-staged" });
      expect(summary.commitReady).toBe(false);
      expect(summary.level).toBe("needs-review");
    });

    it("warns when every change is a generated file", () => {
      const summary = derive({
        status: makeStatus({
          staged: [
            { path: "package-lock.json", status: "modified", insertions: 100, deletions: 3 },
          ],
          unstaged: [{ path: "dist/bundle.js", status: "modified", insertions: 50, deletions: 1 }],
        }),
      });
      expect(itemIds(summary.warnings)).toContain("generated-only");
    });

    it("does not warn generated-only when source files changed too", () => {
      const summary = derive({
        status: makeStatus({
          staged: [
            { path: "package-lock.json", status: "modified", insertions: 100, deletions: 3 },
            { path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 },
          ],
        }),
      });
      expect(allIds(summary)).not.toContain("generated-only");
    });

    it("mentions the protected branch only when there are changes to commit", () => {
      const withChanges = derive({ status: makeStatus({ currentBranch: "develop" }) });
      expect(itemIds(withChanges.infos)).toContain("protected-branch");

      const clean = derive({
        status: makeStatus({
          currentBranch: "develop",
          staged: [],
          unstaged: [],
          repoState: "CLEAN",
        }),
      });
      expect(allIds(clean)).not.toContain("protected-branch");

      const featureBranch = derive({ status: makeStatus() });
      expect(allIds(featureBranch)).not.toContain("protected-branch");
    });
  });

  describe("next actions", () => {
    it("keeps next actions in blocker-first priority order", () => {
      const summary = derive({
        status: makeStatus({
          conflicted: ["src/a.ts"],
          conflictedFiles: [{ path: "src/a.ts", xy: "UU", label: "both modified" }],
        }),
        behindCount: 2,
        pr: { number: 7, url: "https://example.com/pr/7", state: "open", ciState: "failure" },
      });
      expect(summary.nextActions.map((i) => i.id)).toEqual([
        "conflicts",
        "behind-remote",
        "ci-failing",
      ]);
    });
  });

  describe("boundary values", () => {
    it("uses singular labels for single counts", () => {
      const summary = derive({
        status: makeStatus({
          staged: [],
          conflicted: ["src/a.ts"],
          conflictedFiles: [{ path: "src/a.ts", xy: "UU", label: "both modified" }],
        }),
        behindCount: 1,
      });
      expect(summary.blockers[0]!.label).toBe("1 conflicted file");
      expect(summary.warnings.find((i) => i.id === "behind-remote")!.label).toBe(
        "Behind remote by 1 commit"
      );
    });

    it("handles thousands of changed files without conflating counts", () => {
      const unstaged = Array.from({ length: 2500 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        status: "modified" as const,
        insertions: 1,
        deletions: 0,
      }));
      const summary = derive({ status: makeStatus({ staged: [], unstaged }) });
      expect(summary.warnings.find((i) => i.id === "nothing-staged")!.detail).toBe(
        "2500 changed files"
      );
    });

    it("treats zero behind/ahead as no divergence", () => {
      const summary = derive({ status: makeStatus(), aheadCount: 0, behindCount: 0 });
      expect(allIds(summary)).not.toContain("behind-remote");
      expect(allIds(summary)).not.toContain("unpushed-commits");
      expect(summary.pushReady).toBe(false);
    });
  });
});
