import { describe, expect, it } from "vitest";
import {
  captureTerminalTail,
  dropInputSuggestion,
  INPUT_LINE_TEXT_MAX_CHARS,
  inputSuggestionRuleFor,
  observeInputLine,
} from "../terminalInputLine.js";
import { expandCursorForward, stripAnsiCodes } from "../artifactParser.js";

const claude = inputSuggestionRuleFor("claude");

const EDGE = "────────";

/** A Claude Code screen in the serializer's shape: a reply, then the framed input box. */
function screen(box: string, below = `${EDGE}\r\n  ? for shortcuts`): string {
  return `⏺ Done.\r\n${EDGE}\r\n${box}\r\n${below}`;
}

function plain(serialized: string): string {
  return stripAnsiCodes(expandCursorForward(serialized));
}

describe("observeInputLine", () => {
  it.each([
    ["an empty box", "❯ "],
    ["an empty box under a painted cursor", "❯ \x1b[7m \x1b[27m"],
    ["the static placeholder", '❯ \x1b[2mTry "fix typecheck errors"\x1b[22m'],
    ["the placeholder under a painted cursor", '❯ \x1b[7mT\x1b[27;2mry "fix lint errors"\x1b[22m'],
  ])("reads %s as empty", (_, box) => {
    expect(observeInputLine(screen(box), claude)).toEqual({
      inputLine: { state: "empty", text: "" },
      marked: screen(box),
    });
  });

  it("reads the placeholder's wording typed at full intensity as typed", () => {
    const box = '❯ Try "fix typecheck errors"';
    expect(observeInputLine(screen(box), claude).inputLine).toEqual({
      state: "typed",
      text: 'Try "fix typecheck errors"',
    });
  });

  it("keeps a dim hint beside typed text out of what was typed", () => {
    const box = "❯ /review \x1b[2m[pr-number]\x1b[22m";
    expect(observeInputLine(screen(box), claude).inputLine).toEqual({
      state: "typed",
      text: "/review",
    });
  });

  it("counts a painted cursor inside typed text as typed", () => {
    const box = "❯ add \x1b[7ma\x1b[27m test";
    expect(observeInputLine(screen(box), claude).inputLine).toEqual({
      state: "typed",
      text: "add a test",
    });
  });

  it("reads a lone inverse cell with no dim run after it as typed, not as a cursor", () => {
    expect(observeInputLine(screen("❯ \x1b[7my\x1b[27m"), claude).inputLine.state).toBe("typed");
  });

  it("never reads an RGB component of 2 or 7 as dim or inverse", () => {
    const box = "❯ \x1b[38;2;2;7;2mreal words\x1b[39m";
    expect(observeInputLine(screen(box), claude).inputLine).toEqual({
      state: "typed",
      text: "real words",
    });
  });

  it("carries SGR state in from the rows above", () => {
    // The serializer opens a dim run on one row and lets it run on into the box.
    const carried = `⏺ Done.\r\n\x1b[2m${EDGE}\r\n❯ open the PR\r\n\x1b[22m${EDGE}`;
    expect(observeInputLine(carried, claude).inputLine.state).toBe("suggestion");
    const resetAbove = `\x1b[2m⏺ Done.\x1b[22m\r\n${EDGE}\r\n❯ open the PR\r\n${EDGE}`;
    expect(observeInputLine(resetAbove, claude).inputLine.state).toBe("typed");
  });

  it.each([
    // A permission dialog has replaced the box: the last `❯` rows are an echo
    // of a sent message and the dialog's own pointer.
    ["an echo with nothing above it", "⏺ Done.\r\n❯ \x1b[2mfix the rounding\x1b[22m\r\n ❯ 1. Yes"],
    [
      "an echo under a rule from the transcript",
      `⏺ Reply.\r\n${EDGE}\r\n\x1b[48;5;236m❯ fix the rounding\x1b[0m\r\n⏺ Bash command\r\n  Do you want to proceed?\r\n ❯ 1. Yes\r\n${EDGE}`,
    ],
    [
      "a box with no bottom edge in view",
      `⏺ Done.\r\n${EDGE}\r\n❯ \x1b[2mopen the PR\x1b[22m\r\n  more`,
    ],
  ])("reads %s as no box at all", (_, serialized) => {
    expect(observeInputLine(serialized, claude)).toEqual({
      inputLine: { state: "unknown", text: "" },
      marked: serialized,
    });
  });

  it("keeps the first characters of a long draft and says it cut them", () => {
    const draft = "x".repeat(INPUT_LINE_TEXT_MAX_CHARS + 50);
    expect(observeInputLine(screen(`❯ ${draft}`), claude).inputLine).toEqual({
      state: "typed",
      text: "x".repeat(INPUT_LINE_TEXT_MAX_CHARS),
      truncated: true,
    });
    const whole = "y".repeat(INPUT_LINE_TEXT_MAX_CHARS);
    expect(observeInputLine(screen(`❯ ${whole}`), claude).inputLine).toEqual({
      state: "typed",
      text: whole,
    });
  });

  it("marks a suggestion that wraps across box rows whole on its prompt row", () => {
    const box = "❯ \x1b[2mopen the PR and tell me\x1b[22m\r\n  \x1b[2mwhat is left\x1b[22m";
    const { inputLine, marked } = observeInputLine(screen(box), claude);
    expect(inputLine).toEqual({
      state: "suggestion",
      text: "open the PR and tell me\nwhat is left",
    });
    expect(plain(marked)).toContain(
      "❯ [suggested by Claude Code: open the PR and tell me what is left]\r\n  \r\n"
    );
    // A tail cut below the prompt row keeps none of the suggestion's words.
    const cut = captureTerminalTail(screen(box), 3, true, "claude").content;
    expect(cut).not.toContain("what is left");
  });

  it("keeps a cursor-forward gap inside the suggestion", () => {
    const box = "❯ \x1b[2mopen\x1b[1Cthe\x1b[1CPR\x1b[22m";
    const { inputLine, marked } = observeInputLine(screen(box), claude);
    expect(inputLine).toEqual({ state: "suggestion", text: "open the PR" });
    expect(plain(marked)).toContain("❯ [suggested by Claude Code: open the PR]");
  });

  it("reads only the alternate screen while a TUI holds it, and keeps the buffer beneath", () => {
    const below = screen("❯ \x1b[2mold suggestion\x1b[22m");
    const serialized = `${below}\x1b[?1049h\x1b[H${screen("❯ \x1b[2mopen the PR\x1b[22m")}`;
    const { inputLine, marked } = observeInputLine(serialized, claude);
    expect(inputLine).toEqual({ state: "suggestion", text: "open the PR" });
    expect(marked.startsWith(`${below}\x1b[?1049h`)).toBe(true);
    expect(plain(marked)).toContain("[suggested by Claude Code: open the PR]");
    expect(plain(marked)).not.toContain("[suggested by Claude Code: old suggestion]");
  });

  it("reads every box as unknown for an agent that declares no rule", () => {
    expect(inputSuggestionRuleFor("gemini")).toBeUndefined();
    expect(inputSuggestionRuleFor(null)).toBeUndefined();
    expect(inputSuggestionRuleFor("toString")).toBeUndefined();
    const serialized = screen("❯ \x1b[2mopen the PR\x1b[22m");
    expect(observeInputLine(serialized, undefined)).toEqual({
      inputLine: { state: "unknown", text: "" },
      marked: serialized,
    });
  });
});

const codex = inputSuggestionRuleFor("codex");

const TINT = "\x1b[48;2;30;30;30m";
const PAD = " \x1b[99X";
const FOOTER = "\x1b[0m  ? for shortcuts";
const GLYPH = "\x1b[1m›\x1b[22m";

/** A Codex screen in the serializer's shape: a reply, then the composer's tinted band and its footer. */
function band(box: string, tint = TINT): string {
  return `• Done.\r\n${tint}${PAD}\r\n${GLYPH} ${box}\x1b[50X\r\n${PAD}\r\n${FOOTER}`;
}

describe("observeInputLine in a band", () => {
  it.each([
    ["a truecolour tint", TINT],
    ["a colon-form tint", "\x1b[48:2::30:30:30m"],
    ["a 256-colour tint", "\x1b[48;5;236m"],
    ["a basic tint", "\x1b[44m"],
  ])("reads the box in %s", (_, tint) => {
    expect(observeInputLine(band("add a test", tint), codex).inputLine).toEqual({
      state: "typed",
      text: "add a test",
    });
    expect(
      observeInputLine(band("\x1b[2mAsk Codex to do anything\x1b[22m", tint), codex).inputLine
    ).toEqual({ state: "empty", text: "" });
  });

  it("reads a band whose blank rows are erases alone", () => {
    const serialized = `• Done.\r\n${TINT}\x1b[100X\r\n${GLYPH} add a test\x1b[50X\r\n\x1b[100X\r\n${FOOTER}`;
    expect(observeInputLine(serialized, codex).inputLine).toEqual({
      state: "typed",
      text: "add a test",
    });
  });

  it("reads dim text that is not a placeholder as Codex's suggestion, and marks it", () => {
    const { inputLine, marked } = observeInputLine(band("\x1b[2mopen the PR\x1b[22m"), codex);
    expect(inputLine).toEqual({ state: "suggestion", text: "open the PR" });
    expect(plain(marked)).toContain("› [suggested by Codex: open the PR]");
  });

  it("keeps blank rows inside the band in the box", () => {
    const serialized = band(`first\x1b[50X\r\n${PAD}\r\n  third`);
    expect(observeInputLine(serialized, codex).inputLine).toEqual({
      state: "typed",
      text: "first\n\nthird",
    });
  });

  it.each([
    [
      "a band that runs off the bottom of the screen",
      `• Done.\r\n${TINT}${PAD}\r\n${GLYPH} add a test\x1b[50X\r\n${PAD}`,
    ],
    [
      "a band whose last row is not blank",
      `• Done.\r\n${TINT}${PAD}\r\n${GLYPH} add a test\x1b[50X\r\n  more\x1b[50X\r\n${FOOTER}`,
    ],
    [
      "a band whose first row is not blank",
      `• Done.\r\n${TINT}  context\x1b[50X\r\n${GLYPH} add a test\x1b[50X\r\n${PAD}\r\n${FOOTER}`,
    ],
    [
      "a band with an unindented row inside it",
      `• Done.\r\n${TINT}${PAD}\r\n${GLYPH} add a test\x1b[50X\r\nmore\r\n${PAD}\r\n${FOOTER}`,
    ],
    ["an echo, its glyph drawn dim", band("add a test").replace(GLYPH, "\x1b[1;2m›\x1b[22;22m")],
    [
      "a prompt row in a highlight of its own",
      band("add a test").replace("\x1b[1m›", "\x1b[48;2;99;168;248m›"),
    ],
    [
      "a prompt row back on the default background",
      band("add a test").replace("\x1b[1m›", "\x1b[49m›"),
    ],
    // Framed like the composer, but in the terminal's own background.
    [
      "a band in the default background",
      `• Done.\r\n \r\n${GLYPH} add a test\r\n \r\n${TINT}  status`,
    ],
    // The serializer writes nothing for a row left in the default background,
    // so the tint the row above carries in is no evidence it is painted.
    [
      "a prompt row under a row with nothing painted on it",
      `${TINT}• Done.\r\n\r\n${GLYPH} add a test\x1b[50X\r\n${PAD}\r\n${FOOTER}`,
    ],
  ])("reads %s as no box at all", (_, serialized) => {
    expect(observeInputLine(serialized, codex).inputLine).toEqual({ state: "unknown", text: "" });
  });

  it.each([
    ["nothing at all", band("")],
    ["only spaces", band("   ")],
    // A cell in another background closes the band at the draft's row, so the
    // blank row above it reads as the band's last.
    [
      "a draft cut off by a cell in another background",
      `• Done.\r\n${TINT}${PAD}\r\n\x1b[1m›\x1b[99X\r\n\x1b[22m${PAD}\r\n  keep my draft\x1b[44m \x1b[49m\r\n${TINT}${PAD}\r\n${FOOTER}`,
    ],
  ])("reads a box showing %s, never its placeholder, as unknown", (_, serialized) => {
    expect(observeInputLine(serialized, codex).inputLine).toEqual({ state: "unknown", text: "" });
  });

  it("never falls back to an older band when the lowest one's frame fails", () => {
    const stale = `${TINT}${PAD}\r\n${GLYPH} \x1b[2mAsk Codex to do anything\x1b[22m\x1b[50X\r\n${PAD}\r\n\x1b[0m• Done.`;
    const live = `${TINT}${PAD}\r\n${GLYPH} add a test\x1b[50X\r\n  more\x1b[50X\r\n${FOOTER}`;
    expect(observeInputLine(`${stale}\r\n${live}`, codex).inputLine.state).toBe("unknown");
    expect(observeInputLine(`${stale}\r\n${FOOTER}`, codex).inputLine.state).toBe("empty");
  });

  it("drops the placeholder for Canopy, and a suggestion wrapped across the band whole", () => {
    const empty = band("\x1b[2mAsk Codex to do anything\x1b[22m");
    expect(plain(dropInputSuggestion(empty, codex))).not.toContain("Ask Codex");
    const wrapped = band(
      `\x1b[2mopen the PR and\x1b[22m\x1b[50X\r\n  \x1b[2mtell me what is left\x1b[22m`
    );
    const dropped = plain(dropInputSuggestion(wrapped, codex));
    expect(dropped).not.toContain("open the PR");
    expect(dropped).not.toContain("tell me what is left");
  });
});

describe("dropInputSuggestion", () => {
  it("takes a ruled box's whole suggestion, painted cursor and all", () => {
    const serialized = screen("❯ \x1b[7mm\x1b[27;2merge #2079 when green\x1b[22m");
    expect(plain(dropInputSuggestion(serialized, claude))).toBe(
      `⏺ Done.\r\n${EDGE}\r\n❯ \r\n${EDGE}\r\n  ? for shortcuts`
    );
  });

  it("falls back to every dim run on the last prompt row without a rule or a box", () => {
    const serialized = "⏺ Done.\r\n> \x1b[2mcommit this\x1b[22m";
    expect(plain(dropInputSuggestion(serialized))).toBe("⏺ Done.\r\n> ");
    // With the rule but no framed box, the generic drop still applies.
    expect(plain(dropInputSuggestion("❯ \x1b[2mcommit this\x1b[22m", claude))).toBe("❯ ");
  });

  it("returns the screen untouched when no row opens with a prompt glyph", () => {
    const serialized = "\x1b[2mjust output\x1b[22m";
    expect(dropInputSuggestion(serialized)).toBe(serialized);
  });
});

describe("captureTerminalTail", () => {
  it("marks only a plain-text read, and reports the box on both", () => {
    const serialized = screen("❯ \x1b[2mopen the PR\x1b[22m");
    const stripped = captureTerminalTail(serialized, 20, true, "claude");
    const raw = captureTerminalTail(serialized, 20, false, "claude");
    expect(stripped.content).toContain("❯ [suggested by Claude Code: open the PR]");
    expect(raw.content).toContain("❯ \x1b[2mopen the PR\x1b[22m");
    expect(stripped.inputLine).toEqual(raw.inputLine);
    expect(stripped.inputLine).toEqual({ state: "suggestion", text: "open the PR" });
  });
});
