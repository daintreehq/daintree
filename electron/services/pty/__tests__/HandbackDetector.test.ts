import { describe, expect, it } from "vitest";
import { detectHandback } from "../HandbackDetector.js";
import { buildHandbackInstruction } from "../../../../shared/utils/handback.js";
import { HANDBACK_MESSAGE_MAX_CHARS } from "../../../../shared/types/handback.js";

const CODE = "k7f3qa";

describe("detectHandback", () => {
  it("captures the message between the markers", () => {
    const text = [
      "⏺ Refactored the parser.",
      "  DAINTREE-DONE-k7f3qa: parser split into two passes END-k7f3qa",
      "> ",
    ].join("\n");
    expect(detectHandback(text, CODE)).toEqual({
      message: "parser split into two passes",
      truncated: false,
    });
  });

  it("reports a bare handback as a null message", () => {
    expect(detectHandback("DAINTREE-DONE-k7f3qa END-k7f3qa", CODE)).toEqual({
      message: null,
      truncated: false,
    });
    expect(detectHandback("DAINTREE-DONE-k7f3qa: END-k7f3qa", CODE)).toEqual({
      message: null,
      truncated: false,
    });
  });

  it("ignores the echoed instruction", () => {
    const text = `> Fix the bug\n\n${buildHandbackInstruction(CODE)}`;
    expect(detectHandback(text, CODE)).toBeNull();
  });

  it("ignores an echo whose placeholder was wrapped across rows", () => {
    const text = [
      "│ > ... (it may be empty): DAINTREE-DONE-k7f3qa: <sum   │",
      "│   mary> END-k7f3qa                                    │",
    ].join("\n");
    expect(detectHandback(text, CODE)).toBeNull();
  });

  it("ignores an echo repainted with gutter or status text around the placeholder", () => {
    // A raw stream painted by cursor addressing has no newline between rows,
    // so another row's gutter or a status line can land inside the capture.
    expect(detectHandback("DAINTREE-DONE-k7f3qa: │ ▌ <summary> END-k7f3qa", CODE)).toBeNull();
    expect(
      detectHandback("DAINTREE-DONE-k7f3qa: <summary> esc to interrupt END-k7f3qa", CODE)
    ).toBeNull();
  });

  it("finds the real marker after the echoed instruction", () => {
    const text = [
      `> Fix the bug ${buildHandbackInstruction(CODE)}`,
      "⏺ Done.",
      "  DAINTREE-DONE-k7f3qa: fixed the null check END-k7f3qa",
    ].join("\n");
    expect(detectHandback(text, CODE)?.message).toBe("fixed the null check");
  });

  it("does not fire on a mid-task mention with no closing marker", () => {
    const text = "I'll print DAINTREE-DONE-k7f3qa when I finish.\nWorking on it...";
    expect(detectHandback(text, CODE)).toBeNull();
  });

  it("does not fire on a half-streamed marker", () => {
    const text = `${buildHandbackInstruction(CODE)}\n⏺ DAINTREE-DONE-k7f3qa: fixed the null ch`;
    expect(detectHandback(text, CODE)).toBeNull();
  });

  it("skips an unclosed opening marker rather than swallowing the next one", () => {
    const text = [
      "I'll end with DAINTREE-DONE-k7f3qa once the tests pass.",
      "... lots of work ...",
      "DAINTREE-DONE-k7f3qa: tests pass END-k7f3qa",
    ].join("\n");
    expect(detectHandback(text, CODE)?.message).toBe("tests pass");
  });

  it("ignores markers carrying a different code", () => {
    const text = [
      "DAINTREE-DONE-zzzzzz: an earlier turn END-zzzzzz",
      "DAINTREE-DONE-k7f3qa: mismatched END-zzzzzz",
      "cat README.md: DAINTREE-DONE-<code>: <message> END-<code>",
    ].join("\n");
    expect(detectHandback(text, CODE)).toBeNull();
  });

  it("takes the most recent pair when the marker was painted more than once", () => {
    const text = [
      "DAINTREE-DONE-k7f3qa: first paint END-k7f3qa",
      "DAINTREE-DONE-k7f3qa: second paint END-k7f3qa",
    ].join("\n");
    expect(detectHandback(text, CODE)?.message).toBe("second paint");
  });

  it("rejoins a wrapped message, stripping the gutter and collapsing whitespace", () => {
    const text = [
      "⏺ DAINTREE-DONE-k7f3qa: moved the retry loop into the client so the",
      "  │ worker no longer    double-counts timeouts",
      "  ⎿  END-k7f3qa",
    ].join("\n");
    expect(detectHandback(text, CODE)).toEqual({
      message:
        "moved the retry loop into the client so the worker no longer double-counts timeouts",
      truncated: false,
    });
  });

  it("keeps a leading dash on a continuation row", () => {
    const text = "DAINTREE-DONE-k7f3qa: renamed the\n  --force flag END-k7f3qa";
    expect(detectHandback(text, CODE)?.message).toBe("renamed the --force flag");
  });

  it("caps a long message and flags it truncated", () => {
    const long = "word ".repeat(200).trim();
    const result = detectHandback(`DAINTREE-DONE-k7f3qa: ${long} END-k7f3qa`, CODE);
    expect(result?.truncated).toBe(true);
    expect(result?.message).toHaveLength(HANDBACK_MESSAGE_MAX_CHARS);
    expect(long.startsWith(result?.message ?? "missing")).toBe(true);
  });

  it("never leaves half a surrogate pair at the cap", () => {
    const message = `${"a".repeat(HANDBACK_MESSAGE_MAX_CHARS - 1)}😀 tail`;
    const result = detectHandback(`DAINTREE-DONE-k7f3qa: ${message} END-k7f3qa`, CODE);
    expect(result?.truncated).toBe(true);
    expect(result?.message).toBe("a".repeat(HANDBACK_MESSAGE_MAX_CHARS - 1));
  });

  it("returns null for empty text", () => {
    expect(detectHandback("", CODE)).toBeNull();
  });
});
