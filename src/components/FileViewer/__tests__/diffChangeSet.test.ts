import { describe, expect, it } from "vitest";
import type { DiffChangeSetEntry } from "@shared/types/git";
import {
  diffDisplayOrder,
  groupDiffChangeSet,
  resolveDiffFileNavigation,
  type DiffFileAnchor,
} from "../diffChangeSet";

function entry(path: string, side?: DiffChangeSetEntry["side"]): DiffChangeSetEntry {
  return { path, status: "modified", viewedKey: `working-tree:${path}`, side };
}

function pathsOf(files: readonly DiffChangeSetEntry[], order: readonly number[]): string[] {
  return order.map((index) => files[index]!.path);
}

/** The order and the open file's place in it, as the pane holds them. */
function anchorAt(files: DiffChangeSetEntry[], path: string): DiffFileAnchor {
  const order = diffDisplayOrder(groupDiffChangeSet(files));
  return { files, order, position: order.findIndex((index) => files[index]!.path === path) };
}

/** Navigation for an open file missing from `files`, anchored where it sat in `before`. */
function afterRemoval(before: DiffChangeSetEntry[], openPath: string, files: DiffChangeSetEntry[]) {
  const order = diffDisplayOrder(groupDiffChangeSet(files));
  const nav = resolveDiffFileNavigation(files, order, order, -1, anchorAt(before, openPath));
  return {
    ...nav,
    previous: nav.previousIndex === null ? null : files[nav.previousIndex]!.path,
    next: nav.nextIndex === null ? null : files[nav.nextIndex]!.path,
  };
}

describe("groupDiffChangeSet", () => {
  it("puts root files first, then folders alphabetically, each in change-set order", () => {
    const files = [entry("src/b.ts"), entry("z.ts"), entry("lib/c.ts"), entry("src/a.ts")];
    const groups = groupDiffChangeSet(files);

    expect(groups.map((group) => group.dir)).toEqual(["", "lib", "src"]);
    expect(pathsOf(files, diffDisplayOrder(groups))).toEqual([
      "z.ts",
      "lib/c.ts",
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("sorts folders by locale, not by code point", () => {
    // Code-point order would put `B` ahead of `a`.
    const files = [entry("B/x.ts"), entry("a/y.ts")];

    expect(groupDiffChangeSet(files).map((group) => group.dir)).toEqual(["a", "B"]);
  });

  it("keeps only paths containing the trimmed filter, case-insensitively", () => {
    const files = [entry("src/Alpha.ts"), entry("lib/beta.ts"), entry("ALPHA.md")];

    expect(pathsOf(files, diffDisplayOrder(groupDiffChangeSet(files, "  ALpHa ")))).toEqual([
      "ALPHA.md",
      "src/Alpha.ts",
    ]);
    // Whitespace alone is no filter at all.
    expect(diffDisplayOrder(groupDiffChangeSet(files, "   "))).toHaveLength(3);
    expect(groupDiffChangeSet(files, "nothing")).toEqual([]);
  });
});

describe("resolveDiffFileNavigation", () => {
  const files = [entry("src/b.ts"), entry("a.ts"), entry("lib/c.ts"), entry("src/d.ts")];
  // a.ts, lib/c.ts, src/b.ts, src/d.ts
  const fullOrder = diffDisplayOrder(groupDiffChangeSet(files));

  it("places a shown open file and its neighbours in display order", () => {
    // src/b.ts is index 0 in the set but third on the shelf.
    expect(resolveDiffFileNavigation(files, fullOrder, fullOrder, 0, null)).toEqual({
      position: 2,
      total: 4,
      previousIndex: 2,
      nextIndex: 3,
    });
    const first = resolveDiffFileNavigation(files, fullOrder, fullOrder, 1, null);
    expect([first.position, first.previousIndex, first.nextIndex]).toEqual([0, null, 2]);
    const last = resolveDiffFileNavigation(files, fullOrder, fullOrder, 3, null);
    expect([last.position, last.previousIndex, last.nextIndex]).toEqual([3, 0, null]);
  });

  it("counts and steps within the filtered order", () => {
    const visible = diffDisplayOrder(groupDiffChangeSet(files, "src/"));

    expect(resolveDiffFileNavigation(files, fullOrder, visible, 3, null)).toEqual({
      position: 1,
      total: 2,
      previousIndex: 0,
      nextIndex: null,
    });
  });

  it("steps from a filtered-out open file to the nearest shown file on each side", () => {
    // Shows a.ts and src/d.ts; the open lib/c.ts sits between them.
    const visible = [1, 3];

    expect(resolveDiffFileNavigation(files, fullOrder, visible, 2, null)).toEqual({
      position: null,
      total: 2,
      previousIndex: 1,
      nextIndex: 3,
    });
    // Nothing shown on one side leaves that direction closed.
    const after = diffDisplayOrder(groupDiffChangeSet(files, "src/"));
    const nav = resolveDiffFileNavigation(files, fullOrder, after, 2, null);
    expect([nav.previousIndex, nav.nextIndex]).toEqual([null, 0]);
  });

  it("closes both directions when the filter shows nothing", () => {
    expect(resolveDiffFileNavigation(files, fullOrder, [], 0, null)).toEqual({
      position: null,
      total: 0,
      previousIndex: null,
      nextIndex: null,
    });
  });

  describe("after the open file leaves the set", () => {
    const [a, b, c, d] = [entry("a.ts"), entry("b.ts"), entry("c.ts"), entry("d.ts")];

    it("opens the file that slid into its place next, and the one before it previous", () => {
      expect(afterRemoval([a, b, c, d], "b.ts", [a, c, d])).toMatchObject({
        position: null,
        total: 3,
        previous: "a.ts",
        next: "c.ts",
      });
    });

    it("leaves the outer direction closed when the first or last file goes", () => {
      expect(afterRemoval([a, b, c], "a.ts", [b, c])).toMatchObject({
        previous: null,
        next: "b.ts",
      });
      expect(afterRemoval([a, b, c], "c.ts", [a, b])).toMatchObject({
        previous: "b.ts",
        next: null,
      });
    });

    it("finds the gap by surviving neighbours when files ahead of it went too", () => {
      // A position alone (2) would put the gap after d.ts.
      expect(afterRemoval([a, b, c, d], "c.ts", [b, d])).toMatchObject({
        previous: "b.ts",
        next: "d.ts",
      });
    });

    it("looks past neighbours that went with it", () => {
      const e = entry("e.ts");
      expect(afterRemoval([a, b, c, d, e], "c.ts", [a, e])).toMatchObject({
        previous: "a.ts",
        next: "e.ts",
      });
      // No successor left: the gap follows the nearest surviving predecessor.
      expect(afterRemoval([a, b, c, d, e], "c.ts", [a])).toMatchObject({
        previous: "a.ts",
        next: null,
      });
    });

    it("tells a partially staged file's twins apart by side", () => {
      const staged = entry("a.ts", "staged");
      const unstaged = entry("a.ts", "unstaged");
      const z = entry("z.ts");
      // b.ts sat between the twins, which share a Viewed key: only the side
      // says its successor is the unstaged one, not the staged one ahead of it.
      expect(afterRemoval([staged, b, unstaged, z], "b.ts", [staged, unstaged, z])).toMatchObject({
        previousIndex: 0,
        nextIndex: 1,
      });
    });

    it("places the gap before its surviving successor, ahead of a file new to the set", () => {
      const x = entry("x.ts");
      // x.ts arrived where b.ts was; the old successor c.ts still marks the gap.
      expect(afterRemoval([a, b, c], "b.ts", [a, x, c])).toMatchObject({
        previous: "x.ts",
        next: "c.ts",
      });
    });

    it("finds the gap in the full order when the filter hides its neighbours", () => {
      const keepB = entry("keep-b.ts");
      const keepE = entry("keep-e.ts");
      const before = [a, keepB, c, d, keepE];
      const files = [a, keepB, d, keepE];
      const fullOrder = diffDisplayOrder(groupDiffChangeSet(files));
      const visible = diffDisplayOrder(groupDiffChangeSet(files, "keep-"));
      const nav = resolveDiffFileNavigation(
        files,
        fullOrder,
        visible,
        -1,
        anchorAt(before, "c.ts")
      );
      // c.ts's successor d.ts is hidden but still marks the gap.
      expect(nav).toEqual({ position: null, total: 2, previousIndex: 1, nextIndex: 3 });
    });

    it("falls back to its old place when none of its neighbours survive", () => {
      const x = entry("x.ts");
      const y = entry("y.ts");
      expect(afterRemoval([a, b, c], "b.ts", [x, y])).toMatchObject({
        previous: "x.ts",
        next: "y.ts",
      });
    });

    it("starts from the top with no history", () => {
      const nav = resolveDiffFileNavigation([a, b], [0, 1], [0, 1], -1, null);
      expect([nav.previousIndex, nav.nextIndex]).toEqual([null, 0]);
    });
  });
});
