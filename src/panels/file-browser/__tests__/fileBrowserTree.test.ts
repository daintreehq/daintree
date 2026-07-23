import { describe, expect, it } from "vitest";
import type { FileTreeNode } from "@shared/types";
import {
  ancestorDirectories,
  canonicalizeRootPath,
  createVisibilityFilter,
  flattenTree,
  isRowPathVisible,
  parentRootPath,
  pruneListings,
  refreshTargets,
  resolveTreeKey,
  type FlatTreeRow,
} from "../fileBrowserTree";

function dir(path: string, name = path.split("/").pop()!): FileTreeNode {
  return { name, path, isDirectory: true };
}

function file(path: string, extra: Partial<FileTreeNode> = {}): FileTreeNode {
  return { name: path.split("/").pop()!, path, isDirectory: false, ...extra };
}

function listingsOf(entries: Record<string, FileTreeNode[]>): Map<string, FileTreeNode[]> {
  return new Map(Object.entries(entries));
}

function pathsOf(rows: readonly FlatTreeRow[]): string[] {
  return rows.map((row) => row.path);
}

describe("flattenTree", () => {
  it("emits only the root listing when nothing is expanded", () => {
    const listings = listingsOf({
      "": [dir("src"), file("README.md")],
      src: [file("src/index.ts")],
    });

    const rows = flattenTree(listings, new Set(), new Set());

    // The `src` listing is loaded but collapsed — a loaded listing must not
    // leak into the row list on its own.
    expect(pathsOf(rows)).toEqual(["src", "README.md"]);
  });

  it("splices an expanded directory's children directly beneath it", () => {
    const listings = listingsOf({
      "": [dir("src"), file("README.md")],
      src: [file("src/index.ts"), file("src/util.ts")],
    });

    const rows = flattenTree(listings, new Set(["src"]), new Set());

    expect(pathsOf(rows)).toEqual(["src", "src/index.ts", "src/util.ts", "README.md"]);
  });

  it("renders from a browse root with depth 0 at its children", () => {
    const listings = listingsOf({
      "": [dir("src"), file("README.md")],
      src: [dir("src/lib"), file("src/index.ts")],
      "src/lib": [file("src/lib/util.ts")],
    });

    const rows = flattenTree(listings, new Set(["src/lib"]), new Set(), "src");

    // Rows outside the root never appear, and depth restarts at the root:
    // full worktree-relative paths, root-relative indentation.
    expect(pathsOf(rows)).toEqual(["src/lib", "src/lib/util.ts", "src/index.ts"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });

  it("assigns depth by nesting level, not by path segment count", () => {
    const listings = listingsOf({
      "": [dir("a")],
      a: [dir("a/b")],
      "a/b": [file("a/b/c.ts")],
    });

    const rows = flattenTree(listings, new Set(["a", "a/b"]), new Set());

    expect(rows.map((row) => [row.path, row.depth])).toEqual([
      ["a", 0],
      ["a/b", 1],
      ["a/b/c.ts", 2],
    ]);
  });

  it("renders an expanded-but-unloaded directory as a loading row with no children", () => {
    const listings = listingsOf({ "": [dir("src")] });

    const rows = flattenTree(listings, new Set(["src"]), new Set(["src"]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "src", isExpanded: true, isLoading: true });
  });

  it("clears the loading flag once the listing arrives, even while the fetch set still holds it", () => {
    const listings = listingsOf({ "": [dir("src")], src: [] });

    const rows = flattenTree(listings, new Set(["src"]), new Set(["src"]));

    // A refresh re-fetches an already-loaded directory; showing a loading
    // indicator on a row whose contents are already on screen would be noise on
    // every tick.
    expect(rows[0]?.isLoading).toBe(false);
  });

  it("omits an entry the visibility filter rejects, and does not descend a hidden directory", () => {
    const listings = listingsOf({
      "": [dir(".git"), dir("src"), file(".env"), file("README.md")],
      ".git": [file(".git/config")],
      src: [file("src/index.ts")],
    });

    // Hide dotfiles: `.git` and `.env` drop out, and `.git`'s children are
    // never walked even though its listing is cached and it's "expanded".
    const isVisible = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });
    const rows = flattenTree(listings, new Set([".git", "src"]), new Set(), "", isVisible);

    expect(pathsOf(rows)).toEqual(["src", "src/index.ts", "README.md"]);
  });

  it("passes every entry through when no filter is supplied", () => {
    const listings = listingsOf({ "": [file(".env"), file("README.md")] });

    expect(pathsOf(flattenTree(listings, new Set(), new Set()))).toEqual([".env", "README.md"]);
  });

  it("stops descending past the depth guard instead of recursing forever", () => {
    // A listings map where a directory contains itself — the shape a symlink
    // cycle would produce if the service ever stopped skipping symlinks.
    const listings = listingsOf({ "": [dir("loop")], loop: [dir("loop")] });

    const rows = flattenTree(listings, new Set(["loop"]), new Set());

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(200);
  });
});

describe("canonicalizeRootPath", () => {
  it("normalizes separators, dots and duplicate slashes to row-key form", () => {
    expect(canonicalizeRootPath("src/panels")).toBe("src/panels");
    expect(canonicalizeRootPath("src/")).toBe("src");
    expect(canonicalizeRootPath("./src//panels")).toBe("src/panels");
    expect(canonicalizeRootPath("src\\panels")).toBe("src/panels");
    expect(canonicalizeRootPath(".")).toBe("");
  });

  it("falls back to the worktree root for traversal-shaped input", () => {
    // Fail toward showing more, never escaping: a root the tree can't trust
    // must not survive as-is.
    expect(canonicalizeRootPath("src/../..")).toBe("");
  });
});

describe("parentRootPath", () => {
  it("walks one level up until the worktree root", () => {
    expect(parentRootPath("src/panels/diff")).toBe("src/panels");
    expect(parentRootPath("src")).toBe("");
  });
});

describe("ancestorDirectories", () => {
  it("returns each ancestor root-first and excludes the path itself", () => {
    expect(ancestorDirectories("a/b/c/file.ts")).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("returns nothing for a path at the root", () => {
    expect(ancestorDirectories("README.md")).toEqual([]);
  });
});

describe("resolveTreeKey", () => {
  const listings = listingsOf({
    "": [dir("src"), file("README.md")],
    src: [file("src/index.ts")],
  });
  const collapsed = flattenTree(listings, new Set(), new Set());
  const expanded = flattenTree(listings, new Set(["src"]), new Set());

  it("selects the first row when arrowing down with no selection", () => {
    expect(resolveTreeKey("ArrowDown", collapsed, null)).toEqual({
      type: "select",
      path: "src",
    });
  });

  it("stops at the last row rather than wrapping", () => {
    expect(resolveTreeKey("ArrowDown", collapsed, "README.md")).toEqual({
      type: "select",
      path: "README.md",
    });
  });

  it("does nothing arrowing up from the first row", () => {
    expect(resolveTreeKey("ArrowUp", collapsed, "src")).toBeNull();
  });

  it("expands a collapsed directory on right", () => {
    expect(resolveTreeKey("ArrowRight", collapsed, "src")).toEqual({
      type: "expand",
      path: "src",
    });
  });

  it("descends into the first child when right is pressed on an already-expanded directory", () => {
    expect(resolveTreeKey("ArrowRight", expanded, "src")).toEqual({
      type: "select",
      path: "src/index.ts",
    });
  });

  it("does nothing on right for a file", () => {
    expect(resolveTreeKey("ArrowRight", collapsed, "README.md")).toBeNull();
  });

  it("does not descend when an expanded directory has no children", () => {
    const emptyDir = flattenTree(
      listingsOf({ "": [dir("empty"), file("after.ts")], empty: [] }),
      new Set(["empty"]),
      new Set()
    );

    // The next row exists but is a sibling, not a child — right must not jump
    // out of the directory the user is standing in.
    expect(resolveTreeKey("ArrowRight", emptyDir, "empty")).toBeNull();
  });

  it("collapses an expanded directory on left", () => {
    expect(resolveTreeKey("ArrowLeft", expanded, "src")).toEqual({
      type: "collapse",
      path: "src",
    });
  });

  it("jumps to the parent on left from a child row", () => {
    expect(resolveTreeKey("ArrowLeft", expanded, "src/index.ts")).toEqual({
      type: "select",
      path: "src",
    });
  });

  it("does nothing on left at the top level", () => {
    expect(resolveTreeKey("ArrowLeft", expanded, "README.md")).toBeNull();
  });

  it("finds the parent by depth, not by splitting the path", () => {
    // A directory whose *name* contains a slash-like structure would fool a
    // path-splitting parent lookup; depth is the authority.
    const rows: FlatTreeRow[] = [
      { path: "a", name: "a", isDirectory: true, depth: 0, isExpanded: true, isLoading: false },
      { path: "a/b", name: "b", isDirectory: true, depth: 1, isExpanded: true, isLoading: false },
      {
        path: "a/b/c",
        name: "c",
        isDirectory: false,
        depth: 2,
        isExpanded: false,
        isLoading: false,
      },
    ];

    expect(resolveTreeKey("ArrowLeft", rows, "a/b/c")).toEqual({ type: "select", path: "a/b" });
  });

  it("maps Home and End to the first and last visible rows", () => {
    expect(resolveTreeKey("Home", expanded, "README.md")).toEqual({ type: "select", path: "src" });
    expect(resolveTreeKey("End", expanded, "src")).toEqual({
      type: "select",
      path: "README.md",
    });
  });

  it("returns null for keys the tree does not own", () => {
    expect(resolveTreeKey("a", expanded, "src")).toBeNull();
    expect(resolveTreeKey("Tab", expanded, "src")).toBeNull();
  });

  it("returns null for every key when there are no rows", () => {
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"]) {
      expect(resolveTreeKey(key, [], null)).toBeNull();
    }
  });

  it("ignores a selection that is no longer in the row list", () => {
    // A live update can delete the selected file out from under the keyboard.
    expect(resolveTreeKey("ArrowRight", collapsed, "deleted.ts")).toBeNull();
    expect(resolveTreeKey("Enter", collapsed, "deleted.ts")).toBeNull();
  });
});

describe("pruneListings", () => {
  it("keeps the root and expanded directories, drops the rest", () => {
    const listings = listingsOf({
      "": [dir("a"), dir("b")],
      a: [file("a/one.ts")],
      b: [file("b/two.ts")],
    });

    const pruned = pruneListings(listings, new Set(["a"]));

    expect([...pruned.keys()].sort()).toEqual(["", "a"]);
  });

  it("never drops the root even when nothing is expanded", () => {
    const listings = listingsOf({ "": [dir("a")], a: [] });

    expect([...pruneListings(listings, new Set()).keys()]).toEqual([""]);
  });

  it("retains a non-root browse root the same way it retains the worktree root", () => {
    const listings = listingsOf({
      "src/panels": [dir("src/panels/diff")],
      "src/panels/diff": [file("src/panels/diff/DiffPane.tsx")],
    });

    const pruned = pruneListings(listings, new Set(), "src/panels");

    expect([...pruned.keys()]).toEqual(["src/panels"]);
  });
});

describe("refreshTargets", () => {
  it("returns the root plus expanded directories reachable from it", () => {
    const listings = listingsOf({
      "": [dir("a")],
      a: [dir("a/b")],
      "a/b": [file("a/b/c.ts")],
    });

    expect(refreshTargets(listings, new Set(["a", "a/b"]))).toEqual(["", "a", "a/b"]);
  });

  it("skips an expanded directory whose parent is collapsed", () => {
    const listings = listingsOf({ "": [dir("a")], a: [dir("a/b")] });

    // `a/b` is in the expanded set but `a` is not, so no row for it exists —
    // refreshing it would be a request for something off screen.
    expect(refreshTargets(listings, new Set(["a/b"]))).toEqual([""]);
  });

  it("skips a persisted expansion whose directory no longer exists", () => {
    const listings = listingsOf({ "": [dir("a")], a: [] });

    // `a/gone` survives in persisted panel data after the folder is deleted.
    expect(refreshTargets(listings, new Set(["a", "a/gone"]))).toEqual(["", "a"]);
  });

  it("walks from the browse root, ignoring expansions outside it", () => {
    const listings = listingsOf({
      "": [dir("a"), dir("src")],
      a: [file("a/one.ts")],
      src: [dir("src/lib")],
      "src/lib": [file("src/lib/util.ts")],
    });

    // `a` is expanded but sits outside the root — a refresh scoped to `src`
    // must not re-request it.
    expect(refreshTargets(listings, new Set(["a", "src/lib"]), "src")).toEqual(["src", "src/lib"]);
  });

  it("skips a hidden expanded directory and its subtree when given a visibility filter", () => {
    const listings = listingsOf({
      "": [dir(".cache"), dir("src")],
      ".cache": [dir(".cache/inner")],
      src: [file("src/a.ts")],
    });
    const isVisible = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });

    // `.cache` renders no row while dotfiles are hidden, so re-listing it (and
    // `.cache/inner`) every tick is waste — only the root and `src` are targets.
    expect(
      refreshTargets(listings, new Set([".cache", ".cache/inner", "src"]), "", isVisible)
    ).toEqual(["", "src"]);
  });
});

describe("createVisibilityFilter", () => {
  const hidden = (names: string[], visibility: Parameters<typeof createVisibilityFilter>[0]) =>
    names.filter((name) => !createVisibilityFilter(visibility)(name));

  it("hides exact junk-list basenames, nothing more", () => {
    const isVisible = createVisibilityFilter({
      hideDotfiles: false,
      alwaysHiddenPatterns: [".DS_Store", "Thumbs.db"],
    });
    expect(isVisible(".DS_Store")).toBe(false);
    expect(isVisible("Thumbs.db")).toBe(false);
    // A literal pattern anchors both ends: no substring or prefix matches.
    expect(isVisible("Thumbs.db.bak")).toBe(true);
    expect(isVisible("my.DS_Store")).toBe(true);
    expect(isVisible("index.ts")).toBe(true);
  });

  it("treats * as the only wildcard and anchors the rest, matching AppleDouble names", () => {
    const isVisible = createVisibilityFilter({
      hideDotfiles: false,
      alwaysHiddenPatterns: ["._*", "*.log"],
    });
    expect(isVisible("._DS_Store")).toBe(false);
    expect(isVisible("._")).toBe(false);
    expect(isVisible("debug.log")).toBe(false);
    expect(isVisible(".log")).toBe(false);
    // No leading `._`, no `.log` suffix.
    expect(isVisible("changelog.txt")).toBe(true);
    expect(isVisible("a._b")).toBe(true);
  });

  it("treats `*` as a wildcard even against a filename that contains a literal `*`", () => {
    // A left-to-right literal check would let the name's `*` consume the
    // pattern's wildcard; `*` must still match everything.
    const isVisible = createVisibilityFilter({ hideDotfiles: false, alwaysHiddenPatterns: ["*"] });
    expect(isVisible("*a")).toBe(false);
    expect(isVisible("anything")).toBe(false);
    expect(isVisible("")).toBe(false);
  });

  it("does not let a pattern inject regex semantics", () => {
    // `.` is a literal dot, not "any char"; `+` is literal, not a quantifier.
    const isVisible = createVisibilityFilter({
      hideDotfiles: false,
      alwaysHiddenPatterns: ["a.b", "c+d"],
    });
    expect(isVisible("a.b")).toBe(false);
    expect(isVisible("axb")).toBe(true);
    expect(isVisible("c+d")).toBe(false);
    expect(isVisible("cd")).toBe(true);
  });

  it("hides dot-prefixed entries only when the toggle is on, independent of the junk list", () => {
    expect(hidden([".env", "src"], { hideDotfiles: true, alwaysHiddenPatterns: [] })).toEqual([
      ".env",
    ]);
    expect(hidden([".env", "src"], { hideDotfiles: false, alwaysHiddenPatterns: [] })).toEqual([]);
  });

  it("matches a pathological star pattern in linear time without catastrophic backtracking", () => {
    // A `.*`-per-`*` regex would take seconds on this input (a real ReDoS on
    // user-persisted patterns); the two-pointer matcher returns immediately. The
    // test hanging IS the failure mode we're guarding against.
    const isVisible = createVisibilityFilter({
      hideDotfiles: false,
      alwaysHiddenPatterns: ["*a*a*a*a*a*a*a*a*a*a*b"],
    });
    const name = "a".repeat(64); // matches the a-runs, never the trailing `b`
    expect(isVisible(name)).toBe(true); // not hidden — no `b`, so no match
  });
});

describe("isRowPathVisible", () => {
  const showAll = () => true;
  const hideDotfiles = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });

  it("is visible when every segment below the root passes the filter", () => {
    expect(isRowPathVisible("src/index.ts", "", showAll)).toBe(true);
    expect(isRowPathVisible("src/index.ts", "", hideDotfiles)).toBe(true);
  });

  it("is hidden when any segment below the root is filtered", () => {
    expect(isRowPathVisible(".git/config", "", hideDotfiles)).toBe(false);
    expect(isRowPathVisible("src/.env", "", hideDotfiles)).toBe(false);
  });

  it("never tests the root's own segments — a dot-named root doesn't hide its children", () => {
    // Rooted inside `.github`, a hideDotfiles filter still shows plain children.
    expect(isRowPathVisible(".github/workflows", ".github", hideDotfiles)).toBe(true);
    expect(isRowPathVisible(".github/.secret", ".github", hideDotfiles)).toBe(false);
  });

  it("is not visible for a path outside the root", () => {
    expect(isRowPathVisible("other/file.ts", "src", showAll)).toBe(false);
  });
});
