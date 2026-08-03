import { describe, expect, it } from "vitest";
import type { GitStatus } from "@shared/types/git";
import {
  buildFileBrowserGitStatusIndex,
  getFileBrowserRowGitStatus,
  isReadableRelativePath,
} from "../fileBrowserGitStatus";

function change(relativePath: string, status: GitStatus) {
  return { relativePath, status };
}

describe("buildFileBrowserGitStatusIndex", () => {
  it("marks a changed file at its own path and nothing else", () => {
    const index = buildFileBrowserGitStatusIndex([change("src/app.ts", "modified")]);

    expect(getFileBrowserRowGitStatus(index, "src/app.ts", false)).toBe("modified");
    expect(getFileBrowserRowGitStatus(index, "src/other.ts", false)).toBeUndefined();
    // A file lookup must never fall through to the folder map, or every sibling
    // in a dirty directory would claim the directory's status.
    expect(getFileBrowserRowGitStatus(index, "src", false)).toBeUndefined();
  });

  it("propagates a change to every ancestor directory", () => {
    const index = buildFileBrowserGitStatusIndex([change("a/b/c/deep.ts", "added")]);

    expect(getFileBrowserRowGitStatus(index, "a", true)).toBe("added");
    expect(getFileBrowserRowGitStatus(index, "a/b", true)).toBe("added");
    expect(getFileBrowserRowGitStatus(index, "a/b/c", true)).toBe("added");
    // The file's own path is not a directory entry.
    expect(getFileBrowserRowGitStatus(index, "a/b/c/deep.ts", true)).toBeUndefined();
  });

  it("gives a root-level file no ancestor entries at all", () => {
    const index = buildFileBrowserGitStatusIndex([change("README.md", "modified")]);

    expect(getFileBrowserRowGitStatus(index, "README.md", false)).toBe("modified");
    expect(index.folderStatus.size).toBe(0);
  });

  it("aggregates a folder to its most urgent descendant, not the last one seen", () => {
    const index = buildFileBrowserGitStatusIndex([
      change("src/a.ts", "untracked"),
      change("src/b.ts", "conflicted"),
      change("src/c.ts", "modified"),
    ]);

    expect(getFileBrowserRowGitStatus(index, "src", true)).toBe("conflicted");
  });

  it("aggregates identically whichever order the changes arrive in", () => {
    const forward = buildFileBrowserGitStatusIndex([
      change("src/a.ts", "modified"),
      change("src/b.ts", "deleted"),
    ]);
    const reversed = buildFileBrowserGitStatusIndex([
      change("src/b.ts", "deleted"),
      change("src/a.ts", "modified"),
    ]);

    expect(getFileBrowserRowGitStatus(forward, "src", true)).toBe(
      getFileBrowserRowGitStatus(reversed, "src", true)
    );
    // Deletion outranks a plain edit: the content is gone, not merely different.
    expect(getFileBrowserRowGitStatus(forward, "src", true)).toBe("deleted");
  });

  it("ranks conflicted above deletion, which the churn sort's order would not", () => {
    const index = buildFileBrowserGitStatusIndex([
      change("src/gone.ts", "deleted"),
      change("src/clash.ts", "conflicted"),
    ]);

    expect(getFileBrowserRowGitStatus(index, "src", true)).toBe("conflicted");
  });

  it("keeps the more urgent status when one path appears twice", () => {
    // Staged and unstaged are separate entries for the same file.
    const index = buildFileBrowserGitStatusIndex([
      change("src/app.ts", "modified"),
      change("src/app.ts", "conflicted"),
    ]);

    expect(getFileBrowserRowGitStatus(index, "src/app.ts", false)).toBe("conflicted");
  });

  it("does not leak a status onto a sibling that merely shares a name prefix", () => {
    const index = buildFileBrowserGitStatusIndex([change("src/app.ts", "modified")]);

    expect(getFileBrowserRowGitStatus(index, "src/app.test.ts", false)).toBeUndefined();
    expect(getFileBrowserRowGitStatus(index, "srcs", true)).toBeUndefined();
  });

  it("scales with changed paths rather than with tree size", () => {
    // A folder holding one changed file among a hundred thousand notional
    // siblings costs exactly one entry per path segment.
    const index = buildFileBrowserGitStatusIndex([change("packages/app/src/main.ts", "modified")]);

    expect(index.fileStatus.size).toBe(1);
    expect(index.folderStatus.size).toBe(3);
  });

  it("ignores an empty path instead of minting a blank entry", () => {
    const index = buildFileBrowserGitStatusIndex([change("", "modified")]);

    expect(index.fileStatus.size).toBe(0);
    expect(index.folderStatus.size).toBe(0);
  });

  it("reports nothing when no index is available", () => {
    expect(getFileBrowserRowGitStatus(null, "src/app.ts", false)).toBeUndefined();
    expect(getFileBrowserRowGitStatus(undefined, "src", true)).toBeUndefined();
  });
});

describe("isReadableRelativePath", () => {
  it("accepts the worktree-relative shape the tree rows use", () => {
    expect(isReadableRelativePath("src/app.ts")).toBe(true);
    expect(isReadableRelativePath("README.md")).toBe(true);
    // A name may legitimately contain dots without escaping anywhere.
    expect(isReadableRelativePath("src/..hidden/a.ts")).toBe(true);
  });

  it("rejects an absolute path, which is what a failed root strip leaves behind", () => {
    expect(isReadableRelativePath("/private/tmp/wt/src/app.ts")).toBe(false);
  });

  it("rejects a path that escapes the worktree", () => {
    expect(isReadableRelativePath("../outside.ts")).toBe(false);
    expect(isReadableRelativePath("src/../../outside.ts")).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isReadableRelativePath("")).toBe(false);
  });
});
