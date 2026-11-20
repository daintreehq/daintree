import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { showsSelectorAtEnter } from "../guardedEnterScreen.js";
import { endsOnChoiceSelector } from "../WaitingReasonClassifier.js";
import {
  inputSuggestionRuleFor,
  readInputBoxScreen,
} from "../../../../shared/utils/terminalInputLine.js";
import { serializeCastAt, serializeOutput } from "../../__tests__/replay/serializedScreen.js";

const FIXTURES = fileURLToPath(new URL("../../__tests__/fixtures/input-line/", import.meta.url));
/** Claude Code 2.1.329: `/restart` over its slash-command list, then `/effort ` beside its argument hint. */
const CLAUDE_SLASH = `${FIXTURES}claude-slash-command.cast`;
const CODEX_APPROVAL = `${FIXTURES}codex-approval.cast`;
const CODEX_COMPOSER = `${FIXTURES}codex-composer.cast`;

const RULE = "─".repeat(60);

/** `rows` drawn top to bottom and serialized as the pty-host serializes a mirror. */
function frame(rows: readonly string[]): Promise<string> {
  return serializeOutput(rows.join("\r\n"), 80, 24);
}

/** Whether the whole screen, down to its last row drawn, ends on a selector. */
function wholeScreenSelector(serialized: string, agentId: string): boolean {
  const { rows } = readInputBoxScreen(serialized, inputSuggestionRuleFor(agentId));
  while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
  return endsOnChoiceSelector(rows, undefined, agentId);
}

describe("showsSelectorAtEnter (#17984)", () => {
  it("sees a permission dialog drawn in the composer's place", async () => {
    const screen = await frame([
      "⏺ Bash(rm -rf build)",
      "",
      RULE,
      " Bash command",
      "",
      "   rm -rf build",
      "   Remove the build output",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for rm commands in /repo",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
      " Esc to cancel · Tab to amend",
    ]);
    expect(readInputBoxScreen(screen, inputSuggestionRuleFor("claude")).belowBox).toBeNull();
    expect(showsSelectorAtEnter(screen, "claude")).toBe(true);
  });

  it("sees a dialog drawn high on a screen left blank below it", async () => {
    const dialog = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"];
    // A row painted in a background of its own at the foot of the screen, as
    // a tinted TUI paints them, keeps the empty rows between in the read.
    const footer = "\x1b[24;1H\x1b[48;5;236m\x1b[K\x1b[0m";
    const screen = await serializeOutput(dialog.join("\r\n") + footer, 80, 24);
    expect(readInputBoxScreen(screen, inputSuggestionRuleFor("claude")).rows.length).toBe(24);
    expect(showsSelectorAtEnter(screen, "claude")).toBe(true);
  });

  it.each([
    ["a numbered selector", [" ❯ 1. Allow", "   2. Deny"]],
    [
      "an unnumbered selector under Claude's own footer",
      [" ❯ Keep auto (1m tokens)", "   Switch to Sonnet", " ↑/↓ to navigate · enter to confirm"],
    ],
  ])("sees %s drawn right under a composer still holding the line", async (_, selector) => {
    const screen = await frame(["⏺ Done.", RULE, "❯ wake up", RULE, ...selector]);
    expect(readInputBoxScreen(screen, inputSuggestionRuleFor("claude")).belowBox).not.toBeNull();
    // Read as one block with the box's rule, the screen looks like a composer.
    expect(wholeScreenSelector(screen, "claude")).toBe(false);
    expect(showsSelectorAtEnter(screen, "claude")).toBe(true);
  });

  it("passes a captured line over Claude Code's slash-command list", async () => {
    const screen = await serializeCastAt(CLAUDE_SLASH, "slash-list");
    const { rows, belowBox } = readInputBoxScreen(screen, inputSuggestionRuleFor("claude"));
    // The list sits under the box, its selected row marked with the prompt glyph.
    expect(belowBox).not.toBeNull();
    expect(rows.slice(belowBox!).some((row) => /^\s*❯ \/restart\b/.test(row))).toBe(true);
    expect(showsSelectorAtEnter(screen, "claude")).toBe(false);
  });

  it("passes a captured line beside its argument hint", async () => {
    const screen = await serializeCastAt(CLAUDE_SLASH, "argument-hint");
    const { rows } = readInputBoxScreen(screen, inputSuggestionRuleFor("claude"));
    expect(rows.some((row) => /^❯\s\/effort\s+\[low\|medium\|/.test(row))).toBe(true);
    expect(showsSelectorAtEnter(screen, "claude")).toBe(false);
  });

  it.each([
    ["a numbered list", ["❯ 1. Yes, ship it", "  2. Then tag the release"]],
    ["an approval phrase", ["❯ Do you want to proceed? Say yes if so."]],
  ])("passes the line's own text when it holds %s", async (_, box) => {
    const screen = await frame(["⏺ Done.", RULE, ...box, RULE, "  ? for shortcuts"]);
    expect(showsSelectorAtEnter(screen, "claude")).toBe(false);
  });

  it("passes a layout the box rule can't read, such as the older boxed composer", async () => {
    const screen = await frame([
      "⏺ Done.",
      "╭" + "─".repeat(40) + "╮",
      "│ > /restart" + " ".repeat(29) + "│",
      "╰" + "─".repeat(40) + "╯",
      "  ? for shortcuts",
    ]);
    expect(readInputBoxScreen(screen, inputSuggestionRuleFor("claude")).belowBox).toBeNull();
    expect(showsSelectorAtEnter(screen, "claude")).toBe(false);
  });

  it("passes a numbered list typed into Codex's tinted composer", async () => {
    const captured = await serializeCastAt(CODEX_COMPOSER, "multiline");
    // The second row is serialized with a cursor move between its words.
    const screen = captured.replace("first line", "1. add tests").replace("second", "2. run the");
    expect(screen).not.toBe(captured);
    // With the tint gone, the draft's rows are a numbered list under a highlight.
    expect(wholeScreenSelector(screen, "codex")).toBe(true);
    expect(showsSelectorAtEnter(screen, "codex")).toBe(false);
  });

  it("sees Codex's captured approval and passes its captured draft", async () => {
    expect(showsSelectorAtEnter(await serializeCastAt(CODEX_APPROVAL, "approval"), "codex")).toBe(
      true
    );
    expect(
      showsSelectorAtEnter(await serializeCastAt(CODEX_COMPOSER, "numbered-draft"), "codex")
    ).toBe(false);
  });
});
