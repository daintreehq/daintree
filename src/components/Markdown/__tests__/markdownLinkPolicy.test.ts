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
    expect(resolveMarkdownLink("../README.md#usage?x=1", PATHS)).toEqual({
      kind: "file",
      path: "/repo/README.md",
      rootPath: "/repo",
    });
  });

  it("goes nowhere for a link that leaves the document's root", () => {
    expect(resolveMarkdownLink("../../etc/passwd", PATHS)).toBeNull();
    expect(resolveMarkdownLink("/etc/passwd", PATHS)).toBeNull();
  });

  // Rendered mode's sanitizer lets some of these through and the Markdown
  // editor and Source view read destinations raw: none may become a repo path.
  it("goes nowhere for any other scheme, protocol-relative link, or bare fragment", () => {
    for (const href of [
      "javascript:alert(1)",
      "xmpp:someone@example.com",
      "file:///repo/docs/a.md",
      "vscode://file/repo",
      "//evil.example/a.md",
      "#setup",
      "",
      undefined,
    ]) {
      expect(resolveMarkdownLink(href, PATHS)).toBeNull();
    }
  });

  it("still treats a Windows drive path as a path, not a scheme", () => {
    expect(
      resolveMarkdownLink("C:\\repo\\notes\\todo.md", {
        filePath: "C:\\repo\\docs\\spec.md",
        rootPath: "C:\\repo",
      })
    ).toEqual({ kind: "file", path: "C:/repo/notes/todo.md", rootPath: "C:\\repo" });
  });
});
