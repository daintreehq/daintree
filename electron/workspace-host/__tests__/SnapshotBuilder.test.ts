import { describe, it, expect } from "vitest";
import { SnapshotBuilder, type SnapshotBuilderHost } from "../SnapshotBuilder.js";

function makeHost(overrides: Partial<SnapshotBuilderHost> = {}): SnapshotBuilderHost {
  return {
    id: "/test/worktree",
    generation: 1,
    path: "/test/worktree",
    name: "worktree",
    branch: "feature/x",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: undefined,
    summary: undefined,
    modifiedCount: 0,
    mood: "stable",
    lastActivityTimestamp: null,
    createdAt: undefined,
    aiNote: undefined,
    aiNoteTimestamp: undefined,
    issueNumber: undefined,
    prNumber: undefined,
    prUrl: undefined,
    prState: undefined,
    prCiStatus: undefined,
    prTitle: undefined,
    issueTitle: undefined,
    branchDerivedTitle: undefined,
    sourcePrNumber: undefined,
    prLastUpdatedAt: undefined,
    issueLastUpdatedAt: undefined,
    worktreeChanges: null,
    lifecycleStatus: undefined,
    setupStatus: undefined,
    lifecyclePhaseResults: [],
    resourceStatus: undefined,
    resourceConnectCommand: undefined,
    resourceProvider: undefined,
    hasResourceConfig: false,
    hasStatusCommand: false,
    hasPauseCommand: false,
    hasResumeCommand: false,
    hasTeardownCommand: false,
    hasProvisionCommand: false,
    worktreeMode: "local",
    worktreeEnvironmentLabel: undefined,
    hasPlanFile: false,
    planFilePath: undefined,
    aheadCount: undefined,
    behindCount: undefined,
    baseBranchName: null,
    baseAheadCount: null,
    baseBehindCount: null,
    baseMatchesUpstream: undefined,
    baseCompareRef: null,
    lastFetchedAt: null,
    lastGitStatusCheckedAt: 0,
    workingTreeChangedAt: 0,
    workingTreeChangedDirs: undefined,
    fetchAuthFailed: false,
    fetchNetworkFailed: false,
    isFetchInFlight: false,
    matchedForgeProviderId: null,
    isExternal: undefined,
    isWslPath: false,
    wslDistro: undefined,
    wslPosixPath: undefined,
    wslGitEligible: "unprobed",
    wslGitOptIn: false,
    wslGitDismissed: false,
    linked: undefined,
    repoState: undefined,
    isDetached: false,
    head: undefined,
    ...overrides,
  };
}

describe("SnapshotBuilder", () => {
  it("falls back to legacy flat PR/issue fields when linked is absent", () => {
    const host = makeHost({ prNumber: 42, prTitle: "Legacy PR", issueNumber: 7 });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.prNumber).toBe(42);
    expect(snapshot.prTitle).toBe("Legacy PR");
    expect(snapshot.issueNumber).toBe(7);
  });

  it("prefers linked PR/issue fields over legacy flat fields when linked is present", () => {
    const host = makeHost({
      prNumber: 42,
      prTitle: "Legacy PR",
      issueNumber: 7,
      linked: {
        pr: {
          ref: { number: 99 },
          url: "https://example.com/pr/99",
          title: "Linked PR",
          state: "open",
        },
        issue: { ref: { number: 13 }, title: "Linked issue" },
      } as unknown as SnapshotBuilderHost["linked"],
    });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.prNumber).toBe(99);
    expect(snapshot.prTitle).toBe("Linked PR");
    expect(snapshot.prState).toBe("open");
    expect(snapshot.issueNumber).toBe(13);
    expect(snapshot.issueTitle).toBe("Linked issue");
  });

  it("maps a linked PR's declined state to closed", () => {
    const host = makeHost({
      linked: {
        pr: {
          ref: { number: 99 },
          url: "https://example.com/pr/99",
          title: "Linked PR",
          state: "declined",
        },
        issue: undefined,
      } as unknown as SnapshotBuilderHost["linked"],
    });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.prState).toBe("closed");
  });

  it("maps a legacy flat declined prState to closed when linked is absent", () => {
    const host = makeHost({
      prState: "declined" as unknown as SnapshotBuilderHost["prState"],
    });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.prState).toBe("closed");
  });

  it("merges resource status with the resource provider", () => {
    const host = makeHost({
      resourceStatus: { state: "running" } as unknown as SnapshotBuilderHost["resourceStatus"],
      resourceProvider: "docker",
    });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.resourceStatus).toEqual({ state: "running", provider: "docker" });
  });

  it("synthesizes a provider-only resource status when resourceStatus is absent", () => {
    const host = makeHost({ resourceProvider: "docker" });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.resourceStatus).toEqual({ provider: "docker" });
  });

  it("omits boolean capability flags when false and includes them when true", () => {
    const falseHost = makeHost();
    expect(new SnapshotBuilder(falseHost).build().hasResourceConfig).toBeUndefined();

    const trueHost = makeHost({ hasResourceConfig: true });
    expect(new SnapshotBuilder(trueHost).build().hasResourceConfig).toBe(true);
  });

  it("copies lifecyclePhaseResults defensively and omits when empty", () => {
    const results = [{ phase: "teardown", status: "success" }] as unknown as NonNullable<
      SnapshotBuilderHost["lifecyclePhaseResults"]
    >;
    const host = makeHost({ lifecyclePhaseResults: results });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.lifecyclePhaseResults).toEqual(results);
    expect(snapshot.lifecyclePhaseResults).not.toBe(results);

    const emptyHost = makeHost({ lifecyclePhaseResults: [] });
    expect(new SnapshotBuilder(emptyHost).build().lifecyclePhaseResults).toBeUndefined();
  });

  it("suppresses WSL fields for non-WSL worktrees but surfaces them when isWslPath", () => {
    const nonWsl = makeHost({ isWslPath: false, wslGitEligible: "eligible" });
    expect(new SnapshotBuilder(nonWsl).build().wslGitEligible).toBeUndefined();

    const wsl = makeHost({ isWslPath: true, wslGitEligible: "eligible" });
    const snapshot = new SnapshotBuilder(wsl).build();
    expect(snapshot.isWslPath).toBe(true);
    expect(snapshot.wslGitEligible).toBe("eligible");
  });

  it("reads isFetchInFlight live from the host at build time, not cached at construction", () => {
    // Object spread (used by makeHost's `{...overrides}` merge) evaluates
    // getters eagerly, so a live getter can't be passed as an override —
    // attach it directly to the already-built host instead.
    let isFetchInFlight = false;
    const host = makeHost();
    Object.defineProperty(host, "isFetchInFlight", { get: () => isFetchInFlight });
    const builder = new SnapshotBuilder(host);

    expect(builder.build().isFetchInFlight).toBeUndefined();

    isFetchInFlight = true;
    expect(builder.build().isFetchInFlight).toBe(true);
  });

  it("suppresses worktreeMode when local and surfaces it otherwise", () => {
    expect(new SnapshotBuilder(makeHost({ worktreeMode: "local" })).build().worktreeMode).toBe(
      undefined
    );
    expect(new SnapshotBuilder(makeHost({ worktreeMode: "remote" })).build().worktreeMode).toBe(
      "remote"
    );
  });

  it("keeps the affected directories' three answers apart on the wire", () => {
    // Absent, `null` and `[]` mean different things to the file browser — "no
    // burst described", "burst unclassifiable, re-read everything" and "a real
    // burst that touched nothing" — so none of them may collapse into another.
    expect(new SnapshotBuilder(makeHost()).build().workingTreeChangedDirs).toBeUndefined();
    // Suppressed while there is no stamp for them to belong to, even if the
    // monitor happens to be holding a set.
    const unstamped = makeHost({ workingTreeChangedDirs: ["src"] });
    expect(new SnapshotBuilder(unstamped).build().workingTreeChangedDirs).toBeUndefined();

    const uncertain = makeHost({
      workingTreeChangedAt: 1_725_000_000_000,
      workingTreeChangedDirs: null,
    });
    expect(new SnapshotBuilder(uncertain).build().workingTreeChangedDirs).toBeNull();

    const empty = makeHost({ workingTreeChangedAt: 1_725_000_000_000, workingTreeChangedDirs: [] });
    expect(new SnapshotBuilder(empty).build().workingTreeChangedDirs).toEqual([]);

    const known = makeHost({
      workingTreeChangedAt: 1_725_000_000_000,
      workingTreeChangedDirs: ["src/panels", ""],
    });
    expect(new SnapshotBuilder(known).build().workingTreeChangedDirs).toEqual(["src/panels", ""]);
  });

  it("omits workingTreeChangedAt until a fs write is observed, then surfaces it", () => {
    // 0 → undefined keeps the snapshot lean for a worktree that has never seen a
    // raw fs write; a real stamp passes straight through for the store side map.
    expect(new SnapshotBuilder(makeHost()).build().workingTreeChangedAt).toBeUndefined();

    const stamped = makeHost({ workingTreeChangedAt: 1_725_000_000_000 });
    expect(new SnapshotBuilder(stamped).build().workingTreeChangedAt).toBe(1_725_000_000_000);
  });

  it("carries the monitor's incarnation stamp onto the snapshot", () => {
    // The renderer's removal tombstone compares this to tell a re-created
    // worktree apart from a buffered update for the path's previous monitor
    // (#11994), so it has to survive snapshot construction.
    const host = makeHost({ generation: 7 });
    expect(new SnapshotBuilder(host).build().generation).toBe(host.generation);
  });

  it("passes isExternal through without collapsing false into undefined", () => {
    // Unlike the neighbouring `|| undefined` flags, false ("inside the boundary")
    // and undefined ("boundary unknown") are distinct states downstream.
    expect(new SnapshotBuilder(makeHost({ isExternal: true })).build().isExternal).toBe(true);
    expect(new SnapshotBuilder(makeHost({ isExternal: false })).build().isExternal).toBe(false);
    expect(
      new SnapshotBuilder(makeHost({ isExternal: undefined })).build().isExternal
    ).toBeUndefined();
  });
});
