import { describe, expect, it } from "vitest";
import type { FileTreeNode } from "@shared/types";
import {
  ancestorDirectories,
  buildFolderListingRows,
  canonicalizeRootPath,
  createVisibilityFilter,
  DEFAULT_FILE_SORT,
  findNodeInListings,
  parentDirectoryOf,
  flattenTree,
  isRowPathVisible,
  listingsFromSnapshot,
  sortFileNodes,
  MAX_SNAPSHOT_LISTINGS,
  MAX_SNAPSHOT_NODES,
  MAX_SNAPSHOT_TEXT_CHARS,
  parentRootPath,
  pruneListings,
  refreshTargets,
  resolveTreeKey,
  snapshotFromListings,
  snapshotMatchesSource,
  sourceIdentityKey,
  type FileBrowserSource,
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
    // cycle produces, now that the service lists symlinks (#11939). Reaching
    // this bound takes one deliberate expansion per level, but the guard is
    // what stops the render walk regardless.
    const listings = listingsOf({ "": [dir("loop")], loop: [dir("loop")] });

    const rows = flattenTree(listings, new Set(["loop"]), new Set());

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(200);
  });

  it("carries a node's symlink metadata onto its row (#11939)", () => {
    // The row is what both views read to pick a glyph and describe the link,
    // so the field has to survive flattening rather than be re-fetched.
    const link: FileTreeNode = {
      name: "aliased",
      path: "aliased",
      isDirectory: true,
      symlink: { target: "/repo/real", targetKind: "directory" },
    };
    const listings = listingsOf({ "": [link, file("README.md")] });

    const rows = flattenTree(listings, new Set(), new Set());

    expect(rows[0]?.symlink).toEqual(link.symlink);
    // Absent — not null, not a placeholder — on everything else, which is what
    // lets every existing consumer keep ignoring it.
    expect(rows[1]).not.toHaveProperty("symlink");
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
      {
        path: "a",
        name: "a",
        isDirectory: true,
        depth: 0,
        isExpanded: true,
        isLoading: false,
        posInSet: 1,
        setSize: 1,
      },
      {
        path: "a/b",
        name: "b",
        isDirectory: true,
        depth: 1,
        isExpanded: true,
        isLoading: false,
        posInSet: 1,
        setSize: 1,
      },
      {
        path: "a/b/c",
        name: "c",
        isDirectory: false,
        depth: 2,
        isExpanded: false,
        isLoading: false,
        posInSet: 1,
        setSize: 1,
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

  // ---- Scoped targets (#12244) ----

  const scopedListings = () =>
    listingsOf({
      "": [dir("a"), dir("b"), file("top.txt")],
      a: [dir("a/deep"), file("a/one.ts")],
      "a/deep": [file("a/deep/two.ts")],
      b: [file("b/three.ts")],
    });
  const scopedExpanded = new Set(["a", "a/deep", "b"]);

  it("emits only the affected directory, and does not add the root for free", () => {
    expect(
      refreshTargets(scopedListings(), scopedExpanded, "", undefined, null, new Set(["a/deep"]))
    ).toEqual(["a/deep"]);
  });

  it("emits the root exactly when a top-level entry changed", () => {
    // The affected set names PARENTS, so "" appears in it precisely when
    // something directly inside the root moved.
    expect(
      refreshTargets(scopedListings(), scopedExpanded, "", undefined, null, new Set([""]))
    ).toEqual([""]);
  });

  it("reaches an affected descendant through unaffected ancestors", () => {
    // `a` is not in the set and must not be re-read, but the walk still has to
    // pass through it to establish that `a/deep` is reachable at all.
    expect(
      refreshTargets(scopedListings(), scopedExpanded, "", undefined, null, new Set(["a/deep"]))
    ).toEqual(["a/deep"]);
  });

  it("still refuses an affected directory that is unreachable or hidden", () => {
    const isVisible = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });
    const listings = listingsOf({
      "": [dir(".cache"), dir("src")],
      ".cache": [dir(".cache/inner")],
      src: [file("src/a.ts")],
    });

    // Affected, expanded, and still not a target: it renders no row, and a
    // scoped refresh narrows the full answer rather than bypassing it.
    expect(
      refreshTargets(
        listings,
        new Set([".cache", ".cache/inner", "src"]),
        "",
        isVisible,
        null,
        new Set([".cache/inner"])
      )
    ).toEqual([]);
    // Same for a directory nothing has a row for at all.
    expect(
      refreshTargets(
        scopedListings(),
        scopedExpanded,
        "",
        undefined,
        null,
        new Set(["never/listed"])
      )
    ).toEqual([]);
  });

  it("returns nothing for a burst that resolved to no directory", () => {
    expect(
      refreshTargets(scopedListings(), scopedExpanded, "", undefined, null, new Set())
    ).toEqual([]);
  });

  it("takes the full answer for a null scope, exactly as omitting it does", () => {
    const full = refreshTargets(scopedListings(), scopedExpanded);
    expect(refreshTargets(scopedListings(), scopedExpanded, "", undefined, null, null)).toEqual(
      full
    );
    expect(full).toEqual(["", "a", "a/deep", "b"]);
  });

  it("re-reads the viewer's collapsed folder only when the change landed in it", () => {
    const listings = scopedListings();
    // `b` is listed for the viewer but collapsed out of the tree (#11620).
    const expanded = new Set(["a", "a/deep"]);

    expect(refreshTargets(listings, expanded, "", undefined, "b", new Set(["b"]))).toEqual(["b"]);
    expect(refreshTargets(listings, expanded, "", undefined, "b", new Set(["a/deep"]))).toEqual([
      "a/deep",
    ]);
  });

  it("scopes against a browse root without re-listing it unasked", () => {
    const listings = listingsOf({
      "": [dir("src")],
      src: [dir("src/lib"), file("src/a.ts")],
      "src/lib": [file("src/lib/util.ts")],
    });

    expect(
      refreshTargets(listings, new Set(["src/lib"]), "src", undefined, null, new Set(["src/lib"]))
    ).toEqual(["src/lib"]);
    expect(
      refreshTargets(listings, new Set(["src/lib"]), "src", undefined, null, new Set(["src"]))
    ).toEqual(["src"]);
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

  it("treats the root itself as visible — the pump gate must never drop the root target", () => {
    expect(isRowPathVisible("src", "src", showAll)).toBe(true);
    expect(isRowPathVisible(".github", ".github", hideDotfiles)).toBe(true);
  });
});

const WT_SOURCE = { kind: "worktree", worktreeId: "wt-1", basePath: "/repo" } as const;
const WS_SOURCE = { kind: "workspace", basePath: "/scratch/abc" } as const;

describe("snapshotFromListings", () => {
  it("captures structure only — size and children never reach the snapshot", () => {
    const listings = listingsOf({
      "": [dir("src"), file("README.md", { size: 1234 })],
      src: [{ name: "app.ts", path: "src/app.ts", isDirectory: false, size: 99, children: [] }],
    });

    const snapshot = snapshotFromListings(listings, WT_SOURCE, "");

    expect(snapshot).toEqual({
      worktreeId: "wt-1",
      basePath: "/repo",
      rootPath: "",
      listings: [
        {
          dirPath: "",
          nodes: [
            { name: "src", path: "src", isDirectory: true },
            { name: "README.md", path: "README.md", isDirectory: false },
          ],
        },
        {
          dirPath: "src",
          nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }],
        },
      ],
    });
  });

  it("returns null before the root listing has ever arrived", () => {
    // Only a non-root directory somehow present: nothing worth painting from.
    expect(
      snapshotFromListings(listingsOf({ src: [file("src/app.ts")] }), WT_SOURCE, "")
    ).toBeNull();
    expect(snapshotFromListings(new Map(), WT_SOURCE, "")).toBeNull();
  });

  it("keeps an empty root listing — an empty worktree is a real last-known state", () => {
    const snapshot = snapshotFromListings(listingsOf({ "": [] }), WT_SOURCE, "");
    expect(snapshot).toEqual({
      worktreeId: "wt-1",
      basePath: "/repo",
      rootPath: "",
      listings: [{ dirPath: "", nodes: [] }],
    });
  });

  it("sorts entries by path so identical content is deep-equal regardless of insertion order", () => {
    const a = new Map([
      ["", [dir("src"), dir("lib")]],
      ["src", [file("src/a.ts")]],
      ["lib", [file("lib/b.ts")]],
    ]);
    const b = new Map([
      ["lib", [file("lib/b.ts")]],
      ["", [dir("src"), dir("lib")]],
      ["src", [file("src/a.ts")]],
    ]);

    // The persistence layer's dirty diff depends on this to skip no-op writes.
    expect(snapshotFromListings(a, WT_SOURCE, "")).toEqual(snapshotFromListings(b, WT_SOURCE, ""));
  });

  it("returns null rather than truncating when the tree exceeds the persistence bounds", () => {
    const wideRoot = listingsOf({
      "": Array.from({ length: MAX_SNAPSHOT_NODES + 1 }, (_, i) => file(`f-${i}`)),
    });
    expect(snapshotFromListings(wideRoot, WT_SOURCE, "")).toBeNull();

    const manyListings = new Map([
      ["", [dir("d-0")]],
      ...Array.from({ length: MAX_SNAPSHOT_LISTINGS }, (_, i): [string, FileTreeNode[]] => [
        `d-${i}`,
        [],
      ]),
    ]);
    expect(snapshotFromListings(manyListings, WT_SOURCE, "")).toBeNull();
  });

  it("returns null when aggregate text exceeds the byte budget, independent of node count", () => {
    // Counts alone don't bound serialized size — a few hundred long paths
    // must trip the text budget well before the 10k-node cap.
    const longName = "n".repeat(Math.ceil(MAX_SNAPSHOT_TEXT_CHARS / 100));
    const listings = listingsOf({
      "": Array.from({ length: 100 }, (_, i) => file(`${longName}-${i}`)),
    });
    expect(snapshotFromListings(listings, WT_SOURCE, "")).toBeNull();
  });

  it("captures relative to a re-rooted browse root", () => {
    const listings = listingsOf({ src: [file("src/app.ts")] });
    const snapshot = snapshotFromListings(listings, WT_SOURCE, "src");
    expect(snapshot?.rootPath).toBe("src");
    expect(snapshot?.listings).toEqual([
      { dirPath: "src", nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }] },
    ]);
  });

  it("tags a workspace capture with its base and no worktree id", () => {
    const snapshot = snapshotFromListings(listingsOf({ "": [file("a.txt")] }), WS_SOURCE, "");
    // The absent worktree id is the identity, not a missing field: it is what
    // distinguishes a workspace-rooted snapshot from a worktree one (#11482).
    expect(snapshot?.worktreeId).toBeUndefined();
    expect(snapshot?.basePath).toBe("/scratch/abc");
  });
});

describe("snapshotMatchesSource", () => {
  const snapshotOf = (source: FileBrowserSource, rootPath = "") =>
    snapshotFromListings(listingsOf({ [rootPath]: [file("a.txt")] }), source, rootPath)!;

  it("matches a snapshot against the identity it was captured under", () => {
    expect(snapshotMatchesSource(snapshotOf(WT_SOURCE), WT_SOURCE, "")).toBe(true);
    expect(snapshotMatchesSource(snapshotOf(WS_SOURCE), WS_SOURCE, "")).toBe(true);
  });

  it("refuses to seed a workspace tree from a worktree snapshot and vice versa", () => {
    // Both live on the same panel record across a re-root, so a cross-kind
    // seed would paint another folder's entries as this one's.
    expect(snapshotMatchesSource(snapshotOf(WT_SOURCE), WS_SOURCE, "")).toBe(false);
    expect(snapshotMatchesSource(snapshotOf(WS_SOURCE), WT_SOURCE, "")).toBe(false);
  });

  it("refuses a workspace snapshot whose base has moved", () => {
    // A relocated project keeps its id, so the base is the only thing that
    // catches it; cold-starting is the correct self-healing outcome.
    const moved = { kind: "workspace", basePath: "/scratch/moved" } as const;
    expect(snapshotMatchesSource(snapshotOf(WS_SOURCE), moved, "")).toBe(false);
  });

  it("accepts a legacy snapshot that predates the base tag", () => {
    // Written before `basePath` existed; its worktree id already pins identity,
    // so dropping it would cost every restored panel its instant paint.
    const { basePath: _dropped, ...legacy } = snapshotOf(WT_SOURCE);
    expect(snapshotMatchesSource(legacy, WT_SOURCE, "")).toBe(true);
  });

  it("refuses an identity-less snapshot rather than matching every workspace", () => {
    // No worktree id and no base: the legacy tolerance must not extend here, or
    // a corrupt record would paint its rows in any workspace at all.
    const { basePath: _dropped, ...untagged } = snapshotOf(WS_SOURCE);
    expect(snapshotMatchesSource(untagged, WS_SOURCE, "")).toBe(false);
  });

  it("refuses a snapshot captured at a different browse root", () => {
    expect(snapshotMatchesSource(snapshotOf(WT_SOURCE, "src"), WT_SOURCE, "")).toBe(false);
  });
});

describe("sourceIdentityKey", () => {
  it("separates a worktree from a workspace sharing the same path", () => {
    // The kind is part of the key so opening a project root and a worktree
    // that happens to live at the same path aren't one identity.
    const key = sourceIdentityKey({ kind: "worktree", worktreeId: "/repo", basePath: "/repo" });
    expect(key).not.toBe(sourceIdentityKey({ kind: "workspace", basePath: "/repo" }));
  });

  it("changes whenever the tree must reset, and only then", () => {
    const a = { kind: "workspace", basePath: "/scratches/one" } as const;
    // A rebuilt-but-equivalent source keeps the same key, so the pane's
    // per-render object churn can't reset the tree; a real move changes it.
    expect(sourceIdentityKey({ ...a })).toBe(sourceIdentityKey(a));
    expect(sourceIdentityKey({ ...a, basePath: "/scratches/two" })).not.toBe(sourceIdentityKey(a));
  });
});

describe("listingsFromSnapshot", () => {
  it("round-trips a captured snapshot back into a renderable listings map", () => {
    const listings = listingsOf({
      "": [dir("src"), file("README.md")],
      src: [file("src/app.ts")],
    });

    const snapshot = snapshotFromListings(listings, WT_SOURCE, "");
    const restored = listingsFromSnapshot(snapshot!);

    // The restored map must flatten to the same rows the live tree showed.
    expect(pathsOf(flattenTree(restored, new Set(["src"]), new Set()))).toEqual(
      pathsOf(flattenTree(listings, new Set(["src"]), new Set()))
    );
  });

  it("drops symlink metadata but keeps the bit that decides expandability (#11939)", () => {
    // The snapshot is structure-only by design — no sizes, no timestamps, no
    // symlink detail. What must survive is `isDirectory`, because that alone
    // is what stops a restored external link from being fetched: the listing
    // never sets it true for a link it could not resolve inside the root.
    const external: FileTreeNode = {
      name: "outward",
      path: "outward",
      isDirectory: false,
      symlink: { target: "/elsewhere", targetKind: "external" },
    };
    const inRoot: FileTreeNode = {
      name: "aliased",
      path: "aliased",
      isDirectory: true,
      symlink: { target: "/repo/real", targetKind: "directory" },
    };

    const snapshot = snapshotFromListings(listingsOf({ "": [external, inRoot] }), WT_SOURCE, "");
    const restored = listingsFromSnapshot(snapshot!)?.get("");

    expect(restored?.map((node) => ({ name: node.name, isDirectory: node.isDirectory }))).toEqual([
      { name: "outward", isDirectory: false },
      { name: "aliased", isDirectory: true },
    ]);
    // Degraded to a plain row, not a wrong one: the glyph and the description
    // come back with the next live listing.
    expect(restored?.every((node) => node.symlink === undefined)).toBe(true);
  });
});

describe("sortFileNodes", () => {
  const SORT_NAME_DESC = { key: "name", direction: "desc" } as const;
  const SORT_SIZE_ASC = { key: "size", direction: "asc" } as const;
  const SORT_SIZE_DESC = { key: "size", direction: "desc" } as const;
  const SORT_MODIFIED_DESC = { key: "modified", direction: "desc" } as const;
  const SORT_TYPE_ASC = { key: "type", direction: "asc" } as const;

  it("returns the input array itself for the default order", () => {
    // Identity, not just equality: the service already emits this order, so the
    // default path must allocate nothing and keep the memoized rows stable.
    const nodes = [dir("src"), file("a.ts")];
    expect(sortFileNodes(nodes, DEFAULT_FILE_SORT)).toBe(nodes);
  });

  it("keeps directories ahead of files in both directions", () => {
    const nodes = [file("b.ts", { size: 1 }), dir("zz"), file("a.ts", { size: 9 })];
    for (const sort of [SORT_SIZE_ASC, SORT_SIZE_DESC, SORT_NAME_DESC]) {
      const sorted = sortFileNodes(nodes, sort);
      expect(sorted[0]?.isDirectory).toBe(true);
      expect(sorted.slice(1).every((node) => !node.isDirectory)).toBe(true);
    }
  });

  it("orders files by size and reverses on descending", () => {
    const nodes = [
      file("big.ts", { size: 300 }),
      file("mid.ts", { size: 20 }),
      file("sm.ts", { size: 1 }),
    ];
    expect(sortFileNodes(nodes, SORT_SIZE_ASC).map((n) => n.name)).toEqual([
      "sm.ts",
      "mid.ts",
      "big.ts",
    ]);
    expect(sortFileNodes(nodes, SORT_SIZE_DESC).map((n) => n.name)).toEqual([
      "big.ts",
      "mid.ts",
      "sm.ts",
    ]);
  });

  it("sorts nodes with no size last in BOTH directions", () => {
    // A snapshot-restored node carries no size. It is missing data, not a small
    // value, so a descending sort must not float it to the top.
    const nodes = [
      file("known.ts", { size: 10 }),
      file("unknown.ts"),
      file("other.ts", { size: 2 }),
    ];
    expect(sortFileNodes(nodes, SORT_SIZE_ASC).at(-1)?.name).toBe("unknown.ts");
    expect(sortFileNodes(nodes, SORT_SIZE_DESC).at(-1)?.name).toBe("unknown.ts");
  });

  it("sorts nodes with no mtime last in BOTH directions", () => {
    const nodes = [
      file("new.ts", { mtimeMs: 900 }),
      file("stale.ts"),
      file("old.ts", { mtimeMs: 5 }),
    ];
    expect(sortFileNodes(nodes, { key: "modified", direction: "asc" }).at(-1)?.name).toBe(
      "stale.ts"
    );
    expect(sortFileNodes(nodes, SORT_MODIFIED_DESC).at(-1)?.name).toBe("stale.ts");
  });

  it("falls back to name order when every node lacks the sorted field", () => {
    // The restored-panel case: structure-only nodes must still land in a
    // sensible, deterministic order rather than whatever the map iterated.
    const nodes = [file("c.ts"), file("a.ts"), file("b.ts")];
    expect(sortFileNodes(nodes, SORT_SIZE_ASC).map((n) => n.name)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("groups by extension when sorting by type", () => {
    const nodes = [file("b.ts"), file("a.md"), file("c.ts"), file("d.md")];
    expect(sortFileNodes(nodes, SORT_TYPE_ASC).map((n) => n.name)).toEqual([
      "a.md",
      "d.md",
      "b.ts",
      "c.ts",
    ]);
  });

  it("treats a dotfile as having no extension rather than splitting its name", () => {
    const nodes = [file("a.ts"), file(".gitignore")];
    // "" sorts before "ts", so the dotfile leads — it is not filed under
    // "gitignore" as a type.
    expect(sortFileNodes(nodes, SORT_TYPE_ASC).map((n) => n.name)).toEqual([".gitignore", "a.ts"]);
  });

  it("breaks ties on name in the same direction as the primary key", () => {
    const nodes = [file("a.ts", { size: 5 }), file("b.ts", { size: 5 })];
    expect(sortFileNodes(nodes, SORT_SIZE_ASC).map((n) => n.name)).toEqual(["a.ts", "b.ts"]);
    expect(sortFileNodes(nodes, SORT_SIZE_DESC).map((n) => n.name)).toEqual(["b.ts", "a.ts"]);
  });

  it("does not mutate the array it was given", () => {
    // The listings map it reads from is what gets persisted and what unsorted
    // consumers read, so sorting has to be non-destructive.
    const nodes = [file("b.ts", { size: 2 }), file("a.ts", { size: 1 })];
    const before = nodes.map((n) => n.name);
    sortFileNodes(nodes, SORT_SIZE_DESC);
    expect(nodes.map((n) => n.name)).toEqual(before);
  });
});

describe("flattenTree sorting", () => {
  it("orders each level independently rather than across the whole tree", () => {
    const listings = listingsOf({
      "": [dir("src"), file("z.ts", { size: 1 })],
      src: [file("src/b.ts", { size: 900 }), file("src/a.ts", { size: 2 })],
    });

    const rows = flattenTree(listings, new Set(["src"]), new Set(), "", undefined, {
      key: "size",
      direction: "desc",
    });

    // The root's own entries are ordered among themselves (dir first, then the
    // file); src's children are ordered among themselves — the 900-byte child
    // does not jump above the root-level file.
    expect(pathsOf(rows)).toEqual(["src", "src/b.ts", "src/a.ts", "z.ts"]);
  });

  it("leaves the tree in service order for the default sort", () => {
    const listings = listingsOf({ "": [dir("src"), file("a.ts", { size: 500 })] });
    expect(
      pathsOf(flattenTree(listings, new Set(), new Set(), "", undefined, DEFAULT_FILE_SORT))
    ).toEqual(pathsOf(flattenTree(listings, new Set(), new Set())));
  });
});

describe("buildFolderListingRows", () => {
  it("carries symlink metadata onto a listing row (#11939)", () => {
    const link: FileTreeNode = {
      name: "acorn",
      path: ".bin/acorn",
      isDirectory: false,
      symlink: { target: "/repo/acorn/bin/acorn", targetKind: "file" },
    };
    const rows = buildFolderListingRows(listingsOf({ ".bin": [link] }), ".bin");

    expect(rows?.[0]?.symlink).toEqual(link.symlink);
  });

  it("returns null for a directory that has not been listed", () => {
    // Distinguishable from an empty array on purpose: null is "still pending",
    // [] is "this folder really holds nothing".
    expect(buildFolderListingRows(listingsOf({ "": [dir("src")] }), "src")).toBeNull();
  });

  it("returns an empty array for a listed but empty directory", () => {
    expect(buildFolderListingRows(listingsOf({ "": [dir("src")], src: [] }), "src")).toEqual([]);
  });

  it("carries size and mtime through, and omits them when absent", () => {
    const listings = listingsOf({
      src: [file("src/a.ts", { size: 12, mtimeMs: 1_700_000 }), file("src/b.ts")],
    });
    const rows = buildFolderListingRows(listings, "src")!;
    expect(rows[0]).toMatchObject({ path: "src/a.ts", size: 12, mtimeMs: 1_700_000 });
    expect(rows[1]?.size).toBeUndefined();
    expect(rows[1]?.mtimeMs).toBeUndefined();
  });

  it("applies the same visibility filter the tree uses", () => {
    const listings = listingsOf({ src: [file("src/.env"), file("src/a.ts")] });
    const isVisible = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });
    expect(buildFolderListingRows(listings, "src", isVisible)!.map((r) => r.name)).toEqual([
      "a.ts",
    ]);
  });

  it("counts a child folder's items only when that folder is already cached", () => {
    const listings = listingsOf({
      src: [dir("src/known"), dir("src/unknown")],
      "src/known": [file("src/known/a.ts"), file("src/known/b.ts")],
    });
    const rows = buildFolderListingRows(listings, "src")!;
    expect(rows.find((r) => r.name === "known")?.itemCount).toBe(2);
    // Never fetched, never walked — the column says nothing rather than "0".
    expect(rows.find((r) => r.name === "unknown")?.itemCount).toBeUndefined();
  });

  it("counts only the visible entries of a child folder", () => {
    const listings = listingsOf({
      src: [dir("src/nested")],
      "src/nested": [file("src/nested/.env"), file("src/nested/a.ts")],
    });
    const isVisible = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });
    // The count has to agree with what opening the folder would actually show.
    expect(buildFolderListingRows(listings, "src", isVisible)![0]?.itemCount).toBe(1);
  });

  it("never reports a byte size for a directory row", () => {
    const listings = listingsOf({ src: [dir("src/nested")] });
    expect(buildFolderListingRows(listings, "src")![0]?.size).toBeUndefined();
  });

  it("orders rows by the requested sort, folders first", () => {
    const listings = listingsOf({
      src: [file("src/a.ts", { size: 1 }), dir("src/z"), file("src/b.ts", { size: 900 })],
    });
    const rows = buildFolderListingRows(listings, "src", undefined, {
      key: "size",
      direction: "desc",
    })!;
    expect(rows.map((r) => r.name)).toEqual(["z", "b.ts", "a.ts"]);
  });
});

describe("findNodeInListings", () => {
  it("resolves a node through its parent directory's listing", () => {
    const listings = listingsOf({ "": [dir("src")], src: [file("src/a.ts", { size: 4 })] });
    expect(findNodeInListings(listings, "src/a.ts")?.size).toBe(4);
  });

  it("resolves a root-level entry", () => {
    expect(findNodeInListings(listingsOf({ "": [dir("src")] }), "src")?.isDirectory).toBe(true);
  });

  it("returns undefined when the parent directory has not been listed", () => {
    // The pruned-parent case: unknown, which the caller must not treat as a file.
    expect(findNodeInListings(listingsOf({ "": [dir("src")] }), "src/a.ts")).toBeUndefined();
  });

  it("answers for an entry whose parent is not expanded in the tree", () => {
    // The whole reason this exists: the folder listing selects entries the tree
    // has no row for, and those must still resolve to a real kind.
    const listings = listingsOf({ "": [dir("src")], src: [file("src/deep.ts")] });
    const rows = flattenTree(listings, new Set(), new Set());
    expect(pathsOf(rows)).not.toContain("src/deep.ts");
    expect(findNodeInListings(listings, "src/deep.ts")?.isDirectory).toBe(false);
  });
});

describe("pruneListings keepPath", () => {
  it("retains the folder being listed even when it is not expanded", () => {
    const listings = listingsOf({
      "": [dir("src")],
      src: [file("src/a.ts")],
    });
    expect([...pruneListings(listings, new Set(), "", ["src"]).keys()]).toEqual(["", "src"]);
  });

  it("still drops other collapsed directories alongside the retained one", () => {
    const listings = listingsOf({
      "": [dir("src"), dir("docs")],
      src: [file("src/a.ts")],
      docs: [file("docs/b.md")],
    });
    expect([...pruneListings(listings, new Set(), "", ["src"]).keys()]).toEqual(["", "src"]);
  });

  it("drops everything but the root when no folder is being listed", () => {
    const listings = listingsOf({ "": [dir("src")], src: [file("src/a.ts")] });
    expect([...pruneListings(listings, new Set(), "").keys()]).toEqual([""]);
  });
});

describe("refreshTargets keepPath", () => {
  it("re-lists the folder being viewed even though it is collapsed", () => {
    const listings = listingsOf({ "": [dir("src")], src: [file("src/a.ts")] });
    expect(refreshTargets(listings, new Set(), "", undefined, "src")).toEqual(["", "src"]);
  });

  it("does not list the viewed folder twice when it is also expanded", () => {
    const listings = listingsOf({ "": [dir("src")], src: [file("src/a.ts")] });
    expect(refreshTargets(listings, new Set(["src"]), "", undefined, "src")).toEqual(["", "src"]);
  });

  it("does not duplicate the root when the root itself is being viewed", () => {
    const listings = listingsOf({ "": [dir("src")] });
    expect(refreshTargets(listings, new Set(), "", undefined, "")).toEqual([""]);
  });
});

describe("parentDirectoryOf", () => {
  it("names the directory a path lives in", () => {
    expect(parentDirectoryOf("src/lib/util.ts")).toBe("src/lib");
  });

  it("returns the root for a top-level entry", () => {
    expect(parentDirectoryOf("README.md")).toBe("");
  });
});

describe("pruneListings retains what the selection needs", () => {
  it("keeps the parent that answers what a selected file is", () => {
    // Clicking a file inside a folder listing turns that folder from "being
    // listed" into "merely the parent". Dropping it right then would forget the
    // file's own kind at the exact moment it was selected — the viewer would
    // blank on the click that was supposed to open it.
    const listings = listingsOf({ "": [dir("src")], src: [file("src/a.ts")] });
    expect([...pruneListings(listings, new Set(), "", ["src"]).keys()]).toContain("src");
  });

  it("keeps both the listed folder and the selection's parent at once", () => {
    const listings = listingsOf({
      "": [dir("src"), dir("docs")],
      src: [file("src/a.ts")],
      docs: [file("docs/b.md")],
    });
    expect([...pruneListings(listings, new Set(), "", ["docs", "src"]).keys()].sort()).toEqual([
      "",
      "docs",
      "src",
    ]);
  });

  it("still drops a collapsed directory nothing is depending on", () => {
    const listings = listingsOf({
      "": [dir("src"), dir("docs")],
      src: [file("src/a.ts")],
      docs: [file("docs/b.md")],
    });
    expect([...pruneListings(listings, new Set(), "", ["src"]).keys()]).toEqual(["", "src"]);
  });
});

describe("sortFileNodes stays a valid total order", () => {
  // A comparator that is not antisymmetric is undefined behaviour for
  // Array.prototype.sort, so these are laws, not preferences. Corrupt metadata
  // is the realistic source: a hand-edited or migrated record can carry a value
  // the filesystem would never produce.
  const ODD_VALUES = [undefined, 0, 1, 1024, Number.NaN, Infinity, -Infinity];

  function nodesFor(key: "size" | "modified") {
    return ODD_VALUES.map((value, index) =>
      file(`f${index}.ts`, value === undefined ? {} : { [key]: value })
    );
  }

  for (const key of ["size", "modified"] as const) {
    for (const direction of ["asc", "desc"] as const) {
      it(`is antisymmetric for ${key}/${direction} across corrupt values`, () => {
        const nodes = nodesFor(key);
        const sorted = sortFileNodes(nodes, { key, direction });
        // Sorting is deterministic and stable across repeats — the observable
        // consequence of a consistent comparator.
        expect(sortFileNodes(nodes, { key, direction }).map((n) => n.name)).toEqual(
          sorted.map((n) => n.name)
        );
        // And reversing the input cannot change the result of a total order.
        expect(sortFileNodes([...nodes].reverse(), { key, direction }).map((n) => n.name)).toEqual(
          sorted.map((n) => n.name)
        );
      });
    }
  }

  it("treats a NaN size as unknown rather than as a value", () => {
    // NaN compares false against everything including itself; left in-band it
    // would make the comparator report `a > b` and `b > a` at once.
    const nodes = [file("nan.ts", { size: Number.NaN }), file("real.ts", { size: 5 })];
    expect(sortFileNodes(nodes, { key: "size", direction: "asc" }).at(-1)?.name).toBe("nan.ts");
    expect(sortFileNodes(nodes, { key: "size", direction: "desc" }).at(-1)?.name).toBe("nan.ts");
  });

  it("treats an infinite mtime as unknown rather than as the newest file", () => {
    const nodes = [file("inf.ts", { mtimeMs: Infinity }), file("real.ts", { mtimeMs: 5 })];
    expect(sortFileNodes(nodes, { key: "modified", direction: "desc" }).at(-1)?.name).toBe(
      "inf.ts"
    );
  });
});
