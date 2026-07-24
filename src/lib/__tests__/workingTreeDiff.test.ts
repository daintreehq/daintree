import { describe, expect, it } from "vitest";
import type { FileChangeDetail, GitStatus } from "@shared/types/git";
import {
  buildWorkingTreeDiffModel,
  getWorkingTreeChangeKey,
  type WorkingTreeFileChange,
} from "../workingTreeDiff";

const ROOT = "/repo/wt";

function change(
  path: string,
  status: GitStatus,
  insertions: number | null = 0,
  deletions: number | null = 0
): FileChangeDetail {
  return { path, status, insertions, deletions };
}

function pathsOf(rows: WorkingTreeFileChange[]): string[] {
  return rows.map((row) => row.relativePath);
}

describe("buildWorkingTreeDiffModel — ordering", () => {
  it("ranks by total churn, insertions and deletions counting equally", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [
        change("small.ts", "modified", 1, 1),
        change("big.ts", "modified", 0, 40),
        change("medium.ts", "modified", 10, 5),
      ],
      ROOT
    );

    expect(pathsOf(sortedChanges)).toEqual(["big.ts", "medium.ts", "small.ts"]);
  });

  it("treats null insertion and deletion counts as zero churn rather than dropping the row", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change("unknown.ts", "modified", null, null), change("counted.ts", "modified", 3, 0)],
      ROOT
    );

    expect(pathsOf(sortedChanges)).toEqual(["counted.ts", "unknown.ts"]);
  });

  it("breaks equal churn by status rank before path", () => {
    // Identical churn, and the alphabetical order is the reverse of the status
    // order — so a passing result can only come from the status tie-break.
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [
        change("z-modified.ts", "modified", 5, 0),
        change("a-untracked.ts", "untracked", 5, 0),
        change("m-added.ts", "added", 5, 0),
      ],
      ROOT
    );

    expect(pathsOf(sortedChanges)).toEqual(["z-modified.ts", "m-added.ts", "a-untracked.ts"]);
  });

  it("breaks equal churn and equal status by path", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change("b.ts", "modified", 2, 0), change("a.ts", "modified", 2, 0)],
      ROOT
    );

    expect(pathsOf(sortedChanges)).toEqual(["a.ts", "b.ts"]);
  });

  it("does not mutate or reorder the caller's array", () => {
    const input = [change("b.ts", "modified", 1, 0), change("a.ts", "modified", 9, 0)];
    const originalOrder = input.map((c) => c.path);

    buildWorkingTreeDiffModel(input, ROOT);

    expect(input.map((c) => c.path)).toEqual(originalOrder);
  });
});

describe("buildWorkingTreeDiffModel — path resolution", () => {
  it("makes absolute paths relative to the root", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change(`${ROOT}/src/deep/file.ts`, "modified", 1, 0)],
      ROOT
    );

    expect(sortedChanges[0]!.relativePath).toBe("src/deep/file.ts");
  });

  it("leaves an already-relative path untouched", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change("src/file.ts", "modified", 1, 0)],
      ROOT
    );

    expect(sortedChanges[0]!.relativePath).toBe("src/file.ts");
  });

  it("keeps an absolute path that escapes the root absolute instead of mangling it", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change("/elsewhere/file.ts", "modified", 1, 0)],
      ROOT
    );

    expect(sortedChanges[0]!.relativePath).toBe("/elsewhere/file.ts");
  });

  it("does not treat a sibling root sharing a name prefix as inside the root", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change("/repo/wt-other/file.ts", "modified", 1, 0)],
      ROOT
    );

    expect(sortedChanges[0]!.relativePath).toBe("/repo/wt-other/file.ts");
  });

  it("preserves the original absolute path alongside the derived relative one", () => {
    const { sortedChanges } = buildWorkingTreeDiffModel(
      [change(`${ROOT}/src/file.ts`, "modified", 1, 0)],
      ROOT
    );

    expect(sortedChanges[0]!.path).toBe(`${ROOT}/src/file.ts`);
  });
});

describe("buildWorkingTreeDiffModel — change set", () => {
  it("emits the change set in the same order as the sorted rows", () => {
    const { sortedChanges, diffChangeSet } = buildWorkingTreeDiffModel(
      [
        change("a.ts", "modified", 1, 0),
        change("b.ts", "modified", 30, 0),
        change("c.ts", "added", 7, 0),
      ],
      ROOT
    );

    expect(diffChangeSet.map((entry) => entry.path)).toEqual(pathsOf(sortedChanges));
  });

  it("addresses entries by relative path so the diff panel can resolve them", () => {
    const { diffChangeSet } = buildWorkingTreeDiffModel(
      [change(`${ROOT}/src/file.ts`, "modified", 1, 0)],
      ROOT
    );

    expect(diffChangeSet[0]!.path).toBe("src/file.ts");
  });

  it("scopes viewed keys by status so a staged and unstaged copy stay distinct", () => {
    const { diffChangeSet } = buildWorkingTreeDiffModel(
      [change("same.ts", "modified", 4, 0), change("same.ts", "added", 4, 0)],
      ROOT
    );

    const viewedKeys = diffChangeSet.map((entry) => entry.viewedKey);
    expect(new Set(viewedKeys).size).toBe(viewedKeys.length);
  });

  it("carries churn counts through unchanged, including nulls", () => {
    const { diffChangeSet } = buildWorkingTreeDiffModel(
      [change("file.ts", "modified", 3, null)],
      ROOT
    );

    expect(diffChangeSet[0]).toMatchObject({ insertions: 3, deletions: null });
  });

  it("returns empty collections for an empty change list", () => {
    const model = buildWorkingTreeDiffModel([], ROOT);

    expect(model.sortedChanges).toHaveLength(0);
    expect(model.diffChangeSet).toHaveLength(0);
    expect(model.indexByKey.size).toBe(0);
  });
});

describe("buildWorkingTreeDiffModel — index lookup", () => {
  it("maps every row key to its own position in the sorted order", () => {
    const { sortedChanges, indexByKey } = buildWorkingTreeDiffModel(
      [
        change("a.ts", "modified", 1, 0),
        change("b.ts", "modified", 50, 0),
        change("c.ts", "untracked", 20, 0),
      ],
      ROOT
    );

    for (const [index, row] of sortedChanges.entries()) {
      expect(indexByKey.get(getWorkingTreeChangeKey(row))).toBe(index);
    }
  });

  it("gives the same path under two statuses two separate index entries", () => {
    const { indexByKey } = buildWorkingTreeDiffModel(
      [change("same.ts", "modified", 9, 0), change("same.ts", "added", 1, 0)],
      ROOT
    );

    expect(indexByKey.size).toBe(2);
    expect(indexByKey.get(getWorkingTreeChangeKey({ path: "same.ts", status: "modified" }))).toBe(0);
    expect(indexByKey.get(getWorkingTreeChangeKey({ path: "same.ts", status: "added" }))).toBe(1);
  });

  it("keys on the original path, not the root-relative one", () => {
    const absolute = `${ROOT}/src/file.ts`;
    const { indexByKey } = buildWorkingTreeDiffModel([change(absolute, "modified", 1, 0)], ROOT);

    expect(indexByKey.has(getWorkingTreeChangeKey({ path: absolute, status: "modified" }))).toBe(
      true
    );
  });
});
