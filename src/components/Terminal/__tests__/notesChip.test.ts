// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, closeHoverTooltips } from "@codemirror/view";
import type { DiffNote, PendingDiffNotes } from "@/components/Worktree/diffNotes";
import {
  applyDiffNotesChipSource,
  currentDiffNotesChipEffects,
  notesChipField,
} from "../inputEditorExtensions/notesChip";

const note = (id: string, filePath: string): DiffNote => ({
  id,
  worktreePath: "/repo",
  filePath,
  anchor: { kind: "file" },
  body: id,
  createdAt: 1,
  updatedAt: 1,
});

const source = (sendable: DiffNote[], editing: DiffNote[] = []): PendingDiffNotes => ({
  sendable,
  editing,
});

function mount(doc: string, selection = doc.length): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: [notesChipField],
    }),
    parent: document.body,
  });
  onTestFinished(() => view.destroy());
  return view;
}

const chips = (view: EditorView) =>
  [...view.dom.querySelectorAll(".cm-notes-chip")].map((chip) => ({
    label: chip.querySelector("[aria-hidden]:not(:has(svg))")?.textContent,
    description: chip.getAttribute("aria-description"),
  }));

describe("notesChipField", () => {
  it("draws nothing until a composer that takes notes says what is pending", () => {
    const view = mount("Fix @notes now");
    expect(chips(view)).toEqual([]);

    applyDiffNotesChipSource(view, null);
    expect(chips(view)).toEqual([]);
  });

  it("says how many notes it will send and that sending clears them", () => {
    const view = mount("Fix @notes now");
    applyDiffNotesChipSource(view, source([note("a", "src/a.ts"), note("b", "src/b.ts")]));
    expect(chips(view)).toEqual([
      {
        label: "2 notes · clears on send",
        description: "Sends 2 pending notes. Sending clears them",
      },
    ]);
  });

  it("counts one file's notes for the per-file form, naming the file", () => {
    const view = mount("See @notes:src/a.ts now");
    applyDiffNotesChipSource(view, source([note("a", "src/a.ts"), note("b", "src/b.ts")]));
    expect(chips(view)).toEqual([
      {
        label: "a.ts · 1 note · clears on send",
        description: "Sends 1 pending note. Sending clears it",
      },
    ]);
  });

  it("keeps its count current as notes come and go, without an edit", () => {
    const view = mount("Fix @notes now");
    applyDiffNotesChipSource(view, source([note("a", "src/a.ts")]));
    expect(chips(view)[0]!.label).toBe("1 note · clears on send");

    applyDiffNotesChipSource(view, source([]));
    expect(chips(view)[0]!.label).toBe("No notes");
  });

  it("closes an open card when the notes change, only for a draft that names them", () => {
    const named = mount("Fix @notes now");
    applyDiffNotesChipSource(named, source([]));
    const namedDispatch = vi.spyOn(named, "dispatch");
    applyDiffNotesChipSource(named, source([note("a", "a.ts")]));
    expect(namedDispatch.mock.calls[0]![0]).toMatchObject({
      effects: expect.arrayContaining([closeHoverTooltips]),
    });

    const unnamed = mount("Just a prompt @src/a.ts");
    applyDiffNotesChipSource(unnamed, source([]));
    const unnamedDispatch = vi.spyOn(unnamed, "dispatch");
    applyDiffNotesChipSource(unnamed, source([note("a", "a.ts")]));
    expect(unnamedDispatch.mock.calls[0]![0]).not.toMatchObject({
      effects: expect.arrayContaining([closeHoverTooltips]),
    });
  });

  it("leaves out notes in an open editor, and says they stay pending", () => {
    const view = mount("Fix @notes now");
    applyDiffNotesChipSource(view, source([note("a", "a.ts")], [note("b", "b.ts")]));
    expect(chips(view)).toEqual([
      {
        label: "1 note · clears on send",
        description: "Sends 1 pending note. Sending clears it; 1 note being edited stays pending",
      },
    ]);

    applyDiffNotesChipSource(view, source([], [note("b", "b.ts")]));
    expect(chips(view)).toEqual([
      { label: "Being edited", description: "1 note being edited stays pending" },
    ]);
  });

  it("counts a note once across tokens, as the send does", () => {
    const view = mount("@notes then @notes:a.ts ");
    applyDiffNotesChipSource(view, source([note("a", "a.ts")]));
    expect(chips(view).map((chip) => chip.label)).toEqual([
      "1 note · clears on send",
      "a.ts · Included above",
    ]);
  });

  it("leaves a per-file token as text while it's still being typed", () => {
    const text = "See @notes:sr";
    const view = mount(text);
    applyDiffNotesChipSource(view, source([note("a", "src/a.ts")]));
    expect(chips(view)).toEqual([]);

    view.dispatch({ selection: { anchor: 0 } });
    expect(chips(view)[0]!.label).toBe("sr · No notes");
  });

  it("brings a restored state's chips back to the current notes", () => {
    const view = mount("Fix @notes now");
    expect(currentDiffNotesChipEffects(view)).toEqual([]);
    applyDiffNotesChipSource(view, source([note("a", "a.ts")]));
    const stashed = view.state;
    applyDiffNotesChipSource(view, source([note("a", "a.ts"), note("b", "b.ts")]));

    view.setState(stashed);
    expect(chips(view)[0]!.label).toBe("1 note · clears on send");
    view.dispatch({ effects: currentDiffNotesChipEffects(view) });
    expect(chips(view)[0]!.label).toBe("2 notes · clears on send");
  });
});
