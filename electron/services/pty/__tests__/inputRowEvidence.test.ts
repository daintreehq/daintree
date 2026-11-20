import { describe, expect, it } from "vitest";
import { inputRowShapeFor, readInputRow } from "../inputRowEvidence.js";

const RULE = "─".repeat(60);

function read(agentId: string | undefined, screen: string[]) {
  return readInputRow(screen, inputRowShapeFor(agentId));
}

describe("readInputRow (#18018)", () => {
  it.each<[string, string, string[], "empty" | "drawn"]>([
    [
      "Claude Code's empty input row in its rules",
      "claude",
      ["● Done.", "", RULE, "❯ ", RULE, "  ? for shortcuts"],
      "empty",
    ],
    [
      "Claude Code's placeholder",
      "claude",
      [
        "╭────╮",
        "│ ✻ Welcome │",
        "╰────╯",
        "",
        RULE,
        '❯ Try "fix lint errors"',
        RULE,
        "  ? for shortcuts",
      ],
      "empty",
    ],
    [
      "Claude Code's input row drawn high on a fresh pane",
      "claude",
      [RULE, "❯ ", RULE, "  ? for shortcuts", "", "", "", ""],
      "empty",
    ],
    [
      "Claude Code's input row holding a suggestion, under a status line that opens with a glyph",
      "claude",
      [RULE, "❯ run the tests", RULE, "❯ ~/project main"],
      "drawn",
    ],
    [
      "Codex's placeholder in its band",
      "codex",
      ["", "› Ask Codex to do anything", "", "  ⏎ send   ⌃J newline"],
      "empty",
    ],
    [
      "Gemini's boxed input row and its hint",
      "gemini",
      [
        "╭──────────────────────────────────────────╮",
        "│ >   Type your message or @path/to/file   │",
        "╰──────────────────────────────────────────╯",
      ],
      "drawn",
    ],
    [
      "OpenCode's input row and its hint",
      "opencode",
      ['┃  Ask anything... "Fix a TODO in the codebase"', "┃", "  enter send"],
      "drawn",
    ],
    [
      "Kimi Code's boxed input row, matched with its edge",
      "kimi",
      ["", "│ >                                        │"],
      "empty",
    ],
    ["Cursor Agent's bare arrow", "cursor", ["  Cursor Agent", "", "→ "], "empty"],
    ["an agent with no declared prompt, drawing anything", "grok", ["READY", "❯"], "drawn"],
  ])("reads %s", (_label, agentId, screen, expected) => {
    expect(read(agentId, screen)).toBe(expected);
  });

  it.each<[string, string, string[]]>([
    ["a blank screen", "claude", ["", "", ""]],
    [
      "the shell line that started the run, under a prompt glyph",
      "claude",
      ["❯ claude --resume 0b1c", ""],
    ],
    ["the shell line under a plain shell prompt", "claude", ["~/project $ claude", ""]],
    [
      "the shell line under a bare shell prompt left in the history above it",
      "claude",
      ["❯ ", "❯ ls", "src  package.json", "❯ claude", ""],
    ],
    [
      "a shell line carrying the agent's own hint, with nothing drawn under it",
      "codex",
      ['❯ codex "show context left"', ""],
    ],
    [
      "a startup selector the classifier took for a prompt",
      "claude",
      [
        " Quick safety check: Is this a project you created or one you trust?",
        "",
        " ❯ 1. Yes, I trust this folder",
        "   2. No, exit",
        "",
        " Enter to confirm · Esc to exit",
      ],
    ],
    ["a blank screen, for an agent with no declared prompt", "grok", ["", ""]],
  ])("finds no input row on %s", (_label, agentId, screen) => {
    expect(read(agentId, screen)).toBeNull();
  });

  it("reads its own hints only, never the universal approval hints beside them", () => {
    expect(read("codex", ["❯ codex", "  Allow once", ""])).toBeNull();
  });
});
