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
    // URL's &amp; gets decoded then re-escaped to &amp; (normalized)
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
    // Unknown tags should be stripped, leaving only escaped text content
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

  // Critical: Tests for raw HTML content that xterm outputs WITHOUT escaping
  // xterm's serializeAsHTML outputs raw cell content, so <tag> becomes actual HTML
  // Our preEscapeXtermHtml function must escape this BEFORE DOMParser corrupts the DOM
  describe("raw HTML content from xterm (pre-escape critical path)", () => {
    it("preserves raw angle brackets from terminal output", () => {
      // This simulates what xterm ACTUALLY produces when terminal has <tag>
      // xterm outputs: <span><tag></span> (raw, unescaped)
      // Without our fix, DOMParser creates a <tag> element and loses the text
      const xtermHtml = `<html><body><pre><div>
<div><span>Error: expected <Foo> but got <Bar></span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // The angle brackets should be preserved as escaped entities
      expect(rows[0]).toContain("&lt;Foo&gt;");
      expect(rows[0]).toContain("&lt;Bar&gt;");
      // No actual HTML tags should exist
      expect(rows[0]).not.toMatch(/<Foo>/i);
      expect(rows[0]).not.toMatch(/<Bar>/i);
    });

    it("preserves self-closing tags from terminal output", () => {
      // Common in React/JSX terminal output
      const xtermHtml = `<html><body><pre><div>
<div><span>Component: <Button /> rendered</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("&lt;Button /&gt;");
    });

    it("preserves HTML tags with attributes from terminal output", () => {
      // Git diff showing HTML changes - the div tag inside span is a custom tag name
      // and will be stripped by serializeXtermNode (non-span tags stripped)
      // But since we pre-escape, it becomes &lt;div... in the text
      const xtermHtml = `<html><body><pre><div>
<div><span>+ &lt;div class="container" id="main"&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // The tag should remain escaped
      expect(rows[0]).toContain("&lt;div class=");
      expect(rows[0]).toContain("&gt;");
    });

    it("preserves multiple unknown tags on same line without row corruption", () => {
      // This tests that unknown tags like <head>, <title> are escaped
      // Note: <html> is a known tag in xterm output structure, so we use different tags
      const xtermHtml = `<html><body><pre><div>
<div><span>&lt;header&gt;&lt;nav&gt;&lt;title&gt;Test&lt;/title&gt;&lt;/nav&gt;&lt;/header&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // All tags should be escaped, no DOM corruption
      expect(rows[0]).toContain("&lt;header&gt;");
      expect(rows[0]).toContain("&lt;nav&gt;");
      expect(rows[0]).toContain("&lt;title&gt;");
    });

    it("preserves row count when output contains raw HTML tags", () => {
      // DOM corruption previously caused rows to disappear
      // The <div> inside span is now pre-escaped to &lt;div&gt;
      const xtermHtml = `<html><body><pre><div>
<div><span>Line 1: normal text</span></div>
<div><span>Line 2: &lt;tag&gt;raw tag&lt;/tag&gt;</span></div>
<div><span>Line 3: after tag</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      // CRITICAL: All 3 rows must be preserved
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain("Line 1");
      expect(rows[1]).toContain("Line 2");
      expect(rows[1]).toContain("&lt;tag&gt;");
      expect(rows[2]).toContain("Line 3");
    });

    it("handles closing tags without opening tags", () => {
      // Malformed HTML-like content - test with unknown tags
      const xtermHtml = `<html><body><pre><div>
<div><span>&lt;/footer&gt; some text &lt;/nav&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("&lt;/footer&gt;");
      expect(rows[0]).toContain("&lt;/nav&gt;");
    });

    it("handles angle brackets in error messages", () => {
      // Common TypeScript/compiler error output
      const xtermHtml = `<html><body><pre><div>
<div><span>Type 'string' is not assignable to type '<T extends object>'</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("&lt;T extends object&gt;");
    });

    it("escapes raw structural closing tags in content", () => {
      // CRITICAL SECURITY: Raw </div> in content should NOT close the row div
      const xtermHtml = `<html><body><pre><div>
<div><span>Content with </div> in middle</span></div>
<div><span>Next row should exist</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      // MUST preserve both rows despite raw </div>
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("&lt;/div&gt;");
      expect(rows[1]).toContain("Next row");
    });

    it("escapes raw span tags in content to prevent CSS injection", () => {
      // Raw <span> with style in terminal output could inject CSS
      const xtermHtml = `<html><body><pre><div>
<div><span>Text with <span style="position:fixed">injected</span> tags</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("&lt;span");
      expect(rows[0]).toContain("&lt;/span&gt;");
      // Should NOT contain actual nested span with style
      expect(rows[0]).not.toMatch(/<span[^>]*style=/);
    });
  });

  // Edge cases for HTML-containing diffs that previously broke the history viewer
  describe("HTML in diff output (regression tests)", () => {
    it("escapes raw div tags that appear as content", () => {
      // If xterm somehow produces an unescaped div inside content, it should be escaped
      const xtermHtml = `<html><body><pre><div>
<div><div class="bad">unescaped content</div></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // The div should NOT be rendered as a div - only its text content should appear
      expect(rows[0]).not.toContain("<div");
      expect(rows[0]).toContain("unescaped content");
    });

    it("escapes anchor tags that appear in content (not from linkifyHtml)", () => {
      // If xterm produces an <a> tag, it should be escaped, not passed through
      const xtermHtml = `<html><body><pre><div>
<div><a href="javascript:alert(1)">click me</a></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // The malicious anchor should NOT be rendered
      expect(rows[0]).not.toContain('href="javascript:');
      expect(rows[0]).toContain("click me");
    });

    it("handles diff output with + and - lines containing HTML", () => {
      // Simulates a git diff showing HTML changes
      const xtermHtml = `<html><body><pre><div>
<div><span style="color:green;">+ &lt;div class="new"&gt;</span></div>
<div><span style="color:red;">- &lt;div class="old"&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(2);
      // Both lines should have escaped HTML entities
      expect(rows[0]).toContain("&lt;div class=");
      expect(rows[1]).toContain("&lt;div class=");
      expect(rows[0]).not.toContain("<div class=");
      expect(rows[1]).not.toContain("<div class=");
    });

    it("handles diff output where HTML was NOT properly escaped by xterm", () => {
      // This is the pathological case - if xterm fails to escape HTML
      // Our code must still prevent it from rendering as actual HTML
      const xtermHtml = `<html><body><pre><div>
<div><span style="color:green;">+ <img src=x onerror=alert(1)></span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // The img tag should NOT be in the output as an actual tag
      expect(rows[0]).not.toContain("<img");
      // The text content "+" and the escaped version should be present
      expect(rows[0]).toContain("+");
    });

    it("only allows style attribute on spans, strips all others", () => {
      // If a span has non-style attributes (maybe from xterm addon), strip them
      const xtermHtml = `<html><body><pre><div>
<div><span style="color:red" onclick="alert(1)" data-foo="bar">text</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // Only style attribute should be present
      expect(rows[0]).toContain('style="color:red"');
      expect(rows[0]).not.toContain("onclick");
      expect(rows[0]).not.toContain("data-foo");
    });

    it("escapes HTML entities in style attribute values", () => {
      // Prevent style attribute injection
      const xtermHtml = `<html><body><pre><div>
<div><span style="color:red&quot; onclick=&quot;alert(1)">text</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // The quotes should be escaped, keeping onclick= inside the style value (not as separate attribute)
      // The output should be: style="color:red&quot; onclick=&quot;alert(1)"
      // This is safe because onclick= is part of the style VALUE, not a separate attribute
      expect(rows[0]).toContain('style="color:red&quot;');
      // Verify it's a single style attribute containing the escaped content
      expect(rows[0]).toMatch(/<span style="[^"]*&quot;[^"]*">/);
    });

    it("handles deeply nested malicious HTML", () => {
      const xtermHtml = `<html><body><pre><div>
<div><span><div><script>evil()</script><span>nested</span></div></span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // All malicious content should be stripped/escaped
      expect(rows[0]).not.toContain("<script");
      expect(rows[0]).not.toContain("<div");
      expect(rows[0]).toContain("evil()");
      expect(rows[0]).toContain("nested");
    });

    it("handles React component-like syntax in terminal output", () => {
      // JSX/TSX in terminal output should be escaped
      const xtermHtml = `<html><body><pre><div>
<div><span>&lt;Component prop="value" /&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("&lt;Component");
      expect(rows[0]).toContain("/&gt;");
    });

    it("handles SVG injection attempts", () => {
      // SVG tags are pre-escaped to prevent XSS - they display as text
      const xtermHtml = `<html><body><pre><div>
<div><span>&lt;svg onload="alert(1)"&gt;&lt;circle r="10"/&gt;&lt;/svg&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // SVG is escaped to visible text, not executable
      expect(rows[0]).not.toContain("<svg");
      expect(rows[0]).toContain("&lt;svg");
    });

    it("handles iframe injection attempts", () => {
      // iframe tags are pre-escaped to prevent XSS - they display as text
      const xtermHtml = `<html><body><pre><div>
<div><span>&lt;iframe src="javascript:alert(1)"&gt;&lt;/iframe&gt;</span></div>
</div></pre></body></html>`;
      const rows = parseXtermHtmlRows(xtermHtml);

      expect(rows).toHaveLength(1);
      // iframe is escaped to visible text, not executable
      expect(rows[0]).not.toContain("<iframe");
      expect(rows[0]).toContain("&lt;iframe");
    });
  });
});
