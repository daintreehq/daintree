import { describe, expect, it } from "vitest";
import { isCautionPreviewLine, stripCautionPrefix } from "../mcpPreviewLines.js";
import { formatWorktreeDeleteNoteLines } from "../worktreeDeletePreview.js";

describe("formatWorktreeDeleteNoteLines", () => {
  it("names each note's plugin, flags warnings, and says who didn't answer", () => {
    const lines = formatWorktreeDeleteNoteLines([
      {
        pluginId: "acme.sync",
        pluginName: "Acme Sync",
        answer: {
          status: "answered",
          notes: [
            { severity: "warning", text: "3 unsynced edits on this branch" },
            { severity: "info", text: "Last synced an hour ago" },
          ],
        },
      },
      { pluginId: "acme.deploy", pluginName: "Acme Deploy", answer: { status: "no-answer" } },
    ]);
    expect(lines.map(stripCautionPrefix)).toEqual([
      "Acme Sync: 3 unsynced edits on this branch",
      "Acme Sync: Last synced an hour ago",
      "Acme Deploy didn't answer.",
    ]);
    expect(lines.map(isCautionPreviewLine)).toEqual([true, false, false]);
  });

  it("adds nothing for a plugin with nothing to say", () => {
    expect(
      formatWorktreeDeleteNoteLines([
        { pluginId: "a", pluginName: "A", answer: { status: "answered", notes: [] } },
      ])
    ).toEqual([]);
  });
});
