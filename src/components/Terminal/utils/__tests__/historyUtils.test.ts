import { describe, it, expect, beforeAll } from "vitest";
import { Window } from "happy-dom";
import { parseXtermHtmlRows } from "../historyUtils";

// Setup DOM environment for tests
let window: Window;

beforeAll(() => {
  window = new Window();
  globalThis.DOMParser = window.DOMParser as unknown as typeof globalThis.DOMParser;
});

describe("parseXtermHtmlRows", () => {
  it("preserves HTML entities in row content", () => {
    const xtermHtml = `<html><body><pre><div><div><span>&lt;div&gt;test&lt;/div&gt;</span></div></div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe("<span>&lt;div&gt;test&lt;/div&gt;</span>");
  });

  it("handles multiple rows with HTML entities", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span>&lt;div&gt;line 1&lt;/div&gt;</span></div>
<div><span>&amp; line 2</span></div>
<div><span>&quot;line 3&quot;</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("&lt;div&gt;");
    expect(rows[1]).toContain("&amp;");
    expect(rows[2]).toContain("&quot;");
  });

  it("preserves multiple spans with different styles", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span style="color:#fff;">Hello </span><span style="color:#0f0;">World</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('<span style="color:#fff;">Hello </span>');
    expect(rows[0]).toContain('<span style="color:#0f0;">World</span>');
  });

  it("handles empty rows", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span> </span></div>
<div></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("<span> </span>");
    expect(rows[1]).toBe(" ");
  });

  it("handles rows with URLs and HTML entities", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span>Visit https://example.com/page?a=1&amp;b=2 for info</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    // URL should preserve &amp; entity
    expect(rows[0]).toContain("https://example.com/page?a=1&amp;b=2");
  });

  it("handles complex nested HTML with entities", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span style="color:red;">&lt;script&gt;</span><span style="color:blue;">alert(1);</span><span style="color:red;">&lt;/script&gt;</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("&lt;script&gt;");
    expect(rows[0]).toContain("&lt;/script&gt;");
    expect(rows[0]).toContain("alert(1);");
  });

  it("handles numeric HTML entities", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span>Numeric: &#60;test&#62; and &#x3C;hex&#x3E;</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    // Numeric entities get decoded by DOMParser, then re-escaped by serializeXtermNode
    expect(rows[0]).toContain("&lt;test&gt;");
    expect(rows[0]).toContain("&lt;hex&gt;");
  });

  it("strips unknown tags for XSS prevention", () => {
    const xtermHtml = `<html><body><pre><div>
<div><script>alert(1)</script><span>safe</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    // Unknown tags should be stripped, leaving only text content
    expect(rows[0]).not.toContain("<script");
    expect(rows[0]).toContain("alert(1)"); // Text content preserved
    expect(rows[0]).toContain("<span>safe</span>");
  });

  it("linkifies URLs in parsed output", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span>Visit https://example.com for info</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    // Verify linkification actually created an anchor tag
    expect(rows[0]).toContain('<a href="https://example.com"');
    expect(rows[0]).toContain('target="_blank"');
  });

  it("handles non-breaking spaces", () => {
    const xtermHtml = `<html><body><pre><div>
<div><span>hello&nbsp;world</span></div>
</div></pre></body></html>`;
    const rows = parseXtermHtmlRows(xtermHtml);

    expect(rows).toHaveLength(1);
    // &nbsp; gets decoded by DOMParser to a non-breaking space character (U+00A0)
    // Our serializer treats it as text content - this is expected behavior
    expect(rows[0]).toContain("hello");
    expect(rows[0]).toContain("world");
  });
});
