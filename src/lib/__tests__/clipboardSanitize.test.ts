import { describe, it, expect } from "vitest";
import { sanitizeForClipboard } from "../clipboardSanitize";

describe("sanitizeForClipboard", () => {
  it("returns plain ASCII commands unchanged", () => {
    expect(sanitizeForClipboard("curl -fsSL https://example.com/install.sh | bash")).toBe(
      "curl -fsSL https://example.com/install.sh | bash"
    );
    expect(sanitizeForClipboard("npm install -g @anthropic-ai/claude-code")).toBe(
      "npm install -g @anthropic-ai/claude-code"
    );
  });

  it("preserves shell metacharacters", () => {
    expect(sanitizeForClipboard("a | b ; c && d `e`")).toBe("a | b ; c && d `e`");
  });

  it("strips newlines (LF/CR/CRLF auto-execute vector)", () => {
    expect(sanitizeForClipboard("curl x | bash\nrm -rf /")).toBe("curl x | bashrm -rf /");
    expect(sanitizeForClipboard("a\rb")).toBe("ab");
    expect(sanitizeForClipboard("a\r\nb")).toBe("ab");
  });

  it("strips tabs and other C0 controls", () => {
    expect(sanitizeForClipboard("a\tb\x01c\x1fd")).toBe("abcd");
  });

  it("strips ESC (ANSI escape sequence injection vector)", () => {
    expect(sanitizeForClipboard("ls\x1b[31mred\x1b[0m")).toBe("ls[31mred[0m");
  });

  it("strips DEL and C1 controls", () => {
    expect(sanitizeForClipboard("a\x7fb\x80c\x9fd")).toBe("abcd");
  });

  it("strips zero-width and Bidi format characters", () => {
    // U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+200E LRM, U+200F RLM
    expect(sanitizeForClipboard("a​b‌c‍d‎e‏f")).toBe("abcdef");
    // U+202A–U+202E Bidi embedding/override (incl. RIGHT-TO-LEFT OVERRIDE)
    expect(sanitizeForClipboard("a‪b‫c‬d‭e‮f")).toBe("abcdef");
    // U+2066–U+2069 Bidi isolate marks
    expect(sanitizeForClipboard("a⁦b⁧c⁨d⁩e")).toBe("abcde");
    // U+FEFF BOM / zero-width no-break space
    expect(sanitizeForClipboard("a﻿b")).toBe("ab");
  });

  it("handles empty strings", () => {
    expect(sanitizeForClipboard("")).toBe("");
  });

  it("does not strip ordinary Unicode (em dash, ellipsis, non-Latin scripts)", () => {
    expect(sanitizeForClipboard("install — done … 安裝")).toBe("install — done … 安裝");
  });
});
