import { describe, it, expect } from "vitest";
import type { FileTreeNode } from "@shared/types";
import type { FlatTreeRow } from "../fileBrowserTree";
import { missingRowStatus, pickCursorReplacement } from "../treeCursor";

function node(path: string, isDirectory = false): FileTreeNode {
  return { name: path.split("/").pop() as string, path, isDirectory };
}

function row(path: string, isDirectory = false, isExpanded = false): FlatTreeRow {
  return {
    path,
    name: path.split("/").pop() as string,
    isDirectory,
    depth: path.split("/").length - 1,
    isExpanded,
    isLoading: false,
  };
}

const SHOW_ALL = () => true;
const HIDE_DOTFILES = (name: string) => !name.startsWith(".");

describe("missingRowStatus", () => {
  const listings = new Map<string, readonly FileTreeNode[]>([
    ["", [node("src", true), node(".github", true), node("README.md")]],
    ["src", [node("src/lib", true), node("src/app.ts")]],
    ["src/lib", [node("src/lib/a.ts")]],
    [".github", [node(".github/ci.yml")]],
  ]);

  it("calls a collapsed ancestor absent", () => {
    // Collapsing hides the row for good, so there is nothing left to wait for.
    expect(missingRowStatus("src/lib/a.ts", listings, new Set(["src"]), "", SHOW_ALL)).toBe(
      "absent"
    );
    expect(missingRowStatus("src/app.ts", listings, new Set(), "", SHOW_ALL)).toBe("absent");
  });

  it("calls a path the visibility filter hides absent, listed or not", () => {
    expect(
      missingRowStatus(".github/ci.yml", listings, new Set([".github"]), "", HIDE_DOTFILES)
    ).toBe("absent");
    // The filter needs no listing: a hidden directory is never fetched, so
    // waiting on it would wait forever.
    expect(
      missingRowStatus(".github/ci.yml", new Map(), new Set([".github"]), "", HIDE_DOTFILES)
    ).toBe("absent");
  });

  it("calls a path an unlisted ancestor might still hold pending", () => {
    const expanded = new Set(["src", "src/lib"]);
    // The root alone has landed; everything under it is still to come.
    const rootOnly = new Map([["", listings.get("")!]]);
    expect(missingRowStatus("src/lib/a.ts", rootOnly, expanded, "", SHOW_ALL)).toBe("pending");
    // `src` is listed but `src/lib` is not.
    const partial = new Map([
      ["", listings.get("")!],
      ["src", listings.get("src")!],
    ]);
    expect(missingRowStatus("src/lib/a.ts", partial, expanded, "", SHOW_ALL)).toBe("pending");
  });

  it("calls everything pending before the root has been listed", () => {
    expect(missingRowStatus("README.md", new Map(), new Set(), "", SHOW_ALL)).toBe("pending");
  });

  it("calls a path its parent's listing no longer holds absent", () => {
    const afterDelete = new Map(listings);
    afterDelete.set("src/lib", []);
    expect(
      missingRowStatus("src/lib/a.ts", afterDelete, new Set(["src", "src/lib"]), "", SHOW_ALL)
    ).toBe("absent");
    // A root-level file gone from the root listing is the same answer.
    const rootWithoutReadme = new Map(listings);
    rootWithoutReadme.set("", [node("src", true)]);
    expect(missingRowStatus("README.md", rootWithoutReadme, new Set(), "", SHOW_ALL)).toBe(
      "absent"
    );
  });

  it("calls a path outside the root, and the root itself, absent", () => {
    expect(missingRowStatus("README.md", listings, new Set(), "src", SHOW_ALL)).toBe("absent");
    expect(missingRowStatus("src", listings, new Set(), "src", SHOW_ALL)).toBe("absent");
    // Prefix matching is segment-honest.
    expect(missingRowStatus("srcache/a.ts", listings, new Set(), "src", SHOW_ALL)).toBe("absent");
  });

  it("resolves a path below a re-rooted tree against that root's listing", () => {
    const rooted = new Map<string, readonly FileTreeNode[]>([
      ["src", listings.get("src")!],
      ["src/lib", listings.get("src/lib")!],
    ]);
    expect(missingRowStatus("src/lib/a.ts", rooted, new Set(["src/lib"]), "src", SHOW_ALL)).toBe(
      "absent"
    );
    expect(missingRowStatus("src/lib/a.ts", new Map(), new Set(["src/lib"]), "src", SHOW_ALL)).toBe(
      "pending"
    );
  });
});

describe("pickCursorReplacement", () => {
  const before = [
    row("src", true, true),
    row("src/lib", true, true),
    row("src/lib/a.ts"),
    row("src/app.ts"),
    row(".env"),
    row("README.md"),
  ];
  const sighting = (path: string) => ({
    path,
    rows: before,
    index: before.findIndex((r) => r.path === path),
  });

  it("prefers the nearest ancestor that still has a row", () => {
    const afterCollapseAll = [row("src", true), row(".env"), row("README.md")];
    expect(pickCursorReplacement(sighting("src/lib/a.ts"), afterCollapseAll)).toBe("src");
    // The nearest, not the outermost: `src/lib` is still open here.
    const afterDelete = before.filter((r) => r.path !== "src/lib/a.ts");
    expect(pickCursorReplacement(sighting("src/lib/a.ts"), afterDelete)).toBe("src/lib");
  });

  it("takes the next surviving row when no ancestor does", () => {
    const withoutDotfile = before.filter((r) => r.path !== ".env");
    expect(pickCursorReplacement(sighting(".env"), withoutDotfile)).toBe("README.md");
  });

  it("skips neighbours that went with it", () => {
    // Hiding dotfiles takes `.env` and the file after it; the row before wins
    // only once nothing after the cursor is left.
    const trimmed = before.slice(0, 4);
    expect(pickCursorReplacement(sighting(".env"), trimmed)).toBe("src/app.ts");
  });

  it("takes the first row of a tree that shares none with the old one", () => {
    const rerooted = [row("lib/x.ts"), row("lib/y.ts")];
    expect(pickCursorReplacement(sighting("README.md"), rerooted)).toBe("lib/x.ts");
  });

  it("is null for a tree with no rows", () => {
    expect(pickCursorReplacement(sighting("README.md"), [])).toBeNull();
  });

  it("does not mistake a sibling sharing a prefix for an ancestor", () => {
    const rows = [row("srcache", true), row("README.md")];
    expect(pickCursorReplacement({ path: "src/app.ts", rows: before, index: 3 }, rows)).toBe(
      "README.md"
    );
  });
});
