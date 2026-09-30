import { bench, describe } from "vitest";
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

// A restored tree: the root plus 59 expanded folders, 400 entries each, landing
// one by one. Each landing is what `useFileBrowserTree` recomputes: rows twice
// (listings, then loadingPaths) and the hidden-row badge once.
const DIRS = 60;
const ENTRIES = 400;

function makeListing(dirPath: string, childDirs: string[]): FileTreeNode[] {
  const prefix = dirPath === "" ? "" : `${dirPath}/`;
  const nodes: FileTreeNode[] = childDirs.map((name) => ({
    name,
    path: `${prefix}${name}`,
    isDirectory: true,
  }));
  for (let i = nodes.length; i < ENTRIES; i++) {
    const name =
      i % 40 === 0 ? `.hidden${i}` : i % 97 === 0 ? ".DS_Store" : `file${(i * 7919) % 1000}.ts`;
    nodes.push({
      name,
      path: `${prefix}${name}-${i}`,
      isDirectory: false,
      size: (i * 131) % 5000,
      mtimeMs: 1_700_000_000_000 + ((i * 104729) % 1_000_000),
    });
  }
  return nodes;
}

const SUBDIRS = Array.from({ length: DIRS - 1 }, (_, i) => `dir${i}`);
const TEMPLATES = new Map<string, FileTreeNode[]>([["", makeListing("", SUBDIRS)]]);
for (const dir of SUBDIRS) TEMPLATES.set(dir, makeListing(dir, []));
const LANDING_ORDER = ["", ...SUBDIRS];
const EXPANDED: ReadonlySet<string> = new Set(SUBDIRS);

const VISIBILITY: FileVisibility = {
  hideDotfiles: true,
  alwaysHiddenPatterns: [".DS_Store", "Thumbs.db", "desktop.ini", "._*", ".git"],
};
const IS_VISIBLE = createVisibilityFilter(VISIBILITY);

const SORTS: Array<[string, FileBrowserSortOrder]> = [
  ["name asc (default)", DEFAULT_FILE_SORT],
  ["modified desc", { key: "modified", direction: "desc" }],
];

type Impl = {
  flatten: typeof flattenTree;
  count: typeof countHiddenRows;
};
const IMPLS: Array<[string, Impl]> = [
  ["baseline (SDK per call)", { flatten: flattenTree, count: countHiddenRows }],
  [
    "memo",
    {
      flatten: (l, e, lp, r = "", v, s = DEFAULT_FILE_SORT) => flattenTreeMemo(l, e, lp, r, v, s),
      count: (l, e, r = "", v) => countHiddenRowsMemo(l, e, r, v),
    },
  ],
];

function land(
  impl: Impl,
  listings: Map<string, readonly FileTreeNode[]>,
  loading: Set<string>,
  dir: string,
  sort: FileBrowserSortOrder
): Map<string, readonly FileTreeNode[]> {
  // A fetch always stores a fresh array, never the one a previous replay cached.
  const next = new Map(listings).set(dir, TEMPLATES.get(dir)!.slice());
  impl.flatten(next, EXPANDED, loading, "", IS_VISIBLE, sort);
  impl.count(next, EXPANDED, "", VISIBILITY);
  const nextLoading = new Set(loading);
  nextLoading.delete(dir);
  impl.flatten(next, EXPANDED, nextLoading, "", IS_VISIBLE, sort);
  return next;
}

function replay(impl: Impl, sort: FileBrowserSortOrder, upTo = LANDING_ORDER.length) {
  let listings = new Map<string, readonly FileTreeNode[]>();
  const loading = new Set(LANDING_ORDER);
  for (const dir of LANDING_ORDER.slice(0, upTo)) {
    listings = land(impl, listings, loading, dir, sort);
    loading.delete(dir);
  }
  return { listings, loading };
}

// Sort and comparator call counts for one full replay, printed once.
{
  type Sort = (this: unknown[], cmp?: (a: unknown, b: unknown) => number) => unknown[];
  const originalSort: Sort = Array.prototype.sort;
  for (const [sortName, sort] of SORTS) {
    for (const [implName, impl] of IMPLS) {
      let sorts = 0;
      let compares = 0;
      const countingSort: Sort = function (this: unknown[], cmp) {
        sorts += 1;
        return originalSort.call(this, cmp && ((a, b) => (compares++, cmp(a, b))));
      };
      Array.prototype.sort = countingSort;
      try {
        replay(impl, sort);
      } finally {
        Array.prototype.sort = originalSort;
      }
      process.stderr.write(
        `[counts] ${sortName} / ${implName}: ${sorts} sorts, ${compares} comparator calls\n`
      );
    }
  }
}

for (const [sortName, sort] of SORTS) {
  describe(`replay ${DIRS} landings × ${ENTRIES} entries — ${sortName}`, () => {
    for (const [implName, impl] of IMPLS) {
      bench(implName, () => {
        replay(impl, sort);
      });
    }
  });

  describe(`final landing (${DIRS - 1} already loaded) — ${sortName}`, () => {
    for (const [implName, impl] of IMPLS) {
      const { listings, loading } = replay(impl, sort, LANDING_ORDER.length - 1);
      const last = LANDING_ORDER[LANDING_ORDER.length - 1]!;
      bench(implName, () => {
        land(impl, listings, loading, last, sort);
      });
    }
  });
}
