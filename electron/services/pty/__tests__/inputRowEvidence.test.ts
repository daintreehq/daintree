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
      "Claude Code's input row holding a suggestion, under its status line",
      "claude",
      [RULE, "❯ run the tests", RULE, "  ~/project · main · opus"],
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
      "empty",
    ],
    [
      "OpenCode's input row opening on its own hint",
      "opencode",
      ['┃  Ask anything... "Fix a TODO in the codebase"', "┃", "  enter send"],
      "empty",
    ],
    [
      "Kimi Code's boxed input row, matched with its edge",
      "kimi",
      ["", "│ >                                        │"],
      "empty",
    ],
    ["Cursor Agent's bare arrow", "cursor", ["  Cursor Agent", "", "→ "], "empty"],
    [
      "Cursor Agent's follow-up placeholder as the last row",
      "cursor",
      ["Welcome to Cursor Agent", "→ Add a follow-up", ""],
      "empty",
    ],
    [
      "Open Interpreter's inherited placeholder",
      "interpreter",
      ["", "› Ask Codex to do anything", "", "  ? for shortcuts"],
      "empty",
    ],
    [
      "Codex's placeholder drawn in colour",
      "codex",
      ["", "\x1b[2m› Ask Codex to do anything\x1b[0m", "", "  ⏎ send"],
      "empty",
    ],
    [
      "Codex's draft under its footer hint",
      "codex",
      ["› fix the tests", "", "  100% context left"],
      "drawn",
    ],
    [
      "a draft running on under an empty first line",
      "codex",
      ["", "›", "  keep this draft", "", "  100% context left"],
      "drawn",
    ],
    ["an agent with no declared prompt, at a bare glyph", "grok", ["READY", "❯"], "empty"],
    ["an agent with no declared prompt, its glyph alone", "grok", ["❯"], "empty"],
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
    [
      "a frame the last agent left, with the line that started this run under it",
      "claude",
      [RULE, "❯ ", RULE, "❯ claude", ""],
    ],
    [
      "a wrapped shell line carrying the agent's own hint",
      "codex",
      ['❯ codex "explain context left', 'in the status bar"', ""],
    ],
    ["a blank screen, for an agent with no declared prompt", "grok", ["", ""]],
    ["its shell line under a plain prompt", "grok", ["~/repo $ grok", ""]],
    ["its shell line under a glyph", "grok", ["$ grok", ""]],
    ["its startup text", "grok", ["Starting up…"]],
  ])("finds no input row on %s", (_label, agentId, screen) => {
    expect(read(agentId, screen)).toBeNull();
  });

  it("reads its own hints only, never the universal approval hints beside them", () => {
    expect(read("codex", ["❯ codex", "  Allow once", ""])).toBeNull();
  });
});
