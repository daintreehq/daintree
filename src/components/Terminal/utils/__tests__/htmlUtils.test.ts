import { describe, it, expect } from "vitest";
import { escapeHtml, linkifyHtml, convertAnsiLinesToHtml } from "../htmlUtils";

describe("escapeHtml", () => {
  it("escapes < and > characters", () => {
    expect(escapeHtml("<div>Hello</div>")).toBe("&lt;div&gt;Hello&lt;/div&gt;");
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes script tags (XSS prevention)", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("preserves normal text", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("linkifyHtml", () => {
  it("converts http URLs to anchor tags", () => {
    const result = linkifyHtml("Visit https://example.com for info");
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
  });

  it("handles URLs with escaped ampersands", () => {
    const result = linkifyHtml("Visit https://example.com/path?a=1&amp;b=2 for info");
    // The full URL including &amp; should be captured in the link
    expect(result).toContain('<a href="https://example.com/path?a=1&amp;b=2"');
    // The URL text should not be broken at the ampersand
    expect(result).toContain(">https://example.com/path?a=1&amp;b=2</a>");
  });

  it("strips trailing punctuation from URLs", () => {
    const result = linkifyHtml("Check https://example.com.");
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain("</a>.");
  });

  it("linkifies URLs in HTML span content", () => {
    const result = linkifyHtml('<span style="color:red">https://example.com</span>');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it("handles file:// protocol URLs", () => {
    const result = linkifyHtml("Open file:///path/to/file.txt");
    expect(result).toContain('<a href="file:///path/to/file.txt"');
  });
});

describe("convertAnsiLinesToHtml", () => {
  it("escapes HTML in terminal output", () => {
    const result = convertAnsiLinesToHtml(["<div>Hello</div>"]);
    expect(result[0]).toBe("&lt;div&gt;Hello&lt;/div&gt;");
  });

  it("escapes script tags (XSS prevention)", () => {
    const result = convertAnsiLinesToHtml(["<script>alert(1)</script>"]);
    expect(result[0]).toContain("&lt;script&gt;");
    expect(result[0]).not.toContain("<script>");
  });

  it("preserves ANSI color codes as styled spans", () => {
    // Red text ANSI: \x1b[31m
    const result = convertAnsiLinesToHtml(["\x1b[31mRed text\x1b[0m"]);
    expect(result[0]).toContain("ansi-red-fg");
    expect(result[0]).toContain("Red text");
  });

  it("escapes HTML inside colored ANSI text", () => {
    const result = convertAnsiLinesToHtml(["\x1b[31m<div>test</div>\x1b[0m"]);
    expect(result[0]).toContain("&lt;div&gt;test&lt;/div&gt;");
    expect(result[0]).toContain("ansi-red-fg");
  });

  it("linkifies URLs in output", () => {
    const result = convertAnsiLinesToHtml(["Visit https://example.com"]);
    expect(result[0]).toContain('<a href="https://example.com"');
  });

  it("handles URLs with query parameters containing &", () => {
    const result = convertAnsiLinesToHtml(["Visit https://example.com?a=1&b=2"]);
    // The & should be escaped to &amp; but URL should still be fully linkified
    expect(result[0]).toContain('<a href="https://example.com?a=1&amp;b=2"');
    expect(result[0]).toContain("https://example.com?a=1&amp;b=2</a>");
  });

  it("handles empty lines", () => {
    const result = convertAnsiLinesToHtml([""]);
    expect(result[0]).toBe(" ");
  });

  it("handles multiple lines", () => {
    const result = convertAnsiLinesToHtml([
      "<div>Line 1</div>",
      "Normal line",
      "\x1b[32mGreen line\x1b[0m",
    ]);
    expect(result[0]).toContain("&lt;div&gt;");
    expect(result[1]).toBe("Normal line");
    expect(result[2]).toContain("ansi-green-fg");
  });

  it("escapes literal HTML entities from terminal output", () => {
    // If terminal output contains literal "&amp;" string, it gets escaped to "&amp;amp;"
    // This is correct - we escape all HTML special chars including & in the literal text
    const result = convertAnsiLinesToHtml(["&amp;test"]);
    expect(result[0]).toBe("&amp;amp;test");
  });

  it("handles HTML entities like &nbsp;", () => {
    const result = convertAnsiLinesToHtml(["hello&nbsp;world"]);
    expect(result[0]).toBe("hello&amp;nbsp;world");
  });

  it("handles combined HTML + ANSI + URL in one line", () => {
    // Most fragile path: escape → ansi → linkify
    const result = convertAnsiLinesToHtml([
      "\x1b[31m<div>See https://example.com?a=1&b=2</div>\x1b[0m",
    ]);
    // HTML should be escaped
    expect(result[0]).toContain("&lt;div&gt;");
    expect(result[0]).toContain("&lt;/div&gt;");
    // ANSI color should create span
    expect(result[0]).toContain("ansi-red-fg");
    // URL should be linkified with escaped ampersand
    expect(result[0]).toContain('<a href="https://example.com?a=1&amp;b=2"');
  });

  it("does not linkify javascript: URLs (XSS prevention)", () => {
    const result = convertAnsiLinesToHtml(["Click javascript:alert(1)"]);
    expect(result[0]).not.toContain("<a href");
    expect(result[0]).toBe("Click javascript:alert(1)");
  });

  it("handles complex ANSI sequences (bold, multiple colors)", () => {
    // Bold + red + reset
    const result = convertAnsiLinesToHtml(["\x1b[1m\x1b[31mBold Red\x1b[0m Normal"]);
    expect(result[0]).toContain("Bold Red");
    expect(result[0]).toContain("Normal");
    // Should have some styling (exact output depends on Anser implementation)
    expect(result[0].length).toBeGreaterThan("Bold Red Normal".length);
  });
});
