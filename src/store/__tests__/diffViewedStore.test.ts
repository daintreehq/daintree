import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type {
  FileChangeDetail,
  StagingFileEntry,
  StagingStatus,
  WorktreeSnapshot,
} from "@shared/types";
import { useDiffViewedStore, selectViewedSet } from "../diffViewedStore";
import { useWorktreeSelectionStore } from "../worktreeStore";
import {
  resetStoreAccessorsForTesting,
  setViewedMarkSourcesAccessor,
  type ViewedMarkSources,
} from "../storeAccessors";

describe("diffViewedStore", () => {
  beforeEach(() => {
    useDiffViewedStore.setState({ viewedByWorktree: {}, baselinesByWorktree: {} });
  });

  it("marks and unmarks keys per worktree", () => {
    const { setViewed } = useDiffViewedStore.getState();
    setViewed("/wt-a", "staged:src/a.ts", true);
    setViewed("/wt-b", "staged:src/a.ts", true);

    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-a").has("staged:src/a.ts")).toBe(
      true
    );
    setViewed("/wt-a", "staged:src/a.ts", false);
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-a").has("staged:src/a.ts")).toBe(
      false
    );
    // The other worktree's marker is untouched.
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-b").has("staged:src/a.ts")).toBe(
      true
    );
  });

  it("toggleViewed flips membership", () => {
    const { toggleViewed } = useDiffViewedStore.getState();
    toggleViewed("/wt", "k");
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt").has("k")).toBe(true);
    toggleViewed("/wt", "k");
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt").has("k")).toBe(false);
  });

  it("setViewed is a no-op state update when the value is unchanged", () => {
    const { setViewed } = useDiffViewedStore.getState();
    setViewed("/wt", "k", true);
    const before = useDiffViewedStore.getState().viewedByWorktree;
    setViewed("/wt", "k", true);
    expect(useDiffViewedStore.getState().viewedByWorktree).toBe(before);
  });

  it("returns a stable empty set for unknown worktrees", () => {
    const a = selectViewedSet(useDiffViewedStore.getState(), "/unknown-1");
    const b = selectViewedSet(useDiffViewedStore.getState(), "/unknown-2");
    expect(a.size).toBe(0);
    expect(a).toBe(b);
  });

  it("clearWorktree drops only that worktree", () => {
    const { setViewed, clearWorktree } = useDiffViewedStore.getState();
    setViewed("/wt-a", "k", true);
    setViewed("/wt-b", "k", true);
    clearWorktree("/wt-a");
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-a").size).toBe(0);
    expect(selectViewedSet(useDiffViewedStore.getState(), "/wt-b").has("k")).toBe(true);
  });

  it("clears a worktree's markers when the worktree is recorded as deleted", () => {
    useDiffViewedStore.getState().setViewed("/wt-gone", "staged:a.ts", true);
    useDiffViewedStore.getState().setViewed("/wt-keep", "staged:a.ts", true);

    useWorktreeSelectionStore.getState().addDeletedWorktree({
      id: "/wt-gone",
      title: "gone",
      path: "/wt-gone",
      deletedAt: Date.now(),
    } as never);

    const state = useDiffViewedStore.getState();
    expect("/wt-gone" in state.viewedByWorktree).toBe(false);
    expect("/wt-keep" in state.viewedByWorktree).toBe(true);
  });

  describe("lapsing once the marked file is observed to change (#14581)", () => {
    const WT = "/repo/wt";
    const MAIN = "/repo";
    let sources: ViewedMarkSources;

    const changeIn = (
      root: string,
      path: string,
      overrides: Partial<FileChangeDetail> = {}
    ): FileChangeDetail => ({
      path: `${root}/${path}`,
      status: "modified",
      insertions: 1,
      deletions: 0,
      mtimeMs: 100,
      ...overrides,
    });
    const change = (path: string, overrides: Partial<FileChangeDetail> = {}) =>
      changeIn(WT, path, overrides);

    const snapshot = (
      path: string,
      fields: Partial<WorktreeSnapshot> & { changes?: FileChangeDetail[] | null; headOid?: string }
    ): WorktreeSnapshot => {
      const { changes, headOid, ...rest } = fields;
      return {
        id: path,
        worktreeId: path,
        path,
        name: path,
        isCurrent: false,
        worktreeChanges:
          changes === null
            ? null
            : {
                worktreeId: path,
                rootPath: path,
                changes: changes ?? [],
                changedFileCount: changes?.length ?? 0,
                ...(headOid !== undefined && { headOid }),
              },
        ...rest,
      } as WorktreeSnapshot;
    };

    interface Observation {
      wt?: string;
      main?: string;
      branch?: string;
      mainBranch?: string | null;
      mainDetached?: boolean;
      wtDetached?: boolean;
      mainChanges?: FileChangeDetail[];
    }

    const observe = (changes: FileChangeDetail[] | null, at: Observation = {}) => {
      sources = {
        ...sources,
        worktrees: new Map([
          [
            MAIN,
            snapshot(MAIN, {
              isMainWorktree: true,
              ...(at.mainBranch !== null && { branch: at.mainBranch ?? "main" }),
              ...(at.mainDetached && { isDetached: true }),
              changes: at.mainChanges ?? [],
              headOid: at.main ?? "base-1",
            }),
          ],
          [
            WT,
            snapshot(WT, {
              branch: at.branch ?? "feature",
              ...(at.wtDetached && { isDetached: true }),
              changes,
              headOid: at.wt ?? "head-1",
            }),
          ],
        ]),
      };
    };

    const row = (path: string, insertions = 1, deletions = 0): StagingFileEntry => ({
      path,
      status: "modified",
      insertions,
      deletions,
    });

    const staging = (staged: StagingFileEntry[], unstaged: StagingFileEntry[]) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the sections the rule reads
      sources = { ...sources, stagingStatus: { staged, unstaged } as unknown as StagingStatus };
    };

    const mark = (key: string, path = WT) => {
      useDiffViewedStore.getState().setViewed(path, key, true);
      expect(selectViewedSet(useDiffViewedStore.getState(), path).has(key)).toBe(true);
    };
    const reconcile = (path?: string) => useDiffViewedStore.getState().reconcileViewed(path);
    const viewed = (key: string, path = WT) =>
      selectViewedSet(useDiffViewedStore.getState(), path).has(key);
    const hasBaseline = (key: string, path = WT) =>
      useDiffViewedStore.getState().baselinesByWorktree[path]?.has(key) ?? false;

    beforeEach(() => {
      sources = { worktrees: null, stagingStatus: null };
      setViewedMarkSourcesAccessor(() => sources);
    });

    afterEach(() => {
      resetStoreAccessorsForTesting();
    });

    it.each([
      ["new content", change("a.ts", { mtimeMs: 200 })],
      ["new insertions with the same mtime", change("a.ts", { insertions: 5 })],
      ["new deletions with the same mtime", change("a.ts", { deletions: 5 })],
      ["a status change", change("a.ts", { status: "added" })],
    ])("lapses on %s", (_label, next) => {
      observe([change("a.ts")]);
      mark("modified:a.ts");

      observe([next]);
      reconcile();

      expect(viewed("modified:a.ts")).toBe(false);
      expect(hasBaseline("modified:a.ts")).toBe(false);
    });

    it("lapses when the file leaves the change list, and stays unviewed when it comes back", () => {
      observe([change("a.ts")]);
      mark("modified:a.ts");

      observe([]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(false);

      observe([change("a.ts")]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(false);
    });

    it("keeps marks, and the state itself, through a poll that changes nothing about them", () => {
      observe([change("a.ts"), change("b.ts")], { mainChanges: [changeIn(MAIN, "m.ts")] });
      mark("modified:a.ts");
      mark("modified:m.ts", MAIN);
      const before = useDiffViewedStore.getState();

      observe([change("a.ts"), change("c.ts")], { mainChanges: [changeIn(MAIN, "m.ts")] });
      reconcile();

      expect(useDiffViewedStore.getState()).toBe(before);
    });

    it("lapses only the file that changed", () => {
      observe([change("a.ts"), change("b.ts")]);
      mark("modified:a.ts");
      mark("modified:b.ts");

      observe([change("a.ts", { mtimeMs: 200 }), change("b.ts")]);
      reconcile();

      expect(viewed("modified:a.ts")).toBe(false);
      expect(viewed("modified:b.ts")).toBe(true);
    });

    it("checks every worktree holding marks, or only the one it is asked about", () => {
      const before = { mainChanges: [changeIn(MAIN, "m.ts")] };
      const after = { mainChanges: [changeIn(MAIN, "m.ts", { mtimeMs: 200 })] };
      observe([change("a.ts")], before);
      mark("modified:a.ts");
      mark("modified:m.ts", MAIN);

      observe([change("a.ts", { mtimeMs: 200 })], after);
      reconcile(WT);
      expect(viewed("modified:a.ts")).toBe(false);
      expect(viewed("modified:m.ts", MAIN)).toBe(true);

      reconcile();
      expect(viewed("modified:m.ts", MAIN)).toBe(false);
    });

    it("matches the store's absolute change paths against the key's relative path", () => {
      observe([change("src/deep/a:b.ts")]);
      mark("unstaged:src/deep/a:b.ts");

      observe([change("src/deep/a:b.ts")]);
      reconcile();
      expect(viewed("unstaged:src/deep/a:b.ts")).toBe(true);

      observe([change("src/deep/a:b.ts", { mtimeMs: 200 })]);
      reconcile();
      expect(viewed("unstaged:src/deep/a:b.ts")).toBe(false);
    });

    it("leaves marks alone while a source has nothing to say, then compares against the mark", () => {
      observe([change("a.ts"), change("b.ts")]);
      mark("modified:a.ts");
      mark("modified:b.ts");

      // A not-ready topology, then a worktree with no change list yet.
      sources = { ...sources, worktrees: new Map() };
      reconcile();
      observe(null);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(true);
      expect(viewed("modified:b.ts")).toBe(true);

      observe([change("a.ts"), change("b.ts", { mtimeMs: 200 })]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(true);
      expect(viewed("modified:b.ts")).toBe(false);
    });

    it("takes its baseline from the first observation when nothing was known at mark time", () => {
      mark("modified:a.ts");

      observe([change("a.ts")]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(true);

      observe([change("a.ts", { mtimeMs: 200 })]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(false);
    });

    it("keeps marks set before any source was registered until a source can be compared", () => {
      resetStoreAccessorsForTesting();
      mark("modified:a.ts");
      reconcile();
      expect(viewed("modified:a.ts")).toBe(true);

      setViewedMarkSourcesAccessor(() => sources);
      observe([change("a.ts")]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(true);

      observe([change("a.ts", { mtimeMs: 200 })]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(false);
    });

    it("re-marking after a lapse starts from what is observed then", () => {
      observe([change("a.ts")]);
      mark("modified:a.ts");
      observe([change("a.ts", { mtimeMs: 200 })]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(false);

      mark("modified:a.ts");
      reconcile();
      expect(viewed("modified:a.ts")).toBe(true);

      observe([change("a.ts", { mtimeMs: 300 })]);
      reconcile();
      expect(viewed("modified:a.ts")).toBe(false);
    });

    it("forgets the baseline when a mark is cleared", () => {
      observe([change("a.ts")]);
      mark("modified:a.ts");
      expect(hasBaseline("modified:a.ts")).toBe(true);

      useDiffViewedStore.getState().toggleViewed(WT, "modified:a.ts");
      expect(hasBaseline("modified:a.ts")).toBe(false);

      mark("modified:a.ts");
      useDiffViewedStore.getState().clearWorktree(WT);
      expect(WT in useDiffViewedStore.getState().baselinesByWorktree).toBe(false);
    });

    it("lapses both staging-section marks when the file itself changes", () => {
      observe([change("a.ts")]);
      staging([row("a.ts", 1)], [row("a.ts", 2)]);
      mark("staged:a.ts");
      mark("unstaged:a.ts");

      // The rows read the same; only the worktree store saw the edit.
      observe([change("a.ts", { mtimeMs: 200 })]);
      reconcile();

      expect(viewed("staged:a.ts")).toBe(false);
      expect(viewed("unstaged:a.ts")).toBe(false);
    });

    it.each([
      ["staged", [row("a.ts", 3)], [row("a.ts", 2)]],
      ["unstaged", [row("a.ts", 1)], [row("a.ts", 2, 4)]],
    ] as const)(
      "lapses the %s mark when only that section's row changes",
      (section, staged, unstaged) => {
        observe([change("a.ts")]);
        staging([row("a.ts", 1)], [row("a.ts", 2)]);
        mark("staged:a.ts");
        mark("unstaged:a.ts");

        // Staging a hunk moves churn between the sections without touching
        // the file on disk, so the worktree store sees nothing.
        staging([...staged], [...unstaged]);
        reconcile(WT);

        const other = section === "staged" ? "unstaged" : "staged";
        expect(viewed(`${section}:a.ts`)).toBe(false);
        expect(viewed(`${other}:a.ts`)).toBe(true);
      }
    );

    it("lapses a staging-section mark when its row leaves that section", () => {
      staging([], [row("a.ts")]);
      mark("unstaged:a.ts");

      staging([row("a.ts")], []);
      reconcile(WT);
      expect(viewed("unstaged:a.ts")).toBe(false);

      staging([], [row("a.ts")]);
      reconcile(WT);
      expect(viewed("unstaged:a.ts")).toBe(false);
    });

    it("keeps since-review marks apart from working-tree and base-branch ones", () => {
      observe([change("a.ts")]);
      mark("since-review:a.ts");

      expect(viewed("since-review:a.ts")).toBe(true);
      expect(viewed("unstaged:a.ts")).toBe(false);
      expect(viewed("staged:a.ts")).toBe(false);
      expect(viewed("base:a.ts")).toBe(false);
    });

    it.each([
      ["the compared branch", { wt: "head-2" }],
      ["the base branch", { main: "base-2" }],
      ["a branch switch", { branch: "other" }],
    ])("lapses base-branch marks when %s moves", (_label, at) => {
      observe([change("a.ts")]);
      mark("base:a.ts");

      observe([change("a.ts")], at);
      reconcile();

      expect(viewed("base:a.ts")).toBe(false);
    });

    it("keeps base-branch marks through dirty edits that move no commit", () => {
      observe([change("a.ts")]);
      mark("base:a.ts");

      observe([change("a.ts", { mtimeMs: 200 })]);
      reconcile();

      expect(viewed("base:a.ts")).toBe(true);
    });

    it.each([
      ["a main worktree with no branch", { mainBranch: null }, { main: "detached-2" }],
      // Detaching mid-session leaves the old branch name on the snapshot.
      ["a main worktree that detached", { mainDetached: true }, { main: "detached-2" }],
      ["a compared worktree that detached", { wtDetached: true }, { wt: "detached-2" }],
    ] as const)(
      "reads nothing into the HEAD of %s, which isn't a compared branch",
      (_label, side, moved) => {
        observe([change("a.ts")], side);
        mark("base:a.ts");

        observe([change("a.ts")], { ...side, ...moved });
        reconcile();

        expect(viewed("base:a.ts")).toBe(true);
      }
    );
  });
});
