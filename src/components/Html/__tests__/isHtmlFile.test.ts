import { describe, expect, it } from "vitest";
import { isHtmlFilePath } from "../isHtmlFile";

describe("isHtmlFilePath", () => {
  it("matches .html and .htm regardless of case", () => {
    expect(isHtmlFilePath("index.html")).toBe(true);
    expect(isHtmlFilePath("page.htm")).toBe(true);
    expect(isHtmlFilePath("REPORT.HTML")).toBe(true);
    expect(isHtmlFilePath("Page.Htm")).toBe(true);
    expect(isHtmlFilePath("/a/b/dist/report.html")).toBe(true);
  });

  it("does not match .xhtml, .xml, or non-html extensions", () => {
    // .xhtml is deliberately excluded (XML parsing/MIME semantics differ).
    expect(isHtmlFilePath("page.xhtml")).toBe(false);
    expect(isHtmlFilePath("data.xml")).toBe(false);
    expect(isHtmlFilePath("styles.css")).toBe(false);
    expect(isHtmlFilePath("script.js")).toBe(false);
    expect(isHtmlFilePath("notes.md")).toBe(false);
  });

  it("does not match when html is not the final extension", () => {
    expect(isHtmlFilePath("template.html.ts")).toBe(false);
    expect(isHtmlFilePath("htmlfile")).toBe(false);
    expect(isHtmlFilePath("")).toBe(false);
    // NB: a bare "html" (or "htm") matches, since the last dot-segment is the
    // extension — identical to isMarkdownFilePath("md"). Harmless edge case.
  });
});
