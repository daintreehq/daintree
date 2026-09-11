import { describe, expect, it } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { PluginWorktreeLinked } from "@shared/types/plugin";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

// Host-minted versions are now `(epoch, seq)` tuples (#8403). Tests mint a
// monotonic seq under a fixed epoch; each fresh store starts at epoch "" so
// the first non-empty epoch is always accepted as an epoch transition.
const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

function makeSnapshot(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    name: id,
    branch: "main",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    changes: [],
    summary: "",
    mood: null,
    gitDir: "",
    ...overrides,
  } as unknown as WorktreeSnapshot;
}

describe("createWorktreeStore — manual issue associations (#8079)", () => {
  it("starts with an empty manualAssociations map", () => {
    const store = createWorktreeStore();
    expect(store.getState().manualAssociations.size).toBe(0);
  });

  it("applySnapshot merges associations over auto-detected issue (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 11, issueTitle: "Auto detected" })],
        nextV(),
        { "wt-1": { issueNumber: 42, issueTitle: "Manual issue" } }
      );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
  });

  it("applyUpdate preserves a manual association the snapshot omits", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    // A worktree-update with no issue fields must NOT clobber the manual assoc.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(wt?.branch).toBe("feature/x");
  });

  it("setManualAssociation re-merges the existing snapshot immediately", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().setManualAssociation("wt-1", { issueNumber: 99, issueTitle: "Attached" });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(99);
    expect(wt?.issueTitle).toBe("Attached");
  });

  it("clearManualAssociation stops resurrecting the issue on the next update", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    store.getState().clearManualAssociation("wt-1");
    store.getState().applyUpdate(makeSnapshot("wt-1", { issueNumber: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBeUndefined();
    expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
  });

  it("preserves the previous title when the issue number is unchanged", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 7, issueTitle: "Loaded title" })],
        nextV()
      );

    // Poll re-fetch drops the title but keeps the same issue number.
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 7, issueTitle: undefined }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.issueTitle).toBe("Loaded title");
  });

  it("clears the title when the issue number changes", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { issueNumber: 7, issueTitle: "Old title" })], nextV());

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 8, issueTitle: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(8);
    expect(wt?.issueTitle).toBeUndefined();
  });

  it("applySnapshot without associations preserves the cached map", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    // A later refresh whose association IPC failed passes `undefined`.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "feature/x" })], nextV());

    expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(42);
    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/x");
  });

  it("a stale-version applySnapshot does not revert a newer applyUpdate", () => {
    const store = createWorktreeStore();
    // Version minted while the snapshot data was "fresh".
    const snapshotVersion = nextV();
    // A worktree-update races ahead during the association fetch.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/new" }), nextV());

    // The now-stale snapshot tries to apply with the older version.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "old" })], snapshotVersion);

    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/new");
  });

  it("manual association overrides an issue-detected-style update (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
    store.getState().setManualAssociation("wt-1", { issueNumber: 42, issueTitle: "Manual" });

    // issue-detected builds a snapshot with a different (auto) issue.
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 99, issueTitle: "Auto detected" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual");
  });

  it("setFatalError drops cached manual associations", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    store.getState().setFatalError("host crashed");

    expect(store.getState().manualAssociations.size).toBe(0);
    expect(store.getState().isInitialized).toBe(false);
  });
});

describe("createWorktreeStore — linked PR preservation (#8870)", () => {
  function makePr(number: number, title: string): PluginWorktreeLinked["pr"] {
    return {
      ref: { providerId: "github", owner: "acme", repo: "demo", number, rawData: null },
      title,
      url: `https://example/pr/${number}`,
      state: "open",
    };
  }

  const linkedWithPr: PluginWorktreeLinked = {
    providerId: "github",
    pr: makePr(123, "Fix the thing"),
  };

  it("preserves existing linked.pr when an update omits the linked field", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // Startup-race scenario: a worktree-update fires before initializePRService
    // populates `_linked`. The host emits the snapshot without a `linked` key.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked).toEqual(linkedWithPr);
    expect(wt?.branch).toBe("feature/x");
  });

  it("preserves existing linked.pr when an update has linked: undefined", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { branch: "feature/x", linked: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked).toEqual(linkedWithPr);
  });

  it("clears existing linked when an update has linked: null (explicit clear)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // Branch switch -> WorktreeMonitor.clearLinked() emits `linked: null`.
    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: null }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();
  });

  it("replaces existing linked when an update carries a different linked object", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    const replacement: PluginWorktreeLinked = {
      providerId: "github",
      pr: makePr(456, "New PR"),
    };
    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: replacement }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toEqual(replacement);
  });

  it("clears existing linked when a later null arrives after a series of omitted updates", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // PR service hasn't run yet — several updates omit `linked`.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "a" }), nextV());
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "b" }), nextV());
    expect(store.getState().worktrees.get("wt-1")?.linked).toEqual(linkedWithPr);

    // PR service finally finishes and reports "no PR found" — host emits null.
    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: null }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();
  });

  it("preserves linked.pr when applySnapshot omits the linked field", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // A later get-all-states snapshot during the startup window omits `linked`.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "feature/x" })], nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked).toEqual(linkedWithPr);
    expect(wt?.branch).toBe("feature/x");
  });

  it("preserves an explicit null clear through a subsequent undefined update", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: null }), nextV());
    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();

    // A later update with `linked` omitted must not resurrect the prior linked object.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();
  });
});

describe("createWorktreeStore — issue number carried by the linked PR (#12381)", () => {
  function githubPr(number: number): PluginWorktreeLinked {
    return {
      providerId: BUILTIN_GITHUB_PROVIDER_ID,
      pr: {
        ref: {
          providerId: BUILTIN_GITHUB_PROVIDER_ID,
          owner: "daintreehq",
          repo: "daintree",
          number,
          rawData: null,
        },
        url: `https://github.com/daintreehq/daintree/pull/${number}`,
        state: "open",
      },
    };
  }

  it("drops a parsed issue number the linked GitHub PR carries", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot(
      [
        makeSnapshot("wt-1", {
          issueNumber: 12189,
          branchDerivedTitle: "Native assistant",
          issueLastUpdatedAt: 1_700_000_000_000,
          linked: githubPr(12189),
        }),
      ],
      nextV()
    );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBeUndefined();
    expect(wt?.branchDerivedTitle).toBeUndefined();
    expect(wt?.issueLastUpdatedAt).toBeUndefined();
    expect(wt?.linked?.pr?.ref.number).toBe(12189);
  });

  it("drops it when an update omits linked and the stored row carries the PR", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: githubPr(12189) })], nextV());

    store.getState().applyUpdate(makeSnapshot("wt-1", { issueNumber: 12189 }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBeUndefined();
  });

  it("lets a manual association with the PR's number win (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 12189, linked: githubPr(12189) })],
        nextV(),
        { "wt-1": { issueNumber: 12189, issueTitle: "Chosen by hand" } }
      );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(12189);
    expect(wt?.issueTitle).toBe("Chosen by hand");
  });

  it("keeps equal numbers on a forge that numbers merge requests separately", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot(
      [
        makeSnapshot("wt-1", {
          issueNumber: 12,
          linked: {
            providerId: "acme.gitlab",
            pr: {
              ref: {
                providerId: "acme.gitlab",
                owner: "acme",
                repo: "demo",
                number: 12,
                rawData: null,
              },
              url: "https://gitlab.acme.test/acme/demo/-/merge_requests/12",
              state: "open",
            },
          },
        }),
      ],
      nextV()
    );

    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(12);
  });
});
