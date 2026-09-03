import { describe, it, expect } from "vitest";
import { isProseFilePath } from "../isProseFile";

describe("isProseFilePath", () => {
  it("classifies markdown through the shared markdown check", () => {
    for (const path of ["README.md", "notes.markdown", "page.mdx", "old.mkd"]) {
      expect(isProseFilePath(path)).toBe(true);
    }
  });

  it("classifies the non-markdown prose formats", () => {
    // `.text` and `.rest` are the recognised aliases of the two formats above
    // them; `.asciidoc` is AsciiDoc's own long spelling.
    for (const path of [
      "CHANGELOG.txt",
      "notes.text",
      "index.rst",
      "manual.rest",
      "guide.adoc",
      "guide.asciidoc",
    ]) {
      expect(isProseFilePath(path)).toBe(true);
    }
  });

  it("leaves code and config unwrapped", () => {
    // Wrapping these would hide the column structure that makes them readable,
    // which is why prose is an allowlist rather than a code denylist.
    for (const path of ["src/index.ts", "main.py", "styles.css", "package.json", "Cargo.toml"]) {
      expect(isProseFilePath(path)).toBe(false);
    }
  });

  it("ignores extension case", () => {
    expect(isProseFilePath("README.MD")).toBe(true);
    expect(isProseFilePath("NOTES.TXT")).toBe(true);
  });

  it("handles absolute, relative and Windows-style paths", () => {
    expect(isProseFilePath("/Users/x/docs/spec.md")).toBe(true);
    expect(isProseFilePath("./docs/spec.rst")).toBe(true);
    expect(isProseFilePath("C:\\docs\\spec.txt")).toBe(true);
  });

  it("does not wrap files with no extension", () => {
    // `split(".").pop()` returns the whole name for these, so the guard has to
    // fall through the allowlist rather than matching on it.
    expect(isProseFilePath("LICENSE")).toBe(false);
    expect(isProseFilePath("Makefile")).toBe(false);
    expect(isProseFilePath("/etc/hosts")).toBe(false);
  });

  it("does not treat a prose word in the path as a prose file", () => {
    expect(isProseFilePath("txt/parser.ts")).toBe(false);
    expect(isProseFilePath("docs.md/index.ts")).toBe(false);
  });
});
