import { describe, expect, it } from "vitest";
import {
  PLUGIN_WORKTREE_DELETE_NOTES_MAX,
  PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX,
} from "../../types/plugin.js";
import { validatePluginWorktreeDeleteNotes } from "../pluginWorktreeDeleteNotes.js";

const char = (code: number) => String.fromCodePoint(code);

describe("validatePluginWorktreeDeleteNotes", () => {
  it("accepts notes as fresh plain copies, in order", () => {
    const input = [
      { severity: "warning", text: "  3 unsynced edits on this branch " },
      { severity: "info", text: "Preview deployment still running" },
    ];
    const result = validatePluginWorktreeDeleteNotes(input);
    expect(result).toEqual({
      ok: true,
      notes: [
        { severity: "warning", text: "3 unsynced edits on this branch" },
        { severity: "info", text: "Preview deployment still running" },
      ],
    });
    expect(result.ok && result.notes[0]).not.toBe(input[0]);
  });

  it("accepts an empty answer as nothing to say", () => {
    expect(validatePluginWorktreeDeleteNotes([])).toEqual({ ok: true, notes: [] });
  });

  it("keeps a note on one line and strips characters that hide what it says", () => {
    const text = [
      "Draft",
      char(0x0a),
      "not",
      char(0x09),
      "published",
      char(0x202e),
      char(0x2028),
      "yet",
      char(0x07),
      char(0x200f),
    ].join("");
    expect(validatePluginWorktreeDeleteNotes([{ severity: "info", text }])).toEqual({
      ok: true,
      notes: [{ severity: "info", text: "Draft not published yet" }],
    });
  });

  it("normalizes to NFC before measuring", () => {
    const decomposed = `Cafe${char(0x0301)}`;
    const result = validatePluginWorktreeDeleteNotes([{ severity: "info", text: decomposed }]);
    expect(result.ok && result.notes[0]!.text).toBe(`Caf${char(0xe9)}`);
  });

  it("composes what stripping a control left apart", () => {
    const result = validatePluginWorktreeDeleteNotes([
      { severity: "info", text: `Caf${"e"}${char(0x00)}${char(0x0301)}` },
    ]);
    expect(result.ok && result.notes[0]!.text).toBe(`Caf${char(0xe9)}`);
  });

  it("refuses an enormous text before doing any work on it", () => {
    const huge = " ".repeat(10_000) + "x";
    expect(validatePluginWorktreeDeleteNotes([{ severity: "info", text: huge }])).toEqual({
      ok: false,
      error: `notes[0].text must be at most ${PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX} characters`,
    });
  });

  it("measures length in code points, so an astral character counts once", () => {
    const atLimit = char(0x1f600).repeat(PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX);
    expect(validatePluginWorktreeDeleteNotes([{ severity: "info", text: atLimit }]).ok).toBe(true);
    const over = `${atLimit}x`;
    expect(validatePluginWorktreeDeleteNotes([{ severity: "info", text: over }])).toEqual({
      ok: false,
      error: `notes[0].text must be at most ${PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX} characters`,
    });
  });

  it("refuses the whole answer rather than dropping notes past the limit", () => {
    const notes = Array.from({ length: PLUGIN_WORKTREE_DELETE_NOTES_MAX + 1 }, (_, i) => ({
      severity: "warning",
      text: `note ${i}`,
    }));
    expect(validatePluginWorktreeDeleteNotes(notes)).toEqual({
      ok: false,
      error: `notes must hold at most ${PLUGIN_WORKTREE_DELETE_NOTES_MAX} notes`,
    });
  });

  it.each([
    [null, "notes must be an array"],
    [{ severity: "info", text: "x" }, "notes must be an array"],
    [["x"], "notes[0] must be an object with a severity and a text"],
    [[{ severity: "error", text: "x" }], 'notes[0].severity must be "warning" or "info"'],
    [[{ severity: "info", text: 3 }], "notes[0].text must be a string"],
    [[{ severity: "info", text: `  ${char(0x202e)} ` }], "notes[0].text must not be empty"],
    [
      [{ severity: "info", text: "x", command: "y" }],
      'notes[0] has an unsupported field "command"',
    ],
  ])("refuses %j", (value, error) => {
    expect(validatePluginWorktreeDeleteNotes(value)).toEqual({ ok: false, error });
  });

  it("clips an unsupported field's name in the error it gives back", () => {
    const name = "k".repeat(100_000);
    const result = validatePluginWorktreeDeleteNotes([{ severity: "info", text: "x", [name]: 1 }]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.length).toBeLessThan(200);
  });

  it("never runs a getter on plugin data", () => {
    let reads = 0;
    const note = { severity: "info" } as Record<string, unknown>;
    Object.defineProperty(note, "text", {
      enumerable: true,
      get: () => {
        reads++;
        return "x";
      },
    });
    expect(validatePluginWorktreeDeleteNotes([note])).toEqual({
      ok: false,
      error: "notes[0].text must be a string",
    });
    expect(reads).toBe(0);
  });
});
