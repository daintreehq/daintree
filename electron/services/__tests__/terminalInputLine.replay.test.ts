import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureTerminalTail,
  dropInputSuggestion,
  inputSuggestionRuleFor,
} from "../../../shared/utils/terminalInputLine.js";
import { expandCursorForward, stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import { serializeCastAt, serializeOutput } from "./replay/serializedScreen.js";

/**
 * Real Claude Code screens (#16189). `claude-suggestion.cast` is a capture of
 * 2.1.317 on its native cursor: a settled turn showing the suggestion
 * `open the PR`, the same screen blurred, `add a test` typed over it, and the
 * suggestion drawn again after Ctrl+U. `claude-suggestion-painted-cursor.cast`
 * is the same capture with the suggestion frame as the CLI writes it when it
 * paints its own cursor: the first cell inverse, the rest dim.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures/input-line/", import.meta.url));
const CAPTURE = `${FIXTURES}claude-suggestion.cast`;
const PAINTED = `${FIXTURES}claude-suggestion-painted-cursor.cast`;

const claude = inputSuggestionRuleFor("claude");

// Claude Code writes a no-break space after its prompt glyph; read it as a space.
function spaced(text: string): string {
  return text.replace(/\u00a0/g, " ");
}

function plain(serialized: string): string {
  return spaced(stripAnsiCodes(expandCursorForward(serialized)));
}

function lastLines(text: string, count: number): string[] {
  return text.split("\n").slice(-count);
}

describe("input line on captured Claude Code screens", () => {
  it.each([
    ["focused", CAPTURE, "suggestion"],
    ["blurred", CAPTURE, "suggestion-blurred"],
    ["after Ctrl+U clears a draft", CAPTURE, "cleared"],
    ["with a painted cursor", PAINTED, "suggestion"],
  ])(
    "reads the suggestion %s as the CLI's, and marks it in the plain text",
    async (_, path, at) => {
      const screen = await serializeCastAt(path, at);
      const tail = captureTerminalTail(screen, 20, true, "claude");
      expect(tail.inputLine).toEqual({ state: "suggestion", text: "open the PR" });
      expect(spaced(tail.content)).toContain("\n❯ [suggested by Claude Code: open the PR]\n");
      // The earlier prompts echoed above the box are left as they were drawn.
      expect(spaced(tail.content)).toContain(
        "❯ Without using any tools, reply with one short sentence proposing that I open a PR next."
      );
    }
  );

  it("reads text typed over the suggestion as typed, unmarked", async () => {
    const screen = await serializeCastAt(CAPTURE, "typed");
    const tail = captureTerminalTail(screen, 20, true, "claude");
    expect(tail.inputLine).toEqual({ state: "typed", text: "add a test" });
    expect(spaced(tail.content)).toContain("\n❯ add a test\n");
    expect(tail.content).not.toContain("suggested by");
  });

  it("leaves a raw read byte-faithful while still reporting the box", async () => {
    const screen = await serializeCastAt(CAPTURE, "suggestion");
    const raw = captureTerminalTail(screen, 20, false, "claude");
    expect(raw.inputLine.state).toBe("suggestion");
    expect(raw.content).not.toContain("suggested by");
    expect(raw.content).toContain("\x1b[2mopen the PR");
  });

  it("reports the box even when the tail is cut above it", async () => {
    const screen = await serializeCastAt(CAPTURE, "suggestion");
    const tail = captureTerminalTail(screen, 1, true, "claude");
    expect(tail.inputLine).toEqual({ state: "suggestion", text: "open the PR" });
    expect(tail.content).not.toContain("open the PR");
  });

  it("answers unknown for an agent with no declared rule", async () => {
    const screen = await serializeCastAt(CAPTURE, "suggestion");
    const tail = captureTerminalTail(screen, 20, true, "gemini");
    expect(tail.inputLine).toEqual({ state: "unknown", text: "" });
    expect(spaced(tail.content)).toContain("\n❯ open the PR\n");
  });

  it.each([
    ["native", CAPTURE],
    ["painted", PAINTED],
  ])("drops the whole suggestion for Canopy with the %s cursor", async (_, path) => {
    const screen = await serializeCastAt(path, "suggestion");
    const dropped = plain(dropInputSuggestion(screen, claude));
    expect(lastLines(dropped.trimEnd(), 3)[0]!.trimEnd()).toBe("❯");
    expect(dropped).not.toContain("pen the PR");
  });

  it.each([
    // Claude Code moves the cursor over a gap rather than writing a space, and
    // the serializer keeps it as a bare cursor move outside the dim run.
    ["a one-letter first word", "a", "\x1b[1Ctest", "a test"],
    // The cursor cell holds a whole grapheme, here `e` and a combining acute.
    ["a combining mark", "e\u0301", "cho done", "e\u0301cho done"],
  ])(
    "reads a painted cursor over %s as the suggestion's first cell",
    async (_, cursor, rest, text) => {
      const screen = await serializeOutput(
        `⏺ Done.\r\n────────\r\n❯\u00a0\x1b[7m${cursor}\x1b[27m\x1b[2m${rest}\x1b[22m\r\n────────`
      );
      const tail = captureTerminalTail(screen, 20, true, "claude");
      expect(tail.inputLine).toEqual({ state: "suggestion", text });
      expect(spaced(tail.content)).toContain(`❯ [suggested by Claude Code: ${text}]`);
      expect(plain(dropInputSuggestion(screen, claude))).not.toContain(cursor);
    }
  );

  it.each([
    ["a typed character", "y"],
    ["a typed combining mark", "e\u0301"],
  ])(
    "reads the painted cursor on %s with a dim hint past a written space as typed",
    async (_, typed) => {
      const screen = await serializeOutput(
        `⏺ Done.\r\n────────\r\n❯\u00a0\x1b[7m${typed}\x1b[27m \x1b[2m[n]\x1b[22m\r\n────────`
      );
      expect(captureTerminalTail(screen, 20, true, "claude").inputLine).toEqual({
        state: "typed",
        text: typed,
      });
      expect(plain(dropInputSuggestion(screen, claude))).toContain(`❯ ${typed}`);
    }
  );

  it("keeps the typed draft for Canopy", async () => {
    const screen = await serializeCastAt(CAPTURE, "typed");
    expect(plain(dropInputSuggestion(screen, claude))).toContain("❯ add a test");
  });
});

/**
 * Real Codex screens (#17915), from 0.170.0 launched as a pane launches it
 * (`--no-alt-screen -c tui.whimsy=false`), its colour queries answered as
 * `OscResponder` answers them. `codex-composer.cast` is one pane: the
 * placeholder, a draft typed and cleared, a two-line draft, a pasted block,
 * drafts opening with and holding blank lines, a draft opening `1. `, the
 * slash popup, then a turn with a draft typed while it works. `codex-approval.cast` and
 * `codex-trust.cast` hold lists that replace the composer, and
 * `codex-narrow.cast` a draft wrapping at 40 columns.
 */
const CODEX_COMPOSER = `${FIXTURES}codex-composer.cast`;
const CODEX_APPROVAL = `${FIXTURES}codex-approval.cast`;
const CODEX_TRUST = `${FIXTURES}codex-trust.cast`;
const CODEX_NARROW = `${FIXTURES}codex-narrow.cast`;
const PLACEHOLDER = "Ask Codex to do anything";

const codex = inputSuggestionRuleFor("codex");

describe("input line on captured Codex screens", () => {
  it.each([
    ["the placeholder at launch", CODEX_COMPOSER, "placeholder"],
    ["the placeholder after Ctrl+U clears a draft", CODEX_COMPOSER, "cleared"],
    ["the placeholder after Ctrl+C clears a two-line draft", CODEX_COMPOSER, "cleared-multiline"],
    ["the placeholder after a pasted block is cleared", CODEX_COMPOSER, "cleared-pasted"],
    [
      "the placeholder after a draft opening with blank lines",
      CODEX_COMPOSER,
      "cleared-leading-blank",
    ],
    ["the placeholder after a numbered draft", CODEX_COMPOSER, "cleared-numbered"],
    ["the placeholder once the slash popup closes", CODEX_COMPOSER, "slash-closed"],
    ["the placeholder under a turn that is working", CODEX_COMPOSER, "working"],
    ["the placeholder after a turn", CODEX_COMPOSER, "settled-empty"],
    ["the placeholder at 40 columns", CODEX_NARROW, "placeholder"],
  ])("reads %s as empty, and leaves it unmarked", async (_, path, at) => {
    const screen = await serializeCastAt(path, at);
    const tail = captureTerminalTail(screen, 20, true, "codex");
    expect(tail.inputLine).toEqual({ state: "empty", text: "" });
    expect(tail.content).toContain(`\n› ${PLACEHOLDER}`);
    expect(tail.content).not.toContain("suggested by");
  });

  it.each([
    ["a draft", "typed", "add a test"],
    ["a two-line draft", "multiline", "first line\nsecond line"],
    ["a pasted block", "pasted", "[Pasted Content 1439 chars]"],
    // The prompt row is empty and the draft starts two rows down, inside the band.
    ["a draft opening with blank lines", "leading-blank", "open the PR"],
    ["a draft holding a blank line", "inner-blank", "first\n\nthird"],
    // Shaped like the approval list's selected option, but in the composer's own tint.
    ["a draft opening like a numbered option", "numbered-draft", "1. add a test"],
    ["the slash popup's command", "slash-popup", "/"],
    ["a draft typed while the turn works", "typed-while-working", "queued draft"],
    ["that draft once the turn settles", "settled-with-draft", "queued draft"],
  ])("reads %s as typed", async (_, at, text) => {
    const screen = await serializeCastAt(CODEX_COMPOSER, at);
    const tail = captureTerminalTail(screen, 20, true, "codex");
    expect(tail.inputLine).toEqual({ state: "typed", text });
    expect(tail.content).not.toContain("suggested by");
  });

  it("reads a draft wrapped at 40 columns whole", async () => {
    const screen = await serializeCastAt(CODEX_NARROW, "typed-wrapped");
    expect(captureTerminalTail(screen, 20, true, "codex").inputLine).toEqual({
      state: "typed",
      text: "please add a regression test for the\nempty list case in the parser",
    });
  });

  it.each([
    // The composer is gone: the last `›` rows are the sent message's echo,
    // drawn with a dim glyph, and the overlay's selected option.
    ["a command approval", CODEX_APPROVAL, "approval"],
    ["the folder trust prompt", CODEX_TRUST, "trust"],
  ])("reads %s in place of the composer as unknown", async (_, path, at) => {
    const screen = await serializeCastAt(path, at);
    expect(captureTerminalTail(screen, 20, true, "codex").inputLine).toEqual({
      state: "unknown",
      text: "",
    });
  });

  it("reads dim text in the box that is not the placeholder as Codex's suggestion", async () => {
    // Codex 0.170 draws no suggested prompt; the captured placeholder frame
    // with other dim words in its place stands in for one.
    const captured = await serializeCastAt(CODEX_COMPOSER, "placeholder");
    const screen = captured.replace(PLACEHOLDER, "open the PR for review!!");
    expect(screen).not.toBe(captured);
    const tail = captureTerminalTail(screen, 20, true, "codex");
    expect(tail.inputLine).toEqual({ state: "suggestion", text: "open the PR for review!!" });
    expect(tail.content).toContain("\n› [suggested by Codex: open the PR for review!!]");
  });

  it("reads the placeholder's wording typed at full intensity as typed", async () => {
    const captured = await serializeCastAt(CODEX_COMPOSER, "placeholder");
    const screen = captured.replace(`\x1b[2m${PLACEHOLDER}`, PLACEHOLDER);
    expect(screen).not.toBe(captured);
    expect(captureTerminalTail(screen, 20, true, "codex").inputLine).toEqual({
      state: "typed",
      text: PLACEHOLDER,
    });
  });

  it("finds no box when the composer is drawn without a tint of its own", async () => {
    const captured = await serializeCastAt(CODEX_COMPOSER, "placeholder");
    const screen = captured.replace(/\x1b\[48;2;\d+;\d+;\d+m/g, "");
    expect(screen).not.toBe(captured);
    expect(captureTerminalTail(screen, 20, true, "codex").inputLine.state).toBe("unknown");
  });

  it("drops the placeholder for Canopy and keeps a draft", async () => {
    const empty = plain(
      dropInputSuggestion(await serializeCastAt(CODEX_COMPOSER, "placeholder"), codex)
    );
    expect(empty).not.toContain(PLACEHOLDER);
    expect(empty).toMatch(/\n› *\r?\n/);
    const typed = plain(dropInputSuggestion(await serializeCastAt(CODEX_COMPOSER, "typed"), codex));
    expect(typed).toContain("› add a test");
  });
});
