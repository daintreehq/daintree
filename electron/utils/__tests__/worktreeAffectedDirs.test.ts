import { describe, it, expect } from "vitest";
import { affectedDirsForBurst } from "../worktreeAffectedDirs.js";

// The absolute-to-relative conversion the whole scoped-refresh feature rests on
// (#12244). A silent mismatch here does not break anything visibly — every
// lookup just misses, the tree falls back to the full sweep, and the feature
// ships as a no-op that reviews clean (#11276). So these assert the exact
// relative strings, never merely "something came back".

const ROOT = "/repo";

const dirsOf = (paths: string[], root = ROOT, realRoot: string | null = null) => {
  const result = affectedDirsForBurst(new Set(paths), root, realRoot);
  return result === null ? null : [...result].sort();
};

describe("affectedDirsForBurst", () => {
  it("returns the worktree-relative parent of each changed path", () => {
    expect(dirsOf(["/repo/src/panels/foo/Bar.tsx"])).toEqual(["src/panels/foo"]);
  });

  it("reports a top-level entry as the worktree root", () => {
    expect(dirsOf(["/repo/package.json"])).toEqual([""]);
  });

  it("dedupes siblings down to their one shared parent", () => {
    expect(dirsOf(["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"])).toEqual(["src"]);
  });

  it("keeps distinct parents apart", () => {
    expect(dirsOf(["/repo/src/a.ts", "/repo/electron/b.ts", "/repo/README.md"])).toEqual([
      "",
      "electron",
      "src",
    ]);
  });

  it("names the parent, never the changed path itself — a changed directory is a row in its parent", () => {
    // The watcher cannot say whether a path is a file or a directory, and it
    // does not need to: `src/panels` is created, deleted or renamed as an entry
    // inside `src`, so `src` is what has to be re-read.
    expect(dirsOf(["/repo/src/panels"])).toEqual(["src"]);
  });

  it("resolves paths under the canonical alias as well as the configured root", () => {
    expect(dirsOf(["/private/var/repo/src/a.ts"], "/var/repo", "/private/var/repo")).toEqual([
      "src",
    ]);
  });

  it("rejects a sibling whose name merely extends the root rather than mangling it", () => {
    // `/repo-other/x.ts` under `/repo` would slice into `-other/x.ts` with a
    // raw prefix strip — a relative-looking path naming no real directory.
    expect(dirsOf(["/repo-other/src/x.ts"])).toBeNull();
  });

  it("degrades the whole burst when any single path is unusable", () => {
    expect(dirsOf(["/repo/src/a.ts", "/elsewhere/b.ts"])).toBeNull();
  });

  it("degrades when a path is the worktree root itself", () => {
    // The Windows adapter collapses an unknown filename to the watch root,
    // which means "something under here changed" — unscopeable.
    expect(dirsOf(["/repo"])).toBeNull();
  });

  it("passes an unknown burst straight through as unknown", () => {
    expect(affectedDirsForBurst(null, ROOT, null)).toBeNull();
  });

  it("returns an empty list for an empty burst, which is not the same as unknown", () => {
    expect(affectedDirsForBurst(new Set(), ROOT, null)).toEqual([]);
  });

  it("normalizes backslash separators to the tree's forward-slash namespace", () => {
    expect(dirsOf(["C:\\repo\\src\\panels\\Bar.tsx"], "C:\\repo")).toEqual(["src/panels"]);
  });

  it("tolerates a trailing separator on the configured root", () => {
    expect(dirsOf(["/repo/src/a.ts"], "/repo/")).toEqual(["src"]);
  });
});
