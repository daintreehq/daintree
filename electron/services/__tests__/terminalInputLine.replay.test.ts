import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureTerminalTail,
  dropInputSuggestion,
  inputSuggestionRuleFor,
} from "../../../shared/utils/terminalInputLine.js";
import { expandCursorForward, stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import { serializeCastAt } from "./replay/serializedScreen.js";

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
    const tail = captureTerminalTail(screen, 20, true, "codex");
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

  it("keeps the typed draft for Canopy", async () => {
    const screen = await serializeCastAt(CAPTURE, "typed");
    expect(plain(dropInputSuggestion(screen, claude))).toContain("❯ add a test");
  });
});
