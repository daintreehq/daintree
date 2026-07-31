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
import { setUserRegistry } from "../../config/agentRegistry.js";
import type { AgentConfig } from "../../config/agentRegistry.js";

describe("terminalInputProtocol", () => {
  it("returns expected soft newline sequence for registered agents", () => {
    expect(getSoftNewlineSequence("codex")).toBe("\n");
    expect(getSoftNewlineSequence("claude")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("gemini")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("opencode")).toBe("\n");
  });

  it("falls back to LF for normal terminal types", () => {
    expect(getSoftNewlineSequence("terminal")).toBe("\n");
    expect(getSoftNewlineSequence(undefined)).toBe("\n");
  });

  it("defaults to ESC+CR for unknown agent types", () => {
    expect(getSoftNewlineSequence("unknown-agent")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("custom-cli")).toBe("\x1b\r");
  });

  it("uses ESC+CR default for registered agent with missing softNewlineSequence capability", () => {
    const customAgent: AgentConfig = {
      id: "test-agent",
      name: "Test Agent",
      command: "test-agent",
      color: "#ffffff",
      iconId: "custom",
      supportsContextInjection: false,
      capabilities: {
        scrollback: 1000,
      },
    };
    setUserRegistry({ "test-agent": customAgent });
    expect(getSoftNewlineSequence("test-agent")).toBe("\x1b\r");
    setUserRegistry({});
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

  it("neutralizes an embedded terminator so the wrapper cannot be escaped", () => {
    // Text carrying its own END sequence would otherwise close the paste early
    // and hand the remainder to the program as ordinary input.
    const wrapped = formatWithBracketedPaste(`before${BRACKETED_PASTE_END}after`);

    expect(wrapped.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(wrapped.endsWith(BRACKETED_PASTE_END)).toBe(true);
    expect(wrapped.split(BRACKETED_PASTE_END).length - 1).toBe(1);

    const body = wrapped.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
    expect(body).not.toContain(String.fromCharCode(27));
    // The text is still readable — only the ESC byte is swapped for its glyph.
    expect(body).toContain("before");
    expect(body).toContain("after");
  });

  it("leaves text without escape sequences untouched", () => {
    const plain = "@/Users/test/src/App.tsx ";
    expect(formatWithBracketedPaste(plain)).toBe(
      `${BRACKETED_PASTE_START}${plain}${BRACKETED_PASTE_END}`
    );
  });
});
