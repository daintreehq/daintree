import { describe, it, expect } from "vitest";
import { countHiddenRows, flattenTree, type DirectoryListings } from "../fileBrowserTree";
import type { FileTreeNode } from "@shared/types";

function node(path: string, isDirectory = false): FileTreeNode {
  return {
    path,
    name: path.split("/").pop()!,
    isDirectory,
  } as FileTreeNode;
}

function listings(entries: Record<string, string[]>): DirectoryListings {
  const map = new Map<string, readonly FileTreeNode[]>();
  for (const [dir, names] of Object.entries(entries)) {
    map.set(
      dir,
      names.map((name) => {
        const isDirectory = name.endsWith("/");
        const bare = isDirectory ? name.slice(0, -1) : name;
        return node(dir === "" ? bare : `${dir}/${bare}`, isDirectory);
      })
    );
  }
  return map;
}

const JUNK = [".DS_Store", ".git"];

describe("countHiddenRows", () => {
  it("counts nothing when no filter is removing anything", () => {
    const tree = listings({ "": ["src/", "README.md"] });
    expect(
      countHiddenRows(tree, new Set(), "", { hideDotfiles: false, alwaysHiddenPatterns: [] })
    ).toEqual({ dotfiles: 0, alwaysHidden: 0 });
  });

  it("attributes each hidden row to the filter that can actually reveal it", () => {
    // The categories exist because their recoveries differ — one is a toggle in
    // this panel, the other an app-global setting. Merging them would offer a
    // fix that does not work for half the rows it claims.
    const tree = listings({ "": ["src/", ".env", ".npmrc", ".DS_Store", ".git/"] });
    expect(
      countHiddenRows(tree, new Set(), "", { hideDotfiles: true, alwaysHiddenPatterns: JUNK })
    ).toEqual({ dotfiles: 2, alwaysHidden: 2 });
  });

  it("does not credit the dotfile toggle with rows only the junk list is hiding", () => {
    // `.DS_Store` is a dotfile AND junk. Counting it as a dotfile would promise
    // that turning the toggle off reveals it, which it does not.
    const tree = listings({ "": [".DS_Store"] });
    const withToggleOn = countHiddenRows(tree, new Set(), "", {
      hideDotfiles: true,
      alwaysHiddenPatterns: JUNK,
    });
    const withToggleOff = countHiddenRows(tree, new Set(), "", {
      hideDotfiles: false,
      alwaysHiddenPatterns: JUNK,
    });
    expect(withToggleOn.dotfiles).toBe(0);
    // And the junk tally is indifferent to the toggle, because the toggle has
    // no power over it.
    expect(withToggleOn.alwaysHidden).toBe(withToggleOff.alwaysHidden);
  });

  it("counts only what the visible branches hide, never what a collapsed one might", () => {
    // The number has to describe rows the user could otherwise see right now.
    // Counting into unexpanded folders would make the badge climb on its own as
    // listings arrive, for rows that are behind a closed parent anyway.
    const tree = listings({ "": ["src/"], src: [".env", "index.ts"] });
    const collapsed = countHiddenRows(tree, new Set(), "", {
      hideDotfiles: true,
      alwaysHiddenPatterns: [],
    });
    const expanded = countHiddenRows(tree, new Set(["src"]), "", {
      hideDotfiles: true,
      alwaysHiddenPatterns: [],
    });
    expect(collapsed.dotfiles).toBe(0);
    expect(expanded.dotfiles).toBe(1);
  });

  it("agrees with the tree: every row it counts is one flattenTree left out", () => {
    // The invariant that keeps the badge honest, rather than a hardcoded total:
    // hidden + rendered must equal what the same visible branches hold.
    const tree = listings({ "": ["src/", ".env", ".DS_Store"], src: [".secret", "index.ts"] });
    const expanded = new Set(["src"]);
    const visibility = { hideDotfiles: true, alwaysHiddenPatterns: JUNK };

    const isVisible = (name: string): boolean => {
      if (JUNK.includes(name)) return false;
      return !name.startsWith(".");
    };
    const rendered = flattenTree(tree, expanded, new Set(), "", isVisible);
    const hidden = countHiddenRows(tree, expanded, "", visibility);

    const totalInVisibleBranches = (tree.get("")?.length ?? 0) + (tree.get("src")?.length ?? 0);
    expect(rendered.length + hidden.dotfiles + hidden.alwaysHidden).toBe(totalInVisibleBranches);
  });
});

describe("flattenTree sibling metadata", () => {
  it("numbers each row among the siblings that actually render, not the raw listing", () => {
    // The APG position a screen reader announces has to match what is on
    // screen; counting pre-filter would announce "3 of 5" in a list of three.
    const tree = listings({ "": [".env", "a.ts", ".npmrc", "b.ts", "c.ts"] });
    const rows = flattenTree(tree, new Set(), new Set(), "", (name) => !name.startsWith("."));

    expect(rows.map((r) => r.name)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(rows.map((r) => r.posInSet)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.setSize === rows.length)).toBe(true);
  });

  it("restarts the numbering inside each expanded folder", () => {
    // Position is per-level. A flat running index would tell a screen reader a
    // child is "4 of 6" of its parent's siblings.
    const tree = listings({ "": ["src/", "z.ts"], src: ["one.ts", "two.ts"] });
    const rows = flattenTree(tree, new Set(["src"]), new Set(), "");

    const children = rows.filter((r) => r.depth === 1);
    expect(children.map((r) => r.posInSet)).toEqual([1, 2]);
    expect(children.every((r) => r.setSize === 2)).toBe(true);

    const top = rows.filter((r) => r.depth === 0);
    expect(top.every((r) => r.setSize === 2)).toBe(true);
  });
});
