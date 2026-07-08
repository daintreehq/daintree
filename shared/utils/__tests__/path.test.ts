import { describe, it, expect } from "vitest";
import { isAbsolute, isPathInside, normalize, basename, dirname, resolve, join } from "../path.js";

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
