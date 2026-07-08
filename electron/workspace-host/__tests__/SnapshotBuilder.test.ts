import { describe, it, expect } from "vitest";
import { SnapshotBuilder, type SnapshotBuilderHost } from "../SnapshotBuilder.js";

function makeHost(overrides: Partial<SnapshotBuilderHost> = {}): SnapshotBuilderHost {
  return {
    id: "/test/worktree",
    path: "/test/worktree",
    name: "worktree",
    branch: "feature/x",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: undefined,
    summary: undefined,
    modifiedCount: undefined,
    mood: undefined,
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
    lastFetchedAt: null,
    lastGitStatusCheckedAt: 0,
    fetchAuthFailed: false,
    fetchNetworkFailed: false,
    isFetchInFlight: false,
    matchedForgeProviderId: null,
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

  it("reads isFetchInFlight live from the host at build time", () => {
    const host = makeHost({ isFetchInFlight: true });
    const snapshot = new SnapshotBuilder(host).build();

    expect(snapshot.isFetchInFlight).toBe(true);
  });

  it("suppresses worktreeMode when local and surfaces it otherwise", () => {
    expect(new SnapshotBuilder(makeHost({ worktreeMode: "local" })).build().worktreeMode).toBe(
      undefined
    );
    expect(
      new SnapshotBuilder(makeHost({ worktreeMode: "remote" })).build().worktreeMode
    ).toBe("remote");
  });
});
