import { describe, it, expect } from "vitest";
import { styleUrls, containsUrl } from "../UrlStyler.js";

// OSC 8 and ANSI escape sequences used in the implementation
const ESC = "\x1b";
const BEL = "\x07";
const OSC_START = `${ESC}]8;;`;
const OSC_END = `${ESC}]8;;${BEL}`;
const ANSI = {
  BLUE_FG: `${ESC}[38;2;56;189;248m`,
  UNDERLINE_ON: `${ESC}[4m`,
  RESET: `${ESC}[0m`,
} as const;

/**
 * Helper to create expected OSC 8 hyperlink output
 */
function expectedHyperlink(url: string): string {
  const styledText = `${ANSI.BLUE_FG}${ANSI.UNDERLINE_ON}${url}${ANSI.RESET}`;
  return `${OSC_START}${url}${BEL}${styledText}${OSC_END}`;
}

describe("UrlStyler", () => {
  describe("styleUrls", () => {
    describe("basic URL styling with OSC 8", () => {
      it("creates OSC 8 hyperlink for simple HTTP URL", () => {
        const input = "Check http://example.com for details";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain(OSC_END);
        expect(output).toContain("http://example.com");
      });

      it("creates OSC 8 hyperlink for simple HTTPS URL", () => {
        const input = "Visit https://github.com/user/repo";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain("https://github.com/user/repo");
      });

      it("handles URL at the beginning of text", () => {
        const input = "https://example.com is a great site";
        const output = styleUrls(input);

        expect(output.startsWith(OSC_START)).toBe(true);
        expect(output).toContain(" is a great site");
      });

      it("handles URL at the end of text", () => {
        const input = "Visit the site at https://example.com";
        const output = styleUrls(input);

        expect(output.endsWith(OSC_END)).toBe(true);
        expect(output).toContain("Visit the site at ");
      });

      it("handles URL only (no surrounding text)", () => {
        const input = "https://example.com/path";
        const output = styleUrls(input);

        expect(output).toBe(expectedHyperlink("https://example.com/path"));
      });

      it("handles multiple URLs in single line", () => {
        const input = "See https://a.com and https://b.com for info";
        const output = styleUrls(input);

        // Each URL produces 2 OSC_START sequences (start + end of hyperlink)
        // So 2 URLs = 4 OSC_START occurrences
        const oscCount = output.split(OSC_START).length - 1;
        expect(oscCount).toBe(4);
      });

      it("includes ANSI styling within the hyperlink", () => {
        const input = "https://example.com";
        const output = styleUrls(input);

        expect(output).toContain(ANSI.BLUE_FG);
        expect(output).toContain(ANSI.UNDERLINE_ON);
        expect(output).toContain(ANSI.RESET);
      });
    });

    describe("URL formats", () => {
      it("styles URLs with ports", () => {
        const input = "Server at http://localhost:3000/api";
        const output = styleUrls(input);

        expect(output).toContain("http://localhost:3000/api");
        expect(output).toContain(OSC_START);
      });

      it("styles URLs with query parameters", () => {
        const input = "Search at https://google.com/search?q=test&lang=en";
        const output = styleUrls(input);

        expect(output).toContain("https://google.com/search?q=test&lang=en");
        expect(output).toContain(OSC_START);
      });

      it("styles URLs with fragments", () => {
        const input = "Go to https://docs.com/page#section";
        const output = styleUrls(input);

        expect(output).toContain("https://docs.com/page#section");
        expect(output).toContain(OSC_START);
      });

      it("styles URLs with authentication", () => {
        const input = "API at https://user:pass@api.example.com";
        const output = styleUrls(input);

        expect(output).toContain("https://user:pass@api.example.com");
        expect(output).toContain(OSC_START);
      });

      it("handles complex URLs with all components", () => {
        const input =
          "Full URL: https://user@example.com:8080/path/to/resource?key=value&foo=bar#section";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain(
          "https://user@example.com:8080/path/to/resource?key=value&foo=bar#section"
        );
      });
    });

    describe("preserving existing escape sequences", () => {
      it("does not modify text with existing ANSI codes", () => {
        const input = "\x1b[31mError:\x1b[0m https://example.com";
        const output = styleUrls(input);

        expect(output).toBe(input);
      });

      it("preserves colorized ls output", () => {
        const input = "\x1b[34mdir/\x1b[0m \x1b[32mfile.txt\x1b[0m";
        const output = styleUrls(input);

        expect(output).toBe(input);
      });

      it("preserves ANSI codes even when URL present", () => {
        const input = "\x1b[1mBold\x1b[0m text with https://example.com";
        const output = styleUrls(input);

        expect(output).toBe(input);
      });

      it("does not modify text with existing OSC sequences", () => {
        const input = "\x1b]0;Window Title\x07 https://example.com";
        const output = styleUrls(input);

        expect(output).toBe(input);
      });
    });

    describe("edge cases", () => {
      it("returns empty string for empty input", () => {
        expect(styleUrls("")).toBe("");
      });

      it("returns original text when no URLs present", () => {
        const input = "Plain text without any URLs";
        expect(styleUrls(input)).toBe(input);
      });

      it("handles newlines", () => {
        const input = "Line 1\nhttps://example.com\nLine 3";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain("\n");
      });

      it("handles tabs", () => {
        const input = "Tab:\thttps://example.com\ttab";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain("\t");
      });

      it("styles URLs inside angle brackets without including closing bracket", () => {
        const input = "Email: <https://example.com>";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain("https://example.com");
        expect(output).not.toContain(expectedHyperlink("https://example.com>"));
        expect(output).toContain(">");
      });

      it("styles URLs inside double quotes", () => {
        const input = 'URL is "https://example.com"';
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain("https://example.com");
      });

      it("excludes trailing punctuation from URL", () => {
        const input = "Go to https://example.com. Then continue.";
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
        expect(output).toContain("https://example.com");
        expect(output).not.toContain(expectedHyperlink("https://example.com."));
        expect(output).toContain(". Then continue.");
      });

      it("handles URL followed by comma", () => {
        const input = "Sites like https://a.com, https://b.com work";
        const output = styleUrls(input);

        // Each URL produces 2 OSC_START sequences (start + end of hyperlink)
        const oscCount = output.split(OSC_START).length - 1;
        expect(oscCount).toBe(4);
      });
    });

    describe("OSC 8 format verification", () => {
      it("produces correct OSC 8 sequence structure", () => {
        const url = "https://example.com";
        const output = styleUrls(url);

        // Verify the structure: OSC_START + URL + BEL + styled_text + OSC_END
        // eslint-disable-next-line no-control-regex
        expect(output).toMatch(/^\x1b\]8;;https:\/\/example\.com\x07/);
        // eslint-disable-next-line no-control-regex
        expect(output).toMatch(/\x1b\]8;;\x07$/);
      });

      it("URL appears twice - once in link and once in display text", () => {
        const url = "https://test.com";
        const output = styleUrls(url);

        // URL should appear twice: in the OSC 8 URI and in the display text
        const urlCount = output.split(url).length - 1;
        expect(urlCount).toBe(2);
      });
    });

    describe("sentinel check optimization", () => {
      it("returns unchanged for text without protocol", () => {
        const input = "Building project...\nTests passed: 42\n";
        expect(styleUrls(input)).toBe(input);
      });

      it("returns unchanged for JSON output without URLs", () => {
        const input = '{"status": "success", "count": 100}\n';
        expect(styleUrls(input)).toBe(input);
      });

      it("still styles http:// URLs correctly", () => {
        const input = "Error fetching http://api.test/data\n";
        const output = styleUrls(input);
        expect(output).toContain(OSC_START);
        expect(output).toContain("http://api.test/data");
      });

      it("still styles https:// URLs correctly", () => {
        const input = "Visit https://example.com for docs\n";
        const output = styleUrls(input);
        expect(output).toContain(OSC_START);
        expect(output).toContain("https://example.com");
      });

      it("skips httpie and similar non-URL text with http substring", () => {
        const input = "Install httpie with npm install -g httpie\n";
        const output = styleUrls(input);
        expect(output).toBe(input);
      });

      it("skips http_status and similar variable names", () => {
        const input = "const http_status = 200;";
        const output = styleUrls(input);
        expect(output).toBe(input);
      });

      it("handles parentheses around URLs correctly", () => {
        const input = "See documentation (https://example.com).";
        const output = styleUrls(input);
        expect(output).toContain(OSC_START);
        expect(output).toContain("https://example.com");
        expect(output).not.toContain(expectedHyperlink("https://example.com)."));
      });

      it("handles comma after URL correctly", () => {
        const input = "Sites like https://a.com, https://b.com work";
        const output = styleUrls(input);
        expect(output).toContain("https://a.com");
        expect(output).toContain("https://b.com");
        expect(output).not.toContain(expectedHyperlink("https://a.com,"));
      });
    });

    describe("performance considerations", () => {
      it("handles large text efficiently", () => {
        const text = "Some text with https://example.com embedded. ";
        const input = text.repeat(1000);
        const output = styleUrls(input);

        expect(output).toContain(OSC_START);
      });

      it("handles text with no URLs quickly", () => {
        const input = "Lorem ipsum ".repeat(10000);
        const output = styleUrls(input);

        expect(output).toBe(input);
      });

      it("sentinel check provides speedup for non-URL output", () => {
        const nonUrlInput = "Building project...\nCompiling files...\n".repeat(10000);
        const urlInput = "Visit https://example.com for docs\n".repeat(10000);

        const nonUrlStart = performance.now();
        styleUrls(nonUrlInput);
        const nonUrlDuration = performance.now() - nonUrlStart;

        const urlStart = performance.now();
        styleUrls(urlInput);
        const urlDuration = performance.now() - urlStart;

        // Non-URL output should be faster than URL output
        expect(nonUrlDuration).toBeLessThan(urlDuration);
      });

      it("processes many non-URL chunks efficiently", () => {
        const nonUrlChunks = Array.from(
          { length: 10000 },
          (_, i) => `Line ${i}: Building project...\n`
        );

        for (const chunk of nonUrlChunks) {
          const result = styleUrls(chunk);
          expect(result).toBe(chunk);
        }
      });

      it("processes URL chunks without significant overhead", () => {
        const urlChunks = Array.from(
          { length: 1000 },
          (_, i) => `Line ${i}: https://example.com/page/${i}\n`
        );

        for (const chunk of urlChunks) {
          const result = styleUrls(chunk);
          expect(result).toContain(OSC_START);
        }
      });
    });
  });

  describe("containsUrl", () => {
    it("returns true for text with HTTP URL", () => {
      expect(containsUrl("Check http://example.com")).toBe(true);
    });

    it("returns true for text with HTTPS URL", () => {
      expect(containsUrl("Check https://example.com")).toBe(true);
    });

    it("returns false for text without URLs", () => {
      expect(containsUrl("Plain text without URLs")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(containsUrl("")).toBe(false);
    });

    it("returns false for text with ftp URL (not supported)", () => {
      expect(containsUrl("File at ftp://files.example.com")).toBe(false);
    });

    it("returns true for text with multiple URLs", () => {
      expect(containsUrl("https://a.com and https://b.com")).toBe(true);
    });
  });
});
