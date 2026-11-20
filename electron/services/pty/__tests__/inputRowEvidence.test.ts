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
      "Claude Code's empty input row under a status line that opens with a glyph",
      "claude",
      [RULE, "❯ ", RULE, "❯ ~/project main"],
      "empty",
    ],
    [
      "Claude Code's empty input row under a status line ending on a path to claude",
      "claude",
      [RULE, "❯ ", RULE, "  Sonnet · 0% context · ~/src/claude"],
      "empty",
    ],
    [
      "Antigravity's framed input row over a footer its prompt patterns match",
      "antigravity",
      [RULE, ">", RULE, "? for shortcuts                       Gemini 3.7 Flash · high"],
      "empty",
    ],
    [
      "Codex's placeholder over a footer naming a directory with a # in it",
      "codex",
      ["", "› Ask Codex to do anything", "", "  ~/Projects/Research # Notes · main"],
      "empty",
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
      "OpenCode's boxed input row and its hint",
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
    ["an agent with no declared prompt, at a prompt it can't read", "grok", ["  λ "], "drawn"],
    ["an agent with no declared prompt, drawing its own text", "grok", ["Starting up…"], "drawn"],
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
    [
      "a frame the last agent left, with this run's shell line under a plain prompt",
      "cursor",
      [RULE, "❯ ", RULE, "  ? for shortcuts", "~/repo $ cursor-agent", ""],
    ],
    [
      "a shell line whose wrapped command runs on into the agent's own hint",
      "codex",
      ['❯ codex "explain the', 'context left thing"', ""],
    ],
    ["a bare glyph in the history above a shell line", "claude", ["❯", "~/repo $ claude", ""]],
    [
      "a frame the last agent left, with this run's Bash launch line under it",
      "codex",
      [RULE, "❯ ", RULE, "  ? for shortcuts", "user@host:~/repo$ codex", ""],
    ],
    [
      "a frame the last run left, under a launch of a quoted path with a space in it",
      "claude",
      [RULE, "❯ ", RULE, "~/repo $ '/opt/Claude Tools/bin/claude'", ""],
    ],
    [
      "a frame the last run left, under a launch with an escaped space",
      "claude",
      [RULE, "❯ ", RULE, "~/repo $ /opt/Claude\\ Tools/bin/claude --resume 0b1c", ""],
    ],
    [
      "a frame the last run left, under a PowerShell launch",
      "claude",
      [
        RULE,
        "❯ ",
        RULE,
        "PS C:\\repo> & 'C:\\Program Files\\claude\\claude.exe' --resume 0b1c",
        "",
      ],
    ],
  ])("finds no input row on %s", (_label, agentId, screen) => {
    expect(read(agentId, screen)).toBeNull();
  });

  it.each<[string, string, string[]]>([
    ["a Goose draft, whose prompt is its own hint", "goose", ["🪿 fix the tests", ""]],
    [
      "a Codex draft opening with its own hint",
      "codex",
      ["› context left is wrong", "", "  ⏎ send"],
    ],
    ["a Gemini draft", "gemini", ["╭────╮", "│ > type your message here please │", "╰────╯"]],
    [
      "a Codex draft whose second line is a rule",
      "codex",
      ["›", "  ──────", "", "  ? for shortcuts"],
    ],
  ])("never reads %s as an empty input row", (_label, agentId, screen) => {
    expect(read(agentId, screen)).not.toBe("empty");
  });

  it("reads its own hints only, never the universal approval hints beside them", () => {
    expect(read("codex", ["❯ codex", "  Allow once", ""])).toBeNull();
  });
});
