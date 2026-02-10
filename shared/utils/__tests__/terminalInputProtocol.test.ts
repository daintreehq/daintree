import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  PASTE_THRESHOLD_CHARS,
  containsFullBracketedPaste,
  formatWithBracketedPaste,
  getSoftNewlineSequence,
  shouldUseBracketedPaste,
} from "../terminalInputProtocol.js";

describe("terminalInputProtocol", () => {
  it("returns expected soft newline sequence for agent types", () => {
    expect(getSoftNewlineSequence("codex")).toBe("\n");
    expect(getSoftNewlineSequence("claude")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("gemini")).toBe("\x1b\r");
  });

  it("falls back to LF for normal terminal types", () => {
    expect(getSoftNewlineSequence("terminal")).toBe("\n");
    expect(getSoftNewlineSequence(undefined)).toBe("\n");
    expect(getSoftNewlineSequence("unknown-agent")).toBe("\n");
  });

  it("detects full bracketed paste sequences only when complete", () => {
    const full = `${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`;
    const missingEnd = `${BRACKETED_PASTE_START}hello`;
    const missingStart = `hello${BRACKETED_PASTE_END}`;

    expect(containsFullBracketedPaste(full)).toBe(true);
    expect(containsFullBracketedPaste(missingEnd)).toBe(false);
    expect(containsFullBracketedPaste(missingStart)).toBe(false);
  });

  it("requires sequence to start with bracketed-paste start token", () => {
    const prefixed = `x${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`;
    expect(containsFullBracketedPaste(prefixed)).toBe(false);
  });

  it("uses bracketed paste for multiline input", () => {
    expect(shouldUseBracketedPaste("line1\nline2")).toBe(true);
  });

  it("uses bracketed paste for large single-line input over threshold", () => {
    const overThreshold = "x".repeat(PASTE_THRESHOLD_CHARS + 1);
    expect(shouldUseBracketedPaste(overThreshold)).toBe(true);
  });

  it("does not use bracketed paste at threshold without newline", () => {
    const atThreshold = "x".repeat(PASTE_THRESHOLD_CHARS);
    expect(shouldUseBracketedPaste(atThreshold)).toBe(false);
  });

  it("formats text with bracketed paste tokens", () => {
    expect(formatWithBracketedPaste("abc")).toBe(
      `${BRACKETED_PASTE_START}abc${BRACKETED_PASTE_END}`
    );
  });
});
