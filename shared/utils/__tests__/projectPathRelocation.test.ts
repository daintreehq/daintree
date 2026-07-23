import { describe, it, expect } from "vitest";
import { rebaseAbsolutePath, rebaseMruEntry, isAbsoluteFsPath } from "../projectPathRelocation.js";

describe("isAbsoluteFsPath", () => {
  it("recognizes POSIX, drive-letter and UNC absolutes", () => {
    expect(isAbsoluteFsPath("/old/repo")).toBe(true);
    expect(isAbsoluteFsPath("C:\\old\\repo")).toBe(true);
    expect(isAbsoluteFsPath("C:/old/repo")).toBe(true);
    expect(isAbsoluteFsPath("\\\\server\\share")).toBe(true);
  });

  it("rejects relative paths and non-paths", () => {
    expect(isAbsoluteFsPath("src/index.ts")).toBe(false);
    expect(isAbsoluteFsPath("./a")).toBe(false);
    expect(isAbsoluteFsPath("worktree:wt")).toBe(false);
  });
});

describe("rebaseAbsolutePath", () => {
  const OLD = "/old/project";
  const NEW = "/new/renamed-project";

  it("rewrites the exact root", () => {
    expect(rebaseAbsolutePath(OLD, OLD, NEW)).toBe(NEW);
  });

  it("rewrites descendants at a segment boundary", () => {
    expect(rebaseAbsolutePath("/old/project/src/a.ts", OLD, NEW)).toBe(
      "/new/renamed-project/src/a.ts"
    );
    expect(rebaseAbsolutePath("/old/project/.git", OLD, NEW)).toBe("/new/renamed-project/.git");
  });

  it("does NOT rewrite a sibling that merely shares a prefix", () => {
    expect(rebaseAbsolutePath("/old/project-copy", OLD, NEW)).toBe("/old/project-copy");
    expect(rebaseAbsolutePath("/old/project-copy/x", OLD, NEW)).toBe("/old/project-copy/x");
  });

  it("does NOT rewrite an unrelated path", () => {
    expect(rebaseAbsolutePath("/somewhere/else", OLD, NEW)).toBe("/somewhere/else");
  });

  it("leaves relative values untouched (worktree-relative panel paths)", () => {
    expect(rebaseAbsolutePath("src/index.ts", OLD, NEW)).toBe("src/index.ts");
    expect(rebaseAbsolutePath("", OLD, NEW)).toBe("");
  });

  it("tolerates trailing separators on either root", () => {
    expect(rebaseAbsolutePath("/old/project/a", "/old/project/", NEW)).toBe(
      "/new/renamed-project/a"
    );
    expect(rebaseAbsolutePath("/old/project/", OLD, "/new/renamed-project/")).toBe(
      "/new/renamed-project"
    );
  });

  it("handles Windows drive-letter roots with backslashes", () => {
    expect(rebaseAbsolutePath("C:\\old\\project\\src", "C:\\old\\project", "D:\\moved")).toBe(
      "D:\\moved\\src"
    );
    expect(rebaseAbsolutePath("C:\\old\\project-copy", "C:\\old\\project", "D:\\moved")).toBe(
      "C:\\old\\project-copy"
    );
  });

  it("folds case and separators for Windows-flavored roots", () => {
    // Stored value spelled with lowercase drive + forward slashes still matches.
    expect(rebaseAbsolutePath("c:/old/project/src", "C:\\old\\project", "D:\\moved")).toBe(
      "D:\\moved/src"
    );
    // Exact root, case-insensitive.
    expect(rebaseAbsolutePath("C:/OLD/Project", "c:\\old\\project", "D:\\moved")).toBe("D:\\moved");
    // Case-only sibling must still NOT match a different folder.
    expect(rebaseAbsolutePath("C:\\old\\project2", "C:\\old\\project", "D:\\moved")).toBe(
      "C:\\old\\project2"
    );
  });

  it("does NOT treat a backslash as a boundary on POSIX (a file literally named with one)", () => {
    // On POSIX, `\` is a valid filename character — `/old/project\copy` is a
    // sibling file, not a descendant of `/old/project`.
    expect(rebaseAbsolutePath("/old/project\\copy", OLD, NEW)).toBe("/old/project\\copy");
  });

  it("rebases UNC descendants", () => {
    expect(
      rebaseAbsolutePath(
        "\\\\server\\share\\proj\\a",
        "\\\\server\\share\\proj",
        "\\\\server\\share\\moved"
      )
    ).toBe("\\\\server\\share\\moved\\a");
  });

  it("returns value unchanged when roots are empty", () => {
    expect(rebaseAbsolutePath("/old/project/a", "", NEW)).toBe("/old/project/a");
    expect(rebaseAbsolutePath("/old/project/a", OLD, "")).toBe("/old/project/a");
  });
});

describe("rebaseMruEntry", () => {
  const OLD = "/old/project";
  const NEW = "/new/renamed-project";

  it("rewrites the path inside a worktree: entry", () => {
    expect(rebaseMruEntry("worktree:/old/project", OLD, NEW)).toBe("worktree:/new/renamed-project");
    expect(rebaseMruEntry("worktree:/old/project/wt", OLD, NEW)).toBe(
      "worktree:/new/renamed-project/wt"
    );
  });

  it("leaves terminal: entries and non-matching worktree entries untouched", () => {
    expect(rebaseMruEntry("terminal:t-1", OLD, NEW)).toBe("terminal:t-1");
    expect(rebaseMruEntry("worktree:/other/place", OLD, NEW)).toBe("worktree:/other/place");
  });
});
