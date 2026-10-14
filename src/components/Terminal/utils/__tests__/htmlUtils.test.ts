import { describe, it, expect } from "vitest";
import { escapeHtml, escapeHtmlAttribute, linkifyHtml, convertAnsiLinesToHtml } from "../htmlUtils";

describe("escapeHtml", () => {
  it("escapes < and > characters", () => {
    expect(escapeHtml("<div>Hello</div>")).toBe("&lt;div&gt;Hello&lt;/div&gt;");
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("preserves normal text", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("escapeHtmlAttribute", () => {
  it("escapes single quotes", () => {
    expect(escapeHtmlAttribute("value with 'quotes'")).toBe("value with &#39;quotes&#39;");
  });

  it("preserves newlines (allowed in HTML attributes)", () => {
    // Newlines are valid in HTML attribute values per spec
    expect(escapeHtmlAttribute("value\nwith\nnewlines")).toBe("value\nwith\nnewlines");
  });

  it("escapes all quote/angle characters together", () => {
    expect(escapeHtmlAttribute('a="b" & <c>')).toBe("a=&quot;b&quot; &amp; &lt;c&gt;");
  });

  it("handles empty string", () => {
    expect(escapeHtmlAttribute("")).toBe("");
  });

  it("handles CSS style values correctly", () => {
    // Normal CSS should work fine
    expect(escapeHtmlAttribute("color:#fff; background:rgba(0,0,0,0.5)")).toBe(
      "color:#fff; background:rgba(0,0,0,0.5)"
    );
  });

  it("handles URL query parameters correctly", () => {
    // URLs with = in query params should work
    expect(escapeHtmlAttribute("https://example.com?a=1&b=2")).toBe(
      "https://example.com?a=1&amp;b=2"
    );
  });
});

describe("linkifyHtml XSS prevention", () => {
  it("excludes quotes from URLs - regex-level protection", () => {
    // The URL regex excludes " and ' so they won't be part of the matched URL
    const input = 'Visit https://example.com" onclick="alert(1)';
    const output = linkifyHtml(input);
    // The quote ends the URL match, so onclick is outside the link
    expect(output).toContain('<a href="https://example.com"');
    expect(output).toContain('</a>" onclick=');
  });

  it("excludes angle brackets from URLs - regex-level protection", () => {
    // The URL regex excludes < and > so they won't be part of the matched URL
    const input = "URL: https://example.com<script>alert(1)</script>";
    const output = linkifyHtml(input);
    // The < ends the URL match, so script tag is outside the link
    expect(output).toContain('<a href="https://example.com"');
    expect(output).toContain("</a><script>");
  });

  it("excludes single quotes from URLs - regex-level protection", () => {
    const input = "Visit https://example.com' onclick='alert(1)";
    const output = linkifyHtml(input);
    // The ' ends the URL match, so onclick is outside the link
    expect(output).toContain('<a href="https://example.com"');
    expect(output).toContain("</a>' onclick=");
  });
});

describe("linkifyHtml", () => {
  it("converts http URLs to anchor tags", () => {
    const result = linkifyHtml("Visit https://example.com for info");
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain("color:var(--theme-syntax-link, #38bdf8)");
  });

  it("handles URLs with escaped ampersands", () => {
    const result = linkifyHtml("Visit https://example.com/path?a=1&amp;b=2 for info");
    // The full URL including &amp; should be captured in the link
    // The &amp; gets decoded to & then re-escaped back to &amp; (normalized)
    expect(result).toContain('<a href="https://example.com/path?a=1&amp;b=2"');
    // The display text also normalizes to &amp;
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

  it("handles URLs with query parameters containing &", () => {
    const result = convertAnsiLinesToHtml(["Visit https://example.com?a=1&b=2"]);
    // The & gets escaped to &amp; in the input (escapeHtml),
    // then decoded and re-escaped to &amp; in linkifyHtml (normalized)
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
    // URL should be linkified with normalized ampersand (& -> &amp; via escape, decoded & re-escaped in linkify)
    expect(result[0]).toContain('<a href="https://example.com?a=1&amp;b=2"');
  });

  it("does not linkify javascript: URLs (XSS prevention)", () => {
    const result = convertAnsiLinesToHtml(["Click javascript:alert(1)"]);
    expect(result[0]).not.toContain("<a href");
    expect(result[0]).toBe("Click javascript:alert(1)");
  });
});
