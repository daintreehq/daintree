import { describe, it, expect } from "vitest";
import type { FileTreeNode } from "@shared/types";
import {
  countHiddenRows,
  createVisibilityFilter,
  DEFAULT_FILE_SORT,
  flattenTree,
  type FileBrowserSortOrder,
  type FileVisibility,
} from "../fileBrowserTree";
import { countHiddenRowsMemo, flattenTreeMemo } from "../fileTreeDerivations";

let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

const NAMES = [
  "file1.ts",
  "file01.ts",
  "file10.ts",
  "File2.md",
  ".env",
  ".DS_Store",
  "._resource",
  ".git",
  "Thumbs.db",
  "README",
  "archive.tar.gz",
  "z.json",
];

function makeListing(dirPath: string, childDirs: string[]): FileTreeNode[] {
  const prefix = dirPath === "" ? "" : `${dirPath}/`;
  const nodes: FileTreeNode[] = childDirs.map((name, i) => ({
    name,
    path: `${prefix}${name}`,
    isDirectory: true,
    ...(i % 3 === 0 && { mtimeMs: Math.floor(rnd() * 1000) }),
    ...(i % 4 === 1 && {
      symlink: { target: `/elsewhere/${name}`, targetKind: "directory" as const },
    }),
  }));
  for (let i = 0; i < 30; i++) {
    const name = `${NAMES[Math.floor(rnd() * NAMES.length)]}${i % 5 === 0 ? "" : i}`;
    nodes.push({
      name,
      path: `${prefix}${name}`,
      isDirectory: false,
      // Snapshot-restored nodes carry neither, so unknowns are mixed in.
      ...(i % 4 !== 0 && { size: Math.floor(rnd() * 50) }),
      ...(i % 3 !== 0 && { mtimeMs: Math.floor(rnd() * 50) }),
    });
  }
  // Unsorted on purpose (Fisher–Yates on the seeded stream): a non-default
  // sort must actually reorder.
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [nodes[i], nodes[j]] = [nodes[j]!, nodes[i]!];
  }
  return nodes;
}

function makeTree(): Map<string, readonly FileTreeNode[]> {
  seed = 7;
  const listings = new Map<string, readonly FileTreeNode[]>();
  listings.set("", makeListing("", ["src", ".git", "docs", ".hidden", "empty"]));
  listings.set("src", makeListing("src", ["components", "store"]));
  listings.set("src/components", makeListing("src/components", ["deep"]));
  listings.set("src/components/deep", makeListing("src/components/deep", []));
  listings.set(".git", makeListing(".git", ["objects"]));
  listings.set(".hidden", makeListing(".hidden", []));
  listings.set("docs", makeListing("docs", []));
  listings.set("empty", []);
  return listings;
}

const SORTS: FileBrowserSortOrder[] = [
  DEFAULT_FILE_SORT,
  { key: "name", direction: "desc" },
  { key: "type", direction: "asc" },
  { key: "type", direction: "desc" },
  { key: "size", direction: "asc" },
  { key: "size", direction: "desc" },
  { key: "modified", direction: "asc" },
  { key: "modified", direction: "desc" },
];

const VISIBILITIES: FileVisibility[] = [
  { hideDotfiles: false, alwaysHiddenPatterns: [] },
  { hideDotfiles: true, alwaysHiddenPatterns: [] },
  { hideDotfiles: false, alwaysHiddenPatterns: [".DS_Store", "._*", ".git", "Thumbs.db"] },
  { hideDotfiles: true, alwaysHiddenPatterns: [".DS_Store", "._*", ".git", "Thumbs.db"] },
];

const EXPANSIONS: ReadonlySet<string>[] = [
  new Set(),
  new Set(["src", ".git", ".hidden", "docs", "empty"]),
  new Set(["src", "src/components", "src/components/deep", "src/store", ".git/objects"]),
];

const LOADING: ReadonlySet<string> = new Set(["src/store", "src", ".git/objects"]);

describe("fixture", () => {
  it("exercises loading rows, symlinks, reordering and both hidden categories", () => {
    const listings = makeTree();
    const rows = flattenTree(listings, EXPANSIONS[2]!, LOADING, "", undefined, {
      key: "size",
      direction: "desc",
    });
    expect(rows.some((row) => row.isLoading)).toBe(true);
    expect(rows.some((row) => row.symlink !== undefined)).toBe(true);
    expect(rows.some((row) => row.depth === 3)).toBe(true);
    const defaultRows = flattenTree(listings, EXPANSIONS[2]!, LOADING, "");
    expect(rows.map((row) => row.path)).not.toEqual(defaultRows.map((row) => row.path));
    const counts = countHiddenRows(listings, new Set(listings.keys()), "", VISIBILITIES[3]!);
    expect(counts.dotfiles).toBeGreaterThan(0);
    expect(counts.alwaysHidden).toBeGreaterThan(0);
  });
});

describe("flattenTreeMemo", () => {
  it("emits byte-identical rows to flattenTree for every sort, filter and expansion", () => {
    const listings = makeTree();
    for (const sort of SORTS) {
      for (const visibility of [undefined, ...VISIBILITIES]) {
        const isVisible = visibility && createVisibilityFilter(visibility);
        for (const expanded of EXPANSIONS) {
          for (const rootPath of ["", "src", "missing"]) {
            const expected = flattenTree(listings, expanded, LOADING, rootPath, isVisible, sort);
            // Twice: once to fill the cache, once served from it.
            for (let pass = 0; pass < 2; pass++) {
              const actual = flattenTreeMemo(
                listings,
                expanded,
                LOADING,
                rootPath,
                isVisible,
                sort
              );
              expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
            }
          }
        }
      }
    }
  });

  it("stays identical across a landing replay, reusing listings between calls", () => {
    const full = makeTree();
    const expanded = new Set(full.keys());
    const isVisible = createVisibilityFilter(VISIBILITIES[3]!);
    const sort: FileBrowserSortOrder = { key: "modified", direction: "desc" };
    let listings = new Map<string, readonly FileTreeNode[]>();
    const loading = new Set(full.keys());
    for (const [dir, nodes] of full) {
      listings = new Map(listings).set(dir, nodes);
      for (const phase of [0, 1]) {
        if (phase === 1) loading.delete(dir);
        expect(
          JSON.stringify(flattenTreeMemo(listings, expanded, loading, "", isVisible, sort))
        ).toBe(JSON.stringify(flattenTree(listings, expanded, loading, "", isVisible, sort)));
      }
    }
  });

  it("re-derives when only the sort or the filter changes on the same listing", () => {
    const listings = makeTree();
    const expanded = EXPANSIONS[1]!;
    const sequence: Array<[FileBrowserSortOrder, FileVisibility | undefined]> = [
      [DEFAULT_FILE_SORT, undefined],
      [{ key: "size", direction: "asc" }, undefined],
      [{ key: "size", direction: "desc" }, undefined],
      [{ key: "size", direction: "desc" }, VISIBILITIES[1]],
      [{ key: "size", direction: "desc" }, VISIBILITIES[2]],
      [DEFAULT_FILE_SORT, VISIBILITIES[2]],
    ];
    for (const [sort, visibility] of sequence) {
      const isVisible = visibility && createVisibilityFilter(visibility);
      expect(flattenTreeMemo(listings, expanded, LOADING, "", isVisible, sort)).toEqual(
        flattenTree(listings, expanded, LOADING, "", isVisible, sort)
      );
    }
  });

  it("stops at the same depth as flattenTree on a symlink cycle", () => {
    const loop: FileTreeNode[] = [{ name: "loop", path: "loop", isDirectory: true }];
    const listings = new Map<string, readonly FileTreeNode[]>([["", loop]]);
    const expanded = new Set<string>(["loop"]);
    let path = "loop";
    for (let i = 0; i < 80; i++) {
      const child = `${path}/loop`;
      listings.set(path, [{ name: "loop", path: child, isDirectory: true }]);
      expanded.add(child);
      path = child;
    }
    const expected = flattenTree(listings, expanded, new Set(), "", undefined, DEFAULT_FILE_SORT);
    expect(
      flattenTreeMemo(listings, expanded, new Set(), "", undefined, DEFAULT_FILE_SORT)
    ).toEqual(expected);
  });

  it("reuses an unchanged listing's derivation and never derives unreachable ones", () => {
    const listings = makeTree();
    const seen: string[] = [];
    const base = createVisibilityFilter(VISIBILITIES[3]!);
    const isVisible = (name: string) => {
      seen.push(name);
      return base(name);
    };
    const sort: FileBrowserSortOrder = { key: "size", direction: "asc" };
    // Only the root and `src` are reachable: `.git` is expanded but hidden.
    const expanded = new Set(["src", ".git"]);
    flattenTreeMemo(listings, expanded, LOADING, "", isVisible, sort);
    const reachable = listings.get("")!.length + listings.get("src")!.length;
    expect(seen).toHaveLength(reachable);

    seen.length = 0;
    const landed = new Map(listings).set("docs", listings.get("docs")!.slice());
    flattenTreeMemo(landed, expanded, new Set(), "", isVisible, sort);
    expect(seen).toHaveLength(0);
  });

  it("does not reorder the listings it was given", () => {
    const listings = makeTree();
    const before = JSON.stringify([...listings]);
    flattenTreeMemo(listings, EXPANSIONS[1]!, LOADING, "", undefined, {
      key: "type",
      direction: "desc",
    });
    expect(JSON.stringify([...listings])).toBe(before);
  });
});

describe("a refreshed listing at the same path", () => {
  it("is re-derived rather than served from the replaced array's cache", () => {
    const listings = makeTree();
    const expanded = new Set(listings.keys());
    const isVisible = createVisibilityFilter(VISIBILITIES[3]!);
    const visibility = VISIBILITIES[3]!;
    const sort: FileBrowserSortOrder = { key: "type", direction: "asc" };
    flattenTreeMemo(listings, expanded, LOADING, "", isVisible, sort);
    countHiddenRowsMemo(listings, expanded, "", visibility);

    const refreshed = new Map(listings).set("src", [
      { name: "components", path: "src/components", isDirectory: true },
      { name: ".env.local", path: "src/.env.local", isDirectory: false },
      { name: ".DS_Store", path: "src/.DS_Store", isDirectory: false },
      { name: "added.ts", path: "src/added.ts", isDirectory: false, size: 3 },
    ]);
    const rows = flattenTreeMemo(refreshed, expanded, LOADING, "", isVisible, sort);
    expect(rows).toEqual(flattenTree(refreshed, expanded, LOADING, "", isVisible, sort));
    expect(rows.some((row) => row.path === "src/added.ts")).toBe(true);
    expect(rows.some((row) => row.path === "src/store")).toBe(false);
    expect(countHiddenRowsMemo(refreshed, expanded, "", visibility)).toEqual(
      countHiddenRows(refreshed, expanded, "", visibility)
    );
  });
});

describe("countHiddenRowsMemo", () => {
  it("re-derives when only the dotfile toggle, or only the junk list, changes", () => {
    const listings = makeTree();
    const expanded = new Set(listings.keys());
    const patterns = [".DS_Store", "._*"];
    const sequence: FileVisibility[] = [
      { hideDotfiles: false, alwaysHiddenPatterns: patterns },
      { hideDotfiles: true, alwaysHiddenPatterns: patterns },
      { hideDotfiles: true, alwaysHiddenPatterns: [".DS_Store"] },
      { hideDotfiles: true, alwaysHiddenPatterns: patterns },
    ];
    const results = sequence.map((visibility) => {
      const expected = countHiddenRows(listings, expanded, "", visibility);
      expect(countHiddenRowsMemo(listings, expanded, "", visibility)).toEqual(expected);
      return expected;
    });
    // Each step really changes the answer, so a key ignoring either input fails.
    expect(results[1]).not.toEqual(results[0]);
    expect(results[2]).not.toEqual(results[1]);
    expect(results[3]).not.toEqual(results[2]);
  });

  it("stops at the same depth as countHiddenRows on a deep expanded chain", () => {
    const listings = new Map<string, readonly FileTreeNode[]>();
    const expanded = new Set<string>();
    let path = "";
    for (let i = 0; i < 80; i++) {
      const prefix = path === "" ? "" : `${path}/`;
      const child = `${prefix}d`;
      listings.set(path, [
        { name: "d", path: child, isDirectory: true },
        { name: ".env", path: `${prefix}.env`, isDirectory: false },
        { name: ".DS_Store", path: `${prefix}.DS_Store`, isDirectory: false },
      ]);
      expanded.add(child);
      path = child;
    }
    const visibility = VISIBILITIES[3]!;
    const expected = countHiddenRows(listings, expanded, "", visibility);
    expect(expected.dotfiles).toBeGreaterThan(0);
    expect(expected.dotfiles).toBeLessThan(80);
    expect(countHiddenRowsMemo(listings, expanded, "", visibility)).toEqual(expected);
  });

  it("matches countHiddenRows for every filter, expansion and root", () => {
    const listings = makeTree();
    for (const visibility of VISIBILITIES) {
      for (const expanded of [...EXPANSIONS, new Set(listings.keys())]) {
        for (const rootPath of ["", "src", ".git", "missing"]) {
          const expected = countHiddenRows(listings, expanded, rootPath, visibility);
          for (let pass = 0; pass < 2; pass++) {
            expect(countHiddenRowsMemo(listings, expanded, rootPath, visibility)).toEqual(expected);
          }
        }
      }
    }
  });

  it("re-derives when the visibility changes on the same listing", () => {
    const listings = makeTree();
    const expanded = new Set(listings.keys());
    for (const visibility of [...VISIBILITIES, ...VISIBILITIES.slice().reverse()]) {
      expect(countHiddenRowsMemo(listings, expanded, "", visibility)).toEqual(
        countHiddenRows(listings, expanded, "", visibility)
      );
    }
  });
});
