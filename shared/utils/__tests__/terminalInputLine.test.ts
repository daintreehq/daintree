import { describe, expect, it } from "vitest";
import {
  captureTerminalTail,
  dropInputSuggestion,
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
    // The serializer opens a dim run on one row and lets it run on.
    const serialized = `⏺ Done.\r\n${EDGE}\r\n❯ \x1b[2mopen the PR\r\n${EDGE}\r\n\x1b[0m  ? for shortcuts`;
    expect(observeInputLine(serialized, claude).inputLine.state).toBe("suggestion");
    const resetAbove = `\x1b[2m⏺ Done.\x1b[22m\r\n${EDGE}\r\n❯ open the PR\r\n${EDGE}`;
    expect(observeInputLine(resetAbove, claude).inputLine.state).toBe("typed");
  });

  it("takes a sent message's echo for nothing: only the framed row is the box", () => {
    // A permission dialog has replaced the box; the last `❯` rows are an echo
    // and the dialog's own pointer.
    const serialized =
      "❯ \x1b[2mfix the rounding\x1b[22m\r\n⏺ Bash command\r\n  Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No";
    expect(observeInputLine(serialized, claude)).toEqual({
      inputLine: { state: "unknown", text: "" },
      marked: serialized,
    });
  });

  it("vouches only for the prompt row when no bottom edge is in view", () => {
    const serialized = `⏺ Done.\r\n${EDGE}\r\n❯ \x1b[2mopen the PR\x1b[22m\r\n  more`;
    expect(observeInputLine(serialized, claude).inputLine).toEqual({
      state: "suggestion",
      text: "open the PR",
    });
  });

  it("brackets a suggestion that wraps across box rows as one", () => {
    const box = "❯ \x1b[2mopen the PR and tell me\x1b[22m\r\n  \x1b[2mwhat is left\x1b[22m";
    const { inputLine, marked } = observeInputLine(screen(box), claude);
    expect(inputLine).toEqual({
      state: "suggestion",
      text: "open the PR and tell me\nwhat is left",
    });
    expect(plain(marked)).toContain(
      "❯ [suggested by Claude Code: open the PR and tell me\r\n  what is left]\r\n"
    );
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
    expect(inputSuggestionRuleFor("codex")).toBeUndefined();
    expect(inputSuggestionRuleFor(null)).toBeUndefined();
    expect(inputSuggestionRuleFor("toString")).toBeUndefined();
    const serialized = screen("❯ \x1b[2mopen the PR\x1b[22m");
    expect(observeInputLine(serialized, undefined)).toEqual({
      inputLine: { state: "unknown", text: "" },
      marked: serialized,
    });
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
