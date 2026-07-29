import { describe, it, expect } from "vitest";
import {
  isAbsolute,
  isPathInside,
  normalize,
  basename,
  dirname,
  resolve,
  join,
  toWorktreeRelative,
  resolveWorktreePathScope,
} from "../path.js";

describe("isAbsolute", () => {
  it("recognizes POSIX absolute paths", () => {
    expect(isAbsolute("/foo/bar")).toBe(true);
    expect(isAbsolute("/")).toBe(true);
  });

  it("recognizes Windows drive-letter paths", () => {
    expect(isAbsolute("C:/foo")).toBe(true);
    expect(isAbsolute("C:\\foo")).toBe(true);
    expect(isAbsolute("d:/x")).toBe(true);
  });

  it("recognizes UNC paths", () => {
    expect(isAbsolute("\\\\server\\share")).toBe(true);
    expect(isAbsolute("//server/share")).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(isAbsolute("foo/bar")).toBe(false);
    expect(isAbsolute("./foo")).toBe(false);
    expect(isAbsolute("../foo")).toBe(false);
    expect(isAbsolute("")).toBe(false);
  });
});

describe("normalize", () => {
  it("returns '.' for empty input", () => {
    expect(normalize("")).toBe(".");
  });

  it("collapses redundant separators", () => {
    expect(normalize("/foo//bar")).toBe("/foo/bar");
    expect(normalize("foo///bar")).toBe("foo/bar");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalize("foo\\bar\\baz")).toBe("foo/bar/baz");
    expect(normalize("C:\\foo\\bar")).toBe("C:/foo/bar");
  });

  it("strips trailing slashes", () => {
    expect(normalize("/foo/bar/")).toBe("/foo/bar");
    expect(normalize("foo/")).toBe("foo");
  });

  it("resolves '.' segments", () => {
    expect(normalize("/foo/./bar")).toBe("/foo/bar");
    expect(normalize("./foo")).toBe("foo");
  });

  it("resolves '..' segments", () => {
    expect(normalize("/foo/bar/../baz")).toBe("/foo/baz");
    expect(normalize("foo/../bar")).toBe("bar");
  });

  it("preserves leading '..' for relative paths", () => {
    expect(normalize("../foo")).toBe("../foo");
    expect(normalize("../../foo")).toBe("../../foo");
  });

  it("does not escape above the root for absolute paths", () => {
    expect(normalize("/../foo")).toBe("/foo");
    expect(normalize("/foo/../..")).toBe("/");
  });

  it("preserves Windows drive prefix", () => {
    expect(normalize("C:/foo/bar")).toBe("C:/foo/bar");
    expect(normalize("C:/foo/../bar")).toBe("C:/bar");
  });

  it("preserves UNC prefix without collapsing the double slash", () => {
    expect(normalize("//server/share/file")).toBe("//server/share/file");
    expect(normalize("\\\\server\\share\\file")).toBe("//server/share/file");
    expect(normalize("//server/share/foo/../bar")).toBe("//server/share/bar");
  });

  it("treats UNC share as unescapable root", () => {
    expect(normalize("//server/share/..")).toBe("//server/share");
    expect(normalize("//server/share/foo/../..")).toBe("//server/share");
    expect(normalize("//server/share")).toBe("//server/share");
    expect(normalize("//server")).toBe("//server");
  });

  it("is idempotent", () => {
    const inputs = ["/foo/bar", "C:/foo", "//server/share/x", "../foo", "."];
    for (const input of inputs) {
      const once = normalize(input);
      const twice = normalize(once);
      expect(twice).toBe(once);
    }
  });
});

describe("basename", () => {
  it("returns last path segment", () => {
    expect(basename("/foo/bar/baz.txt")).toBe("baz.txt");
    expect(basename("foo/bar")).toBe("bar");
  });

  it("handles backslash separators", () => {
    expect(basename("C:\\foo\\bar.txt")).toBe("bar.txt");
  });

  it("returns empty string for root paths", () => {
    expect(basename("/")).toBe("");
    expect(basename("C:/")).toBe("");
  });

  it("strips trailing slashes before extracting", () => {
    expect(basename("/foo/bar/")).toBe("bar");
  });

  it("handles single-segment paths", () => {
    expect(basename("foo")).toBe("foo");
  });

  it("returns empty string for UNC roots", () => {
    expect(basename("//server")).toBe("");
    expect(basename("//server/share")).toBe("");
  });

  it("returns last segment for UNC-rooted files", () => {
    expect(basename("//server/share/file.txt")).toBe("file.txt");
    expect(basename("//server/share/dir/file.txt")).toBe("file.txt");
  });
});

describe("dirname", () => {
  it("returns parent directory", () => {
    expect(dirname("/foo/bar/baz")).toBe("/foo/bar");
    expect(dirname("foo/bar")).toBe("foo");
  });

  it("returns '/' for top-level absolute paths", () => {
    expect(dirname("/foo")).toBe("/");
  });

  it("returns '.' for top-level relative paths", () => {
    expect(dirname("foo")).toBe(".");
  });

  it("preserves drive prefix for top-level Windows paths", () => {
    expect(dirname("C:/foo")).toBe("C:/");
  });

  it("returns root for root", () => {
    expect(dirname("/")).toBe("/");
    expect(dirname("C:/")).toBe("C:/");
  });

  it("returns UNC root unchanged when input is the share root", () => {
    expect(dirname("//server/share")).toBe("//server/share");
    expect(dirname("//server")).toBe("//server");
  });

  it("returns UNC share root for files under it", () => {
    expect(dirname("//server/share/file.txt")).toBe("//server/share");
    expect(dirname("//server/share/dir/file.txt")).toBe("//server/share/dir");
  });
});

describe("resolve", () => {
  it("joins relative segments", () => {
    expect(resolve("foo", "bar")).toBe("foo/bar");
  });

  it("resets when a later segment is absolute", () => {
    expect(resolve("/foo", "/bar")).toBe("/bar");
    expect(resolve("/a", "b", "/c")).toBe("/c");
  });

  it("preserves an absolute base when later segments are relative", () => {
    expect(resolve("/Users/foo", "bar/baz")).toBe("/Users/foo/bar/baz");
  });

  it("normalizes the result", () => {
    expect(resolve("/foo", "bar/../baz")).toBe("/foo/baz");
  });

  it("returns '.' for no input", () => {
    expect(resolve()).toBe(".");
    expect(resolve("", "")).toBe(".");
  });
});

describe("join", () => {
  it("concatenates segments with '/'", () => {
    expect(join("foo", "bar")).toBe("foo/bar");
    expect(join("/Users/foo", "bar")).toBe("/Users/foo/bar");
  });

  it("does NOT reset on an absolute later segment (unlike resolve)", () => {
    expect(join("/a", "/b")).toBe("/a/b");
    expect(join("foo", "/bar")).toBe("foo/bar");
  });

  it("normalizes the joined result", () => {
    expect(join("/foo/", "/bar")).toBe("/foo/bar");
    expect(join("foo", "..", "bar")).toBe("bar");
    expect(join("/foo", "./bar")).toBe("/foo/bar");
  });

  it("filters empty segments", () => {
    expect(join("foo", "", "bar")).toBe("foo/bar");
    expect(join("", "", "")).toBe(".");
  });

  it("returns '.' for no input", () => {
    expect(join()).toBe(".");
  });

  it("handles Windows drive prefixes", () => {
    expect(join("C:/Users", "foo")).toBe("C:/Users/foo");
  });
});

describe("cross-platform output stability", () => {
  it("always emits forward slashes regardless of input separator", () => {
    expect(normalize("foo\\bar")).toBe("foo/bar");
    expect(join("foo\\bar", "baz")).toBe("foo/bar/baz");
    expect(resolve("foo\\bar", "baz")).toBe("foo/bar/baz");
    expect(dirname("foo\\bar\\baz")).toBe("foo/bar");
    expect(basename("foo\\bar\\baz")).toBe("baz");
  });
});

describe("isPathInside", () => {
  it("accepts the parent itself and nested children", () => {
    expect(isPathInside("/repo", "/repo")).toBe(true);
    expect(isPathInside("/repo/docs/spec.md", "/repo")).toBe(true);
    expect(isPathInside("/repo/docs/spec.md", "/repo/")).toBe(true);
  });

  it("rejects prefix-sibling directories", () => {
    expect(isPathInside("/repo-evil/secret.md", "/repo")).toBe(false);
    expect(isPathInside("/repository/file.md", "/repo")).toBe(false);
  });

  it("rejects traversal that escapes the parent", () => {
    expect(isPathInside("/repo/docs/../../etc/passwd", "/repo")).toBe(false);
    expect(isPathInside("/repo/../repo/file.md", "/repo")).toBe(true);
  });

  it("normalizes separators before comparing", () => {
    expect(isPathInside("C:\\repo\\docs\\spec.md", "C:/repo")).toBe(true);
    expect(isPathInside("C:\\other\\spec.md", "C:/repo")).toBe(false);
  });

  it("treats everything as inside the filesystem root", () => {
    expect(isPathInside("/etc/passwd", "/")).toBe(true);
  });

  it("rejects relative '.' inputs outright", () => {
    expect(isPathInside(".", "/repo")).toBe(false);
    expect(isPathInside("/repo/file.md", ".")).toBe(false);
  });
});

describe("toWorktreeRelative", () => {
  it("strips the worktree root off a contained POSIX path", () => {
    expect(toWorktreeRelative("/repo/src/index.ts", "/repo")).toBe("src/index.ts");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(toWorktreeRelative("/repo/src/index.ts", "/repo/")).toBe("src/index.ts");
  });

  it("normalizes Windows separators on both sides", () => {
    expect(toWorktreeRelative("C:\\repo\\src\\index.ts", "C:\\repo")).toBe("src/index.ts");
  });

  it("collapses redundant segments before stripping", () => {
    expect(toWorktreeRelative("/repo/./src/../src/index.ts", "/repo")).toBe("src/index.ts");
  });

  // The whole reason this uses isPathInside: a raw startsWith would turn
  // "/repo-other/x.ts" into "-other/x.ts" and hand git a nonsense path.
  it("passes a sibling root that merely extends the worktree name through untouched", () => {
    expect(toWorktreeRelative("/repo-other/x.ts", "/repo")).toBe("/repo-other/x.ts");
  });

  it("passes a path outside the worktree through untouched", () => {
    expect(toWorktreeRelative("/elsewhere/x.ts", "/repo")).toBe("/elsewhere/x.ts");
  });

  it("passes through when no root is supplied", () => {
    expect(toWorktreeRelative("/repo/src/index.ts", undefined)).toBe("/repo/src/index.ts");
  });

  it("passes the root itself through rather than yielding an empty path", () => {
    expect(toWorktreeRelative("/repo", "/repo")).toBe("/repo");
  });

  // Containment is deliberately case-sensitive; a future "fix" that lowercases
  // would silently change behavior for every other consumer of isPathInside.
  it("treats a differently-cased root as outside", () => {
    expect(toWorktreeRelative("/Repo/src/index.ts", "/repo")).toBe("/Repo/src/index.ts");
  });
});

describe("resolveWorktreePathScope", () => {
  const OUTER = { id: "wt-outer", path: "/repo" };
  const INNER = { id: "wt-inner", path: "/repo/nested" };
  const SIBLING = { id: "wt-sibling", path: "/repo-other" };

  it("resolves a contained path to its worktree and relative path", () => {
    expect(resolveWorktreePathScope("/repo/src/index.ts", [OUTER])).toEqual({
      worktreeId: "wt-outer",
      worktreePath: "/repo",
      relativePath: "src/index.ts",
    });
  });

  // Deepest root wins so a nested worktree beats the repo hosting it — the
  // file browser must open the worktree the file actually belongs to.
  it("prefers the deepest containing worktree regardless of iteration order", () => {
    expect(resolveWorktreePathScope("/repo/nested/src/a.ts", [OUTER, INNER])?.worktreeId).toBe(
      "wt-inner"
    );
    expect(resolveWorktreePathScope("/repo/nested/src/a.ts", [INNER, OUTER])?.worktreeId).toBe(
      "wt-inner"
    );
  });

  // The trap `isPathInside` exists to close: a raw startsWith would claim this
  // for /repo and mangle the relative path into "-other/src/a.ts".
  it("does not claim a sibling root that merely extends the name", () => {
    expect(resolveWorktreePathScope("/repo-other/src/a.ts", [OUTER])).toBeNull();
    expect(resolveWorktreePathScope("/repo-other/src/a.ts", [OUTER, SIBLING])?.worktreeId).toBe(
      "wt-sibling"
    );
  });

  // "" is what the root means to callers; toWorktreeRelative alone would hand
  // back the absolute path here, which expands nothing in the tree.
  it("returns an empty relative path for the worktree root itself", () => {
    expect(resolveWorktreePathScope("/repo", [OUTER])?.relativePath).toBe("");
    expect(resolveWorktreePathScope("/repo/", [OUTER])?.relativePath).toBe("");
  });

  it("emits forward slashes for a backslashed path and root", () => {
    const scope = resolveWorktreePathScope("C:\\repo\\src\\index.ts", [
      { id: "wt-win", path: "C:\\repo" },
    ]);
    expect(scope?.relativePath).toBe("src/index.ts");
    // The root comes back verbatim so callers can feed it to path helpers that
    // normalize it themselves.
    expect(scope?.worktreePath).toBe("C:\\repo");
  });

  it("collapses interior . and .. segments before matching", () => {
    expect(resolveWorktreePathScope("/repo/src/./docs/a.ts", [OUTER])?.relativePath).toBe(
      "src/docs/a.ts"
    );
    expect(resolveWorktreePathScope("/repo/src/../docs/a.ts", [OUTER])?.relativePath).toBe(
      "docs/a.ts"
    );
  });

  // A traversal that escapes the root is outside it, not a relative path with
  // a ".." in it — the tree would reject the whole stat batch.
  it("rejects a path that escapes the root via ..", () => {
    expect(resolveWorktreePathScope("/repo/../etc/passwd", [OUTER])).toBeNull();
  });

  it("returns null for a path in no known worktree, and for an empty list", () => {
    expect(resolveWorktreePathScope("/elsewhere/a.ts", [OUTER, INNER])).toBeNull();
    expect(resolveWorktreePathScope("/repo/src/a.ts", [])).toBeNull();
  });

  // A worktree whose path hasn't hydrated yet must not swallow every path:
  // normalize("") is ".", which would otherwise match unpredictably.
  it("skips a worktree with an empty path", () => {
    expect(resolveWorktreePathScope("/repo/src/a.ts", [{ id: "wt-blank", path: "" }])).toBeNull();
  });
});
