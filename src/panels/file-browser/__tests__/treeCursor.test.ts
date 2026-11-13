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
    // Sibling position is irrelevant to where a cursor lands.
    posInSet: 1,
    setSize: 1,
  };
}

const SHOW_ALL = () => true;
const HIDE_DOTFILES = (name: string) => !name.startsWith(".");

describe("missingRowStatus", () => {
  const NONE: ReadonlySet<string> = new Set();
  const listings = new Map<string, readonly FileTreeNode[]>([
    ["", [node("src", true), node(".github", true), node("README.md")]],
    ["src", [node("src/lib", true), node("src/app.ts")]],
    ["src/lib", [node("src/lib/a.ts")]],
    [".github", [node(".github/ci.yml")]],
  ]);
  /** The root's listing alone, which is all a fresh identity has at first. */
  const rootOnly = new Map([["", listings.get("")!]]);

  it("calls a collapsed ancestor absent without needing the listing under it", () => {
    // Collapsing hides the row for good, so there is nothing left to wait for —
    // even though the listing under the collapsed folder was never read.
    expect(missingRowStatus("src/app.ts", rootOnly, new Set(), "", SHOW_ALL, NONE)).toBe("absent");
    expect(missingRowStatus("src/lib/a.ts", listings, new Set(["src"]), "", SHOW_ALL, NONE)).toBe(
      "absent"
    );
  });

  it("calls a path the visibility filter hides absent", () => {
    expect(
      missingRowStatus(".github/ci.yml", listings, new Set([".github"]), "", HIDE_DOTFILES, NONE)
    ).toBe("absent");
    // A hidden directory is never fetched, so waiting on its listing would wait
    // forever.
    expect(
      missingRowStatus(".github/ci.yml", rootOnly, new Set([".github"]), "", HIDE_DOTFILES, NONE)
    ).toBe("absent");
  });

  it("calls a path an unlisted ancestor might still hold pending", () => {
    const expanded = new Set(["src", "src/lib"]);
    expect(missingRowStatus("src/lib/a.ts", rootOnly, expanded, "", SHOW_ALL, NONE)).toBe(
      "pending"
    );
    // `src` is listed but `src/lib` is not.
    const partial = new Map([
      ["", listings.get("")!],
      ["src", listings.get("src")!],
    ]);
    expect(missingRowStatus("src/lib/a.ts", partial, expanded, "", SHOW_ALL, NONE)).toBe("pending");
  });

  it("gives up on an ancestor whose listing failed", () => {
    // The hook doesn't re-ask for a failed directory on its own, so a verdict
    // that waited on it would leave the cursor stale forever.
    const partial = new Map([
      ["", listings.get("")!],
      ["src", listings.get("src")!],
    ]);
    expect(
      missingRowStatus(
        "src/lib/a.ts",
        partial,
        new Set(["src", "src/lib"]),
        "",
        SHOW_ALL,
        new Set(["src/lib"])
      )
    ).toBe("absent");
  });

  it("gives no verdict at all before the root has been listed", () => {
    expect(missingRowStatus("README.md", new Map(), new Set(), "", SHOW_ALL, NONE)).toBe("pending");
    // Not even for a path the filter or the root settles: with no tree there is
    // nothing to move the cursor onto, so ruling on it would just clear it.
    expect(missingRowStatus(".env", new Map(), new Set(), "", HIDE_DOTFILES, NONE)).toBe("pending");
    expect(missingRowStatus("src", new Map(), new Set(), "src", SHOW_ALL, NONE)).toBe("pending");
    expect(missingRowStatus("README.md", new Map(), new Set(), "src", SHOW_ALL, NONE)).toBe(
      "pending"
    );
    // A root that failed to list is still unlisted.
    expect(missingRowStatus("README.md", new Map(), new Set(), "", SHOW_ALL, new Set([""]))).toBe(
      "pending"
    );
  });

  it("calls a path its parent's listing no longer holds absent", () => {
    // The membership check, not the end of the walk, is what says so: the
    // deleted directory's own listing is gone too, which alone reads as pending.
    const afterDelete = new Map([
      ["", listings.get("")!],
      ["src", [node("src/app.ts")]],
    ]);
    expect(
      missingRowStatus("src/lib/a.ts", afterDelete, new Set(["src", "src/lib"]), "", SHOW_ALL, NONE)
    ).toBe("absent");
    // A root-level file gone from the root listing is the same answer.
    const rootWithoutReadme = new Map(listings);
    rootWithoutReadme.set("", [node("src", true)]);
    expect(missingRowStatus("README.md", rootWithoutReadme, new Set(), "", SHOW_ALL, NONE)).toBe(
      "absent"
    );
  });

  it("calls a path outside the root, and the root itself, absent once the root is listed", () => {
    const rooted = new Map<string, readonly FileTreeNode[]>([["src", listings.get("src")!]]);
    expect(missingRowStatus("README.md", rooted, new Set(), "src", SHOW_ALL, NONE)).toBe("absent");
    expect(missingRowStatus("src", rooted, new Set(), "src", SHOW_ALL, NONE)).toBe("absent");
    // Prefix matching is segment-honest.
    expect(missingRowStatus("srcache/a.ts", rooted, new Set(), "src", SHOW_ALL, NONE)).toBe(
      "absent"
    );
  });

  it("keeps a path inside a re-rooted tree pending until the nested listing lands", () => {
    // The root has landed, but `src/lib` is expanded and still unread: a row
    // under it is not known to be gone just because the root is listed.
    const rooted = new Map<string, readonly FileTreeNode[]>([["src", listings.get("src")!]]);
    expect(
      missingRowStatus("src/lib/a.ts", rooted, new Set(["src/lib"]), "src", SHOW_ALL, NONE)
    ).toBe("pending");
    const loaded = new Map(rooted).set("src/lib", []);
    expect(
      missingRowStatus("src/lib/a.ts", loaded, new Set(["src/lib"]), "src", SHOW_ALL, NONE)
    ).toBe("absent");
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
