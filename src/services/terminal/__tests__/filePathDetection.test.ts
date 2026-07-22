import { describe, it, expect } from "vitest";
import {
  DIR_PATH_REGEX,
  FILE_PATH_REGEX,
  isPathExcluded,
  resolveDirPathCandidate,
  resolveFilePathCandidate,
  resolveSelectedFilePath,
} from "../filePathDetection";

describe("resolveFilePathCandidate", () => {
  it("returns an absolute POSIX path unchanged", () => {
    expect(resolveFilePathCandidate("/usr/local/app.log", "/home/u")).toEqual({
      absolutePath: "/usr/local/app.log",
      line: undefined,
      col: undefined,
    });
  });

  it("resolves a relative path against the cwd", () => {
    expect(resolveFilePathCandidate("src/foo.ts", "/home/u/proj")?.absolutePath).toBe(
      "/home/u/proj/src/foo.ts"
    );
  });

  it("collapses ./ and ../ segments during resolution", () => {
    expect(resolveFilePathCandidate("./foo.ts", "/home/u/proj")?.absolutePath).toBe(
      "/home/u/proj/foo.ts"
    );
    expect(resolveFilePathCandidate("../a/b.ts", "/home/u/proj")?.absolutePath).toBe(
      "/home/u/a/b.ts"
    );
  });

  it("strips a :line:col suffix and reports the numbers", () => {
    expect(resolveFilePathCandidate("src/foo.ts:42:7", "/p")).toEqual({
      absolutePath: "/p/src/foo.ts",
      line: 42,
      col: 7,
    });
    expect(resolveFilePathCandidate("src/foo.ts:42", "/p")).toEqual({
      absolutePath: "/p/src/foo.ts",
      line: 42,
      col: undefined,
    });
  });

  it("keeps a Windows drive-absolute path verbatim", () => {
    expect(resolveFilePathCandidate("C:\\Users\\me\\file.txt", "/ignored")?.absolutePath).toBe(
      "C:\\Users\\me\\file.txt"
    );
  });

  it("joins a relative path under a Windows cwd with backslashes", () => {
    expect(resolveFilePathCandidate("src/foo.ts", "C:\\proj")?.absolutePath).toBe(
      "C:\\proj\\src\\foo.ts"
    );
  });

  it("cannot resolve a relative path without a cwd", () => {
    expect(resolveFilePathCandidate("src/foo.ts", "")).toBeNull();
  });

  it("rejects text with no file extension", () => {
    expect(resolveFilePathCandidate("/etc/hosts", "/p")).toBeNull();
  });
});

describe("resolveSelectedFilePath", () => {
  it("accepts a selection that is exactly one path token", () => {
    expect(resolveSelectedFilePath("src/foo.ts", "/home/u/proj")?.absolutePath).toBe(
      "/home/u/proj/src/foo.ts"
    );
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveSelectedFilePath("  src/foo.ts \n", "/p")?.absolutePath).toBe("/p/src/foo.ts");
  });

  it("resolves a WSL absolute path verbatim", () => {
    const wsl = "\\\\wsl$\\Ubuntu\\home\\me\\file.txt";
    expect(resolveSelectedFilePath(wsl, "/ignored")?.absolutePath).toBe(wsl);
  });

  it("rejects a path embedded in surrounding prose", () => {
    expect(resolveSelectedFilePath("see src/foo.ts for details", "/p")).toBeNull();
  });

  it("rejects a selection spanning two paths", () => {
    expect(resolveSelectedFilePath("a/one.ts b/two.ts", "/p")).toBeNull();
  });

  it("rejects a URL that looks path-like", () => {
    expect(resolveSelectedFilePath("https://example.com/a/b.ts", "/p")).toBeNull();
  });

  it("rejects slash-commands with no extension", () => {
    expect(resolveSelectedFilePath("/help", "/p")).toBeNull();
    expect(resolveSelectedFilePath("/api/v1", "/p")).toBeNull();
  });

  it("rejects an empty or whitespace-only selection", () => {
    expect(resolveSelectedFilePath("", "/p")).toBeNull();
    expect(resolveSelectedFilePath("   ", "/p")).toBeNull();
  });

  it("rejects a bare filename with no separator", () => {
    expect(resolveSelectedFilePath("foo.ts", "/p")).toBeNull();
  });
});

describe("isPathExcluded", () => {
  it("excludes URLs and text carrying escape sequences", () => {
    expect(isPathExcluded("https://x/a.ts")).toBe(true);
    expect(isPathExcluded("a\x1b[0m/b.ts")).toBe(true);
    expect(isPathExcluded("src/foo.ts")).toBe(false);
  });
});

describe("FILE_PATH_REGEX (terminal line scanning)", () => {
  it("finds a path token embedded in a log line", () => {
    const matches = [..." at /home/app.js:10:5 threw".matchAll(FILE_PATH_REGEX)];
    expect(matches.map((m) => m[1])).toEqual(["/home/app.js:10:5"]);
  });
});

describe("DIR_PATH_REGEX (directory candidates)", () => {
  const scan = (line: string) => [...line.matchAll(DIR_PATH_REGEX)].map((m) => m[1]);

  it("matches extensionless multi-segment tokens", () => {
    expect(scan("wrote files under src/panels today")).toEqual(["src/panels"]);
  });

  it("matches a trailing-slash folder at the end of an agent sentence", () => {
    const line =
      "The chosen full-resolution raw result will be copied into assets/reference/art/bearer_animation/";
    expect(scan(line)).toEqual(["assets/reference/art/bearer_animation/"]);
    expect(resolveDirPathCandidate("assets/reference/art/bearer_animation/", "/repo")).toBe(
      "/repo/assets/reference/art/bearer_animation"
    );
  });

  it("matches absolute and dot-relative tokens, keeping a trailing slash", () => {
    expect(scan("ls /tmp/scratch and ./out/dist/")).toEqual(["/tmp/scratch", "./out/dist/"]);
  });

  it("stops before a colon suffix so file:line tokens keep their meaning", () => {
    expect(scan("moved to src/panels: done")).toEqual(["src/panels"]);
  });

  it("matches file-shaped tokens too — overlap dedup is the caller's job", () => {
    // `src/file.ts` satisfies both regexes; the addon drops directory
    // candidates whose range a file link already claimed.
    expect(scan("see src/file.ts")).toEqual(["src/file.ts"]);
  });

  it("ignores tokens with no separator", () => {
    expect(scan("plain words only here")).toEqual([]);
  });
});

describe("resolveDirPathCandidate", () => {
  it("keeps absolute tokens and strips the trailing slash", () => {
    expect(resolveDirPathCandidate("/a/b/", "/cwd")).toBe("/a/b");
  });

  it("resolves relative tokens against the cwd", () => {
    expect(resolveDirPathCandidate("src/panels", "/repo")).toBe("/repo/src/panels");
    expect(resolveDirPathCandidate("../sibling", "/repo/app")).toBe("/repo/sibling");
  });

  it("returns null for a relative token with no cwd to resolve against", () => {
    expect(resolveDirPathCandidate("src/panels", "")).toBeNull();
  });

  it("joins against a Windows cwd with the drive's separator", () => {
    expect(resolveDirPathCandidate("src/panels", "C:\\repo")).toBe("C:\\repo\\src\\panels");
  });
});
