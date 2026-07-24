import { describe, it, expect } from "vitest";
import {
  DIR_PATH_REGEX,
  FILE_PATH_REGEX,
  FILE_URL_REGEX,
  isPathExcluded,
  resolveDirPathCandidate,
  resolveFilePathCandidate,
  resolveFileUrlCandidate,
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

  it("rejects a non-file URL that looks path-like", () => {
    expect(resolveSelectedFilePath("https://example.com/a/b.ts", "/p")).toBeNull();
    expect(resolveSelectedFilePath("ssh://host/a/b.ts", "/p")).toBeNull();
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

  it("accepts a selection that is exactly one file:// URL", () => {
    expect(resolveSelectedFilePath("file:///tmp/renders/a.png", "/p")?.absolutePath).toBe(
      "/tmp/renders/a.png"
    );
    expect(resolveSelectedFilePath("  file:///tmp/renders/a.png \n", "/p")?.absolutePath).toBe(
      "/tmp/renders/a.png"
    );
  });

  it("resolves a selected file:// URL the same way a click on it would", () => {
    const url = "file:///tmp/my%20render.png";
    const viaSelection = resolveSelectedFilePath(url, "/p");
    expect(viaSelection?.absolutePath).toBe("/tmp/my render.png");
    expect(viaSelection).toEqual(resolveFileUrlCandidate(url));
  });

  it("rejects a file:// URL embedded in prose or paired with another", () => {
    expect(resolveSelectedFilePath("see file:///tmp/a.png for details", "/p")).toBeNull();
    expect(resolveSelectedFilePath("file:///tmp/a.png file:///tmp/b.png", "/p")).toBeNull();
  });

  it("rejects a file:// URL that resolves to nothing viewable", () => {
    expect(resolveSelectedFilePath("file://someserver/share/a.png", "/p")).toBeNull();
    expect(resolveSelectedFilePath("file:///", "/p")).toBeNull();
  });
});

describe("resolveFileUrlCandidate", () => {
  const CODEX_URL =
    "file:///Users/gpriday/.codex/generated_images/019f92d9-d4b8-7de3-b1c3-56ce778ef00b/call_H5WWfuc4aUo8pAYO4a5eYRZ5.png";

  it("decodes the URL an agent CLI prints for a generated image", () => {
    expect(resolveFileUrlCandidate(CODEX_URL)).toEqual({
      absolutePath:
        "/Users/gpriday/.codex/generated_images/019f92d9-d4b8-7de3-b1c3-56ce778ef00b/call_H5WWfuc4aUo8pAYO4a5eYRZ5.png",
    });
  });

  it("percent-decodes spaces without treating + as one", () => {
    expect(resolveFileUrlCandidate("file:///tmp/my%20render+v2.png")?.absolutePath).toBe(
      "/tmp/my render+v2.png"
    );
  });

  it("decodes non-ASCII without re-normalizing the Unicode form", () => {
    // NFD "café": the combining acute stays a separate code point. Forcing NFC
    // would rewrite the name the filesystem actually holds.
    const decomposed = "/tmp/cafe\u0301.png";
    const resolved = resolveFileUrlCandidate("file:///tmp/cafe%CC%81.png")?.absolutePath;
    expect(resolved).toBe(decomposed);
    expect(resolved).not.toBe(decomposed.normalize("NFC"));
  });

  it("drops a query string and a fragment", () => {
    expect(resolveFileUrlCandidate("file:///tmp/a.png?download=1#preview")?.absolutePath).toBe(
      "/tmp/a.png"
    );
  });

  it("accepts an empty and a localhost authority alike", () => {
    expect(resolveFileUrlCandidate("file:///tmp/a.png")?.absolutePath).toBe("/tmp/a.png");
    expect(resolveFileUrlCandidate("file://localhost/tmp/a.png")?.absolutePath).toBe("/tmp/a.png");
    expect(resolveFileUrlCandidate("file://LOCALHOST/tmp/a.png")?.absolutePath).toBe("/tmp/a.png");
  });

  it("rejects a remote authority", () => {
    expect(resolveFileUrlCandidate("file://someserver/share/x.png")).toBeNull();
  });

  it("rejects a four-slash URL whose empty host hides a UNC path", () => {
    expect(resolveFileUrlCandidate("file:////someserver/share/x.png")).toBeNull();
  });

  it("strips the drive's leading slash and preserves the letter's case", () => {
    expect(resolveFileUrlCandidate("file:///C:/Users/me/x.png")?.absolutePath).toBe(
      "C:/Users/me/x.png"
    );
    expect(resolveFileUrlCandidate("file:///d:/Users/me/x.png")?.absolutePath).toBe(
      "d:/Users/me/x.png"
    );
  });

  it("accepts the bar and backslash spellings of a Windows drive URL", () => {
    expect(resolveFileUrlCandidate("file:///C|/Users/me/x.png")?.absolutePath).toBe(
      "C:/Users/me/x.png"
    );
    expect(resolveFileUrlCandidate("file:///C:\\Users\\me\\x.png")?.absolutePath).toBe(
      "C:/Users/me/x.png"
    );
  });

  it("rejects encoded path separators in either case", () => {
    expect(resolveFileUrlCandidate("file:///tmp/a%2Fb.png")).toBeNull();
    expect(resolveFileUrlCandidate("file:///tmp/a%2fb.png")).toBeNull();
    expect(resolveFileUrlCandidate("file:///tmp/a%5Cb.png")).toBeNull();
    expect(resolveFileUrlCandidate("file:///C:/a%5cb.png")).toBeNull();
  });

  it("rejects a malformed percent escape instead of throwing", () => {
    expect(resolveFileUrlCandidate("file:///tmp/a%zz.png")).toBeNull();
  });

  it("rejects a decoded NUL byte", () => {
    expect(resolveFileUrlCandidate("file:///tmp/a%00.png")).toBeNull();
  });

  it("resolves an encoded drive letter and colon like their literal spellings", () => {
    const literal = resolveFileUrlCandidate("file:///C:/Users/me/x.png")?.absolutePath;
    expect(resolveFileUrlCandidate("file:///C%3A/Users/me/x.png")?.absolutePath).toBe(literal);
    expect(resolveFileUrlCandidate("file:///%43:/Users/me/x.png")?.absolutePath).toBe(literal);
  });

  it("keeps a drive-relative pathname absolute rather than joining it to a cwd", () => {
    // `/C:foo.png` has no slash after the colon, so it isn't a drive-absolute
    // path — it's a POSIX file literally named `C:foo.png` at the root.
    // Stripping the slash would hand `file.view` a relative path to join.
    expect(resolveFileUrlCandidate("file:///C:foo.png")?.absolutePath).toBe("/C:foo.png");
    expect(resolveFileUrlCandidate("file:///%43:")).toBeNull();
  });

  it("rejects roots and directory-shaped URLs", () => {
    expect(resolveFileUrlCandidate("file://")).toBeNull();
    expect(resolveFileUrlCandidate("file:///")).toBeNull();
    expect(resolveFileUrlCandidate("file:///C:/")).toBeNull();
    expect(resolveFileUrlCandidate("file:///C:")).toBeNull();
    expect(resolveFileUrlCandidate("file:///tmp/renders/")).toBeNull();
  });

  it("rejects a non-file scheme and unparseable text", () => {
    expect(resolveFileUrlCandidate("https://example.com/a.png")).toBeNull();
    expect(resolveFileUrlCandidate("not a url")).toBeNull();
  });

  it("rejects a URL carrying an escape sequence", () => {
    expect(resolveFileUrlCandidate("file:///tmp/\x1b[0m/a.png")).toBeNull();
  });

  it("keeps no line or column — a file URL names an exact resource", () => {
    // `:2024` is a legal POSIX filename ending; peeling it would retarget the
    // link at a file the URL never named.
    expect(resolveFileUrlCandidate("file:///tmp/render:2024")).toEqual({
      absolutePath: "/tmp/render:2024",
    });
  });
});

describe("FILE_URL_REGEX (terminal line scanning)", () => {
  const scan = (line: string) => [...line.matchAll(FILE_URL_REGEX)].map((m) => m[1]);

  it("captures a bare URL and one wrapped in parentheses", () => {
    expect(scan("saved to file:///tmp/a.png")).toEqual(["file:///tmp/a.png"]);
    expect(scan("![shot](file:///tmp/a.png)")).toEqual(["file:///tmp/a.png"]);
  });

  it("leaves trailing sentence punctuation out of the capture", () => {
    expect(scan("wrote file:///tmp/a.png.")).toEqual(["file:///tmp/a.png"]);
    expect(scan("wrote file:///tmp/a.png, then stopped")).toEqual(["file:///tmp/a.png"]);
  });

  it("never truncates at a Windows bar or a bracket", () => {
    // A truncated `file:///C` still parses as a URL, so a partial capture would
    // silently link to the wrong path rather than to nothing.
    expect(scan("open file:///C|/Users/me/x.png")).toEqual(["file:///C|/Users/me/x.png"]);
    expect(scan("open file:///tmp/shot[1].png")).toEqual(["file:///tmp/shot[1].png"]);
    expect(scan("open file:///C:\\Users\\me\\x.png")).toEqual(["file:///C:\\Users\\me\\x.png"]);
  });

  it("requires a boundary before the scheme", () => {
    expect(scan("xfile:///tmp/a.png")).toEqual([]);
  });

  it("unwraps the delimiters agent output puts around a URL", () => {
    // Symmetry matters: the closing side already terminated on these, so a
    // one-sided set would linkify on click but not on selection, or vice versa.
    for (const [open, close] of [
      ["`", "`"],
      ['"', '"'],
      ["'", "'"],
      ["<", ">"],
      ["[", "]"],
    ]) {
      expect(scan(`saved to ${open}file:///tmp/a.png${close}`)).toEqual(["file:///tmp/a.png"]);
    }
  });

  it("matches an uppercase scheme", () => {
    expect(scan("FILE:///tmp/a.png")).toEqual(["FILE:///tmp/a.png"]);
  });

  it("finds every URL on a line", () => {
    expect(scan("file:///tmp/a.png and file:///tmp/b.png")).toEqual([
      "file:///tmp/a.png",
      "file:///tmp/b.png",
    ]);
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
