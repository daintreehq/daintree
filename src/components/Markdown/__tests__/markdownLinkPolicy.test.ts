import { describe, expect, it } from "vitest";
import { resolveMarkdownLink } from "../markdownLinkPolicy";

const PATHS = { filePath: "/repo/docs/spec.md", rootPath: "/repo" };

describe("resolveMarkdownLink", () => {
  it("sends http(s) and mailto links to the browser as written", () => {
    for (const url of ["https://example.com/a?b#c", "HTTP://x.dev", "mailto:a@b.dev"]) {
      expect(resolveMarkdownLink(url, PATHS)).toEqual({ kind: "external", url });
    }
  });

  it("resolves a repo link against the document, without its query or fragment", () => {
    for (const href of ["../README.md#usage?x=1", "../README.md?x=1#usage", "../README.md?x"]) {
      expect(resolveMarkdownLink(href, PATHS)).toEqual({
        kind: "file",
        path: "/repo/README.md",
        rootPath: "/repo",
      });
    }
  });

  it("decodes a percent-encoded path before holding it to the root", () => {
    expect(resolveMarkdownLink("my%20notes.md", PATHS)).toMatchObject({
      path: "/repo/docs/my notes.md",
    });
    expect(resolveMarkdownLink("100%.md", PATHS)).toMatchObject({ path: "/repo/docs/100%.md" });
    expect(resolveMarkdownLink("..%2F..%2Fetc%2Fpasswd", PATHS)).toBeNull();
  });

  it("goes nowhere for a link that leaves the document's root", () => {
    expect(resolveMarkdownLink("../../etc/passwd", PATHS)).toBeNull();
    expect(resolveMarkdownLink("/etc/passwd", PATHS)).toBeNull();
    expect(resolveMarkdownLink("../../repo-other/a.md", PATHS)).toBeNull();
  });

  // Rendered mode's sanitizer lets some of these through and the Markdown
  // editor and Source view read destinations raw: none may become a repo path.
  it("goes nowhere for any other scheme, protocol-relative link, or bare fragment", () => {
    for (const href of [
      "javascript:alert(1)",
      "xmpp:someone@example.com",
      "file:///repo/docs/a.md",
      "vscode://file/repo",
      "x:notes.md",
      "//evil.example/a.md",
      "#setup",
      "",
      undefined,
    ]) {
      expect(resolveMarkdownLink(href, PATHS)).toBeNull();
    }
  });

  it("still treats a Windows drive path as a path, not a scheme", () => {
    const windows = { filePath: "C:\\repo\\docs\\spec.md", rootPath: "C:\\repo" };
    for (const href of ["C:\\repo\\notes\\todo.md", "C:/repo/notes/todo.md"]) {
      expect(resolveMarkdownLink(href, windows)).toEqual({
        kind: "file",
        path: "C:/repo/notes/todo.md",
        rootPath: "C:\\repo",
      });
    }
  });
});
