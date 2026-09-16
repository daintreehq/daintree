import { describe, it, expect } from "vitest";
import {
  bulkRemoveExclusion,
  describeBulkRemoveRisks,
  isBulkRemoveEligible,
  type BulkRemoveTarget,
  type BulkRemoveTargetStatus,
} from "../useWorktreeBulkRemove";
import type { WorktreeDeletePreview } from "../worktreeDeletePreview";
import type { FileChangeDetail } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";

function change(path: string, status: FileChangeDetail["status"]): FileChangeDetail {
  return { path, status, insertions: null, deletions: null };
}

function risk(over: Partial<SubmoduleDeleteRisk> = {}): SubmoduleDeleteRisk {
  return {
    entries: [],
    dirtyFiles: [],
    untrackedFiles: [],
    atRiskCommits: [],
    requiresMechanicalForce: false,
    incomplete: false,
    ...over,
  };
}

function verified(over: Partial<WorktreeDeletePreview> = {}): BulkRemoveTargetStatus {
  const changes = over.changes ?? [];
  return {
    state: "verified",
    preview: {
      trackedChangeCount: changes.filter((c) => c.status !== "untracked" && c.status !== "ignored")
        .length,
      untrackedFileCount: changes.filter((c) => c.status === "untracked").length,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes,
      rootPath: "/tmp/worktrees/retry-jitter",
      submodules: { status: "verified", risk: risk() },
      ...over,
    },
  };
}

function target(over: Partial<BulkRemoveTarget> = {}): BulkRemoveTarget {
  return {
    id: "wt-1",
    name: "retry-jitter",
    branch: "fix/retry-backoff-jitter",
    path: "/tmp/worktrees/retry-jitter",
    aheadCount: 0,
    status: verified(),
    ...over,
  };
}

describe("describeBulkRemoveRisks", () => {
  /**
   * The invariant, asserted over the fresh preview's own counts rather than any
   * wording: every count the confirmation derives has to reach the user.
   *
   * The bug this guards against is a count being derived and silently never
   * rendered — a worktree holding nothing but untracked files rendering as a
   * row with no warning at all (#7880).
   */
  it("surfaces every non-zero count the fresh preview carries", () => {
    // Every count distinct, so no phrase can stand in for another — a bare
    // `toContain("2")` was satisfiable by whichever risk happened to say 2.
    const populated = target({
      aheadCount: 7,
      status: verified({
        changes: [
          ...Array.from({ length: 3 }, (_, i) => change(`t${i}.ts`, "modified")),
          ...Array.from({ length: 5 }, (_, i) => change(`u${i}.ts`, "untracked")),
        ],
        submodules: {
          status: "verified",
          risk: risk({
            dirtyFiles: ["vendor/lib/src/main.c", "vendor/lib/src/util.c"],
            untrackedFiles: [
              "vendor/lib/x.o",
              "vendor/lib/y.o",
              "vendor/lib/z.o",
              "vendor/lib/w.o",
            ],
          }),
        },
      }),
    });
    const line = describeBulkRemoveRisks(populated).join(" · ");

    expect(line, "tracked changes never reached the confirmation").toContain("3 uncommitted files");
    expect(line, "untracked files never reached the confirmation").toContain("5 untracked files");
    expect(line, "unpushed commits never reached the confirmation").toContain("7 unpushed commits");
    // The parent's own status collapses all six nested files into one
    // ` M vendor/lib` row, so this count cannot be derived from the two above.
    expect(line, "nested submodule files never reached the confirmation").toContain(
      "6 files inside submodules"
    );
  });

  it("prefers the fresh ahead count over the cached seed", () => {
    // `getFreshChanges` reports `ahead` from the same `git status --porcelain -b`
    // that produced the file list, so the seed must not win once it has landed.
    const risks = describeBulkRemoveRisks(
      target({ aheadCount: 0, status: verified({ ahead: 3 }) })
    );
    expect(risks).toEqual(["3 unpushed commits"]);
  });

  it("falls back to the seed when git reports no upstream to be ahead of", () => {
    // `ahead` is absent, NOT zero, on a branch with no upstream — reading that
    // as "nothing unpushed" is the misreading the fallback exists to prevent.
    const risks = describeBulkRemoveRisks(target({ aheadCount: 2, status: verified() }));
    expect(risks).toEqual(["2 unpushed commits"]);
  });

  it("reports nothing when nothing is at risk", () => {
    expect(describeBulkRemoveRisks(target())).toEqual([]);
  });

  it("reads the fresh preview, never a cached count", () => {
    // The #12416 regression in one assertion: a target whose preview came back
    // dirty must warn, and the hook no longer carries a cached count that could
    // disagree with it.
    const risks = describeBulkRemoveRisks(
      target({ status: verified({ changes: [change("src/agent.ts", "modified")] }) })
    );
    expect(risks).toEqual(["1 uncommitted file"]);
  });

  it("treats untracked-only work as a risk in its own right", () => {
    // The regression case: a worktree with no tracked changes and no unpushed
    // commits still loses real files when its directory is deleted.
    const risks = describeBulkRemoveRisks(
      target({
        status: verified({ changes: [change("a.log", "untracked"), change("b.log", "untracked")] }),
      })
    );
    expect(risks).toHaveLength(1);
    expect(risks[0]).toContain("2");
  });

  it("asserts no content risk while the preview is still pending", () => {
    // No file count may be claimed before the evidence arrives — the skeleton
    // is the honest state, not a zero.
    expect(describeBulkRemoveRisks(target({ status: { state: "pending" } }))).toEqual([]);
  });

  it("still carries the seeded unpushed count while pending", () => {
    // Deliberate: the seed is the only risk that is already known at open
    // time. The dialog renders a skeleton for a pending row rather than this
    // line, so the contract is the helper's, not the surface's.
    expect(
      describeBulkRemoveRisks(target({ aheadCount: 4, status: { state: "pending" } }))
    ).toEqual(["4 unpushed commits"]);
  });

  it("keeps each risk to its own phrase so they can be joined", () => {
    const risks = describeBulkRemoveRisks(
      target({
        aheadCount: 1,
        status: verified({ changes: [change("a.ts", "modified"), change("b.log", "untracked")] }),
      })
    );
    expect(risks).toHaveLength(3);
    for (const risk of risks) {
      expect(risk).not.toContain("·");
    }
  });

  it("singularises a count of one and pluralises the rest", () => {
    const one = describeBulkRemoveRisks(
      target({ status: verified({ changes: [change("a.log", "untracked")] }) })
    )[0];
    const many = describeBulkRemoveRisks(
      target({
        status: verified({ changes: [change("a.log", "untracked"), change("b.log", "untracked")] }),
      })
    )[0];
    expect(one?.endsWith("s")).toBe(false);
    expect(many?.endsWith("s")).toBe(true);
  });
});

describe("bulkRemoveExclusion", () => {
  it("clears a verified target with a completed, clean submodule inventory", () => {
    const clean = target();
    expect(bulkRemoveExclusion(clean)).toBeNull();
    expect(isBulkRemoveEligible(clean)).toBe(true);
  });

  it("does not exclude a target whose preview has not settled yet", () => {
    // Pending is not an exclusion — it is "not ready". The confirmation is
    // gated as a whole while any target is pending.
    const pending = target({ status: { state: "pending" } });
    expect(bulkRemoveExclusion(pending)).toBeNull();
    expect(isBulkRemoveEligible(pending)).toBe(false);
  });

  it("excludes an already-removed worktree", () => {
    const gone = target({ status: { state: "gone" } });
    expect(bulkRemoveExclusion(gone)).toEqual({ kind: "gone" });
    expect(isBulkRemoveEligible(gone)).toBe(false);
  });

  it("excludes a target whose parent status could not be read — never falls back to cache", () => {
    const failed = target({ status: { state: "failed", submodules: null } });
    expect(bulkRemoveExclusion(failed)).toEqual({ kind: "verify-failed" });
    expect(isBulkRemoveEligible(failed)).toBe(false);
  });

  it("excludes a target holding submodule commits the host refuses to lose", () => {
    // `guardSubmoduleDelete` throws on these BEFORE it reads `force`, so
    // sending one would spend the typed-count consent on a call whose only
    // outcome is a toast.
    const blocked = target({
      status: verified({
        submodules: {
          status: "verified",
          risk: risk({ atRiskCommits: [{ oid: "abc1234def", subject: "wip: vendored fix" }] }),
        },
      }),
    });
    expect(bulkRemoveExclusion(blocked)).toEqual({ kind: "blocked", block: "at-risk-commits" });
    expect(isBulkRemoveEligible(blocked)).toBe(false);
  });

  it("excludes a target whose submodule inventory never completed", () => {
    const incomplete = target({
      status: verified({ submodules: { status: "unverified", risk: risk({ incomplete: true }) } }),
    });
    expect(bulkRemoveExclusion(incomplete)).toEqual({ kind: "blocked", block: "unverified" });
    expect(isBulkRemoveEligible(incomplete)).toBe(false);
  });
});
