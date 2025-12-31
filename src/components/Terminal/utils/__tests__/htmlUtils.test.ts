import { describe, it, expect } from "vitest";
import { escapeHtml, escapeHtmlAttribute, linkifyHtml, convertAnsiLinesToHtml } from "../htmlUtils";

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

describe("escapeHtmlAttribute", () => {
  it("escapes double quotes", () => {
    expect(escapeHtmlAttribute('value with "quotes"')).toBe("value with &quot;quotes&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtmlAttribute("value with 'quotes'")).toBe("value with &#39;quotes&#39;");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtmlAttribute("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes ampersands", () => {
    expect(escapeHtmlAttribute("foo & bar")).toBe("foo &amp; bar");
  });

  it("preserves newlines (allowed in HTML attributes)", () => {
    // Newlines are valid in HTML attribute values per spec
    expect(escapeHtmlAttribute("value\nwith\nnewlines")).toBe("value\nwith\nnewlines");
  });

  it("preserves equals signs (needed for URLs)", () => {
    // = doesn't break out of quoted attributes
    expect(escapeHtmlAttribute("onclick=alert(1)")).toBe("onclick=alert(1)");
  });

  it("escapes all quote/angle characters together", () => {
    expect(escapeHtmlAttribute('a="b" & <c>')).toBe("a=&quot;b&quot; &amp; &lt;c&gt;");
  });

  it("handles complex attribute injection attempt via quotes", () => {
    // Attacker tries to break out of style and inject onclick using quotes
    // The quotes are escaped, so the injection fails
    const malicious = 'color:red" onclick="alert(1)" data="';
    const escaped = escapeHtmlAttribute(malicious);
    expect(escaped).toBe("color:red&quot; onclick=&quot;alert(1)&quot; data=&quot;");
    // The escaped string is safe - all quotes are escaped so no attribute breakout
  });

  it("preserves normal text", () => {
    expect(escapeHtmlAttribute("normal text")).toBe("normal text");
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

  it("handles URLs with event handler injection attempts", () => {
    const input = 'https://evil.com" onmouseover="alert(document.cookie)';
    const output = linkifyHtml(input);
    // The " ends the URL match, so onmouseover is outside the link
    expect(output).toContain('<a href="https://evil.com"');
    expect(output).toContain('</a>" onmouseover=');
  });

  it("decodes then re-escapes ampersands for proper URL rendering", () => {
    // When URL contains &amp; (from escaped HTML), it gets decoded to &, then re-escaped to &amp;
    // This prevents double-escaping and ensures URLs work correctly
    const input = "Visit https://example.com/path?a=1&amp;b=2";
    const output = linkifyHtml(input);
    // The &amp; gets decoded to & then escaped back to &amp; (proper handling)
    expect(output).toContain('href="https://example.com/path?a=1&amp;b=2"');
  });

  it("escapes display text as well as href", () => {
    // URL with &amp; gets decoded to & then re-escaped for display
    const input = "Visit https://example.com/path?a=1&amp;b=2";
    const output = linkifyHtml(input);
    expect(output).toContain(">https://example.com/path?a=1&amp;b=2</a>");
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
    // URL should be linkified with normalized ampersand (& -> &amp; via escape, decoded & re-escaped in linkify)
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
