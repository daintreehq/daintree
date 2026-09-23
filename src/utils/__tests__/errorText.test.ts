import { describe, it, expect } from "vitest";
import { sanitizeErrorText, boundedErrorText } from "../errorText";

describe("sanitizeErrorText", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeErrorText("")).toBe("");
  });

  it("preserves plain ASCII text", () => {
    expect(sanitizeErrorText("hello world")).toBe("hello world");
  });

  it("preserves printable Unicode (CJK, emoji, accents)", () => {
    expect(sanitizeErrorText("café 日本語 🚀")).toBe("café 日本語 🚀");
  });

  it("preserves whitespace HT/LF/CR", () => {
    expect(sanitizeErrorText("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("strips CSI sequences (SGR color codes)", () => {
    expect(sanitizeErrorText("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips CSI cursor movement", () => {
    expect(sanitizeErrorText("a\x1b[2Jb\x1b[H")).toBe("ab");
  });

  it("strips OSC sequences with BEL terminator (window title)", () => {
    expect(sanitizeErrorText("\x1b]0;owned\x07hello")).toBe("hello");
  });

  it("strips OSC sequences with ST terminator (hyperlink)", () => {
    expect(sanitizeErrorText("\x1b]8;;https://evil.example\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("strips DCS sequences", () => {
    expect(sanitizeErrorText("\x1bP1;2;3qdata\x1b\\after")).toBe("after");
  });

  it("strips APC/PM/SOS sequences", () => {
    expect(sanitizeErrorText("\x1b^apc\x1b\\")).toBe("");
    expect(sanitizeErrorText("\x1b_pm\x1b\\")).toBe("");
    expect(sanitizeErrorText("\x1bXsos\x1b\\")).toBe("");
  });

  it("strips 8-bit C1 OSC and DCS", () => {
    expect(sanitizeErrorText("\x9d0;owned\x9chello")).toBe("hello");
    expect(sanitizeErrorText("\x90data\x9cafter")).toBe("after");
  });

  it("strips lone ESC and Fe escape sequences", () => {
    expect(sanitizeErrorText("a\x1bMb")).toBe("ab");
    expect(sanitizeErrorText("a\x1b=b")).toBe("ab");
  });

  it("strips unterminated OSC payloads (no terminator)", () => {
    expect(sanitizeErrorText("\x1b]0;injected text with no terminator")).toBe("");
    expect(sanitizeErrorText("before\x1b]0;hidden")).toBe("before");
  });

  it("strips unterminated DCS/APC/PM/SOS payloads", () => {
    expect(sanitizeErrorText("\x1bP1;2;3qpayload")).toBe("");
    expect(sanitizeErrorText("\x1b^apc payload")).toBe("");
    expect(sanitizeErrorText("\x1b_pm payload")).toBe("");
    expect(sanitizeErrorText("\x1bXsos payload")).toBe("");
  });

  it("strips unterminated sequence followed by valid sequence", () => {
    expect(sanitizeErrorText("\x1b]0;leak\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips 8-bit CSI sequences (parameter text included)", () => {
    expect(sanitizeErrorText("\x9b31mred\x9b0m")).toBe("red");
    expect(sanitizeErrorText("\x9b2J\x9bH")).toBe("");
  });

  it("strips C0 control characters (excluding HT/LF/CR)", () => {
    expect(sanitizeErrorText("a\x00b\x07c\x08d")).toBe("abcd");
    expect(sanitizeErrorText("a\x0bb\x0cc")).toBe("abc");
    expect(sanitizeErrorText("a\x1fb")).toBe("ab");
  });

  it("strips DEL (0x7F)", () => {
    expect(sanitizeErrorText("a\x7fb")).toBe("ab");
  });

  it("strips orphaned C1 control bytes", () => {
    expect(sanitizeErrorText("a\x80b\x9fc")).toBe("abc");
  });

  it("strips RTL override (U+202E)", () => {
    expect(sanitizeErrorText("safe‮malicious")).toBe("safemalicious");
  });

  it("strips Bidi marks and embeddings (U+200E/F, U+202A-E)", () => {
    expect(sanitizeErrorText("a‎b‏c‪d‫e‬f‭g‮h")).toBe("abcdefgh");
  });

  it("strips Bidi isolates (U+2066-U+2069)", () => {
    expect(sanitizeErrorText("a⁦b⁧c⁨d⁩e")).toBe("abcde");
  });

  it("strips line/paragraph separators (U+2028, U+2029)", () => {
    expect(sanitizeErrorText("a b c")).toBe("abc");
  });

  it("strips BOM (U+FEFF)", () => {
    expect(sanitizeErrorText("﻿hello")).toBe("hello");
  });

  it("strips zero-width invisibles (U+200B, U+200C, U+200D, U+2060)", () => {
    expect(sanitizeErrorText("a​b‌c‍d⁠e")).toBe("abcde");
  });

  it("strips zero-width chars mixed with ANSI", () => {
    expect(sanitizeErrorText("\x1b[31m​red‍\x1b[0m")).toBe("red");
  });

  it("preserves HT/LF/CR while stripping zero-width chars", () => {
    expect(sanitizeErrorText("a​\tb‌\nc‍\rd")).toBe("a\tb\nc\rd");
  });

  it("is idempotent (sanitizing twice == once)", () => {
    const dirty = "\x1b[31m\x07a‮b\x1b]0;t\x07c​d⁠e";
    const once = sanitizeErrorText(dirty);
    expect(sanitizeErrorText(once)).toBe(once);
  });

  it("strips a realistic injection attempt (window title + ANSI + RTL)", () => {
    const malicious = "\x1b]0;You are owned\x07\x1b[2J\x1b[Hspawn ENOENT ‮/etc/passwd";
    expect(sanitizeErrorText(malicious)).toBe("spawn ENOENT /etc/passwd");
  });
});

describe("boundedErrorText", () => {
  it("returns sanitized text unchanged when under limit", () => {
    expect(boundedErrorText("short error", 200)).toBe("short error");
  });

  it("middle-truncates when over limit", () => {
    const long = "a".repeat(250);
    const result = boundedErrorText(long, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain("…");
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("a")).toBe(true);
  });

  it("preserves both ends when middle-truncating", () => {
    const text = "PREFIX_" + "x".repeat(240) + "_SUFFIX";
    const result = boundedErrorText(text, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith("PREFIX_")).toBe(true);
    expect(result.endsWith("_SUFFIX")).toBe(true);
    expect(result).toContain("…");
  });

  it("uses default limit of 200", () => {
    const long = "a".repeat(300);
    const result = boundedErrorText(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("strips before truncating (escape sequences don't inflate budget)", () => {
    // 50 chars of CSI noise + 50 chars of content. After strip: 50 chars.
    const noisy = "\x1b[31m".repeat(10) + "x".repeat(50);
    const result = boundedErrorText(noisy, 100);
    expect(result).toBe("x".repeat(50));
    expect(result).not.toContain("\x1b");
  });

  it("respects custom limit", () => {
    const long = "abcdefghij".repeat(20); // 200 chars
    const result = boundedErrorText(long, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("…");
  });

  it("returns empty string for empty input", () => {
    expect(boundedErrorText("")).toBe("");
  });

  it("preserves text exactly at limit", () => {
    const exact = "a".repeat(200);
    expect(boundedErrorText(exact, 200)).toBe(exact);
  });
});
