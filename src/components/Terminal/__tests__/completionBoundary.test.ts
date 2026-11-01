import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import {
  completionBoundary,
  completionBoundaryAt,
  completionBoundaryField,
} from "../inputEditorExtensions/completionBoundary";

function editor(doc: string, caret = 0) {
  let state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [history(), completionBoundary],
  });
  const apply = (spec: TransactionSpec) => {
    state = state.update(spec).state;
  };
  const type = (text: string) => {
    for (const char of text) {
      const at = state.selection.main.head;
      apply({
        changes: { from: at, insert: char },
        selection: { anchor: at + 1 },
        userEvent: "input.type",
      });
    }
  };
  const run = (command: typeof undo) =>
    command({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
  return {
    apply,
    type,
    run,
    get state() {
      return state;
    },
    boundaries: () => state.field(completionBoundaryField),
    doc: () => state.doc.toString(),
  };
}

describe("completionBoundary", () => {
  it("marks where text typed in front of a word meets it, and keeps it there as typing goes on", () => {
    const ed = editor("I found an issue");
    ed.type("/");
    expect(ed.boundaries()).toEqual([1]);
    ed.type("gith");
    expect(ed.doc()).toBe("/githI found an issue");
    expect(ed.boundaries()).toEqual([5]);
    expect(completionBoundaryAt(ed.state, 5)).toBe(5);
    expect(completionBoundaryAt(ed.state, 2)).toBe(5);
    expect(completionBoundaryAt(ed.state, 6)).toBeUndefined();
  });

  it("marks a paste in front of a word", () => {
    const ed = editor("see that", "see ".length);
    ed.apply({ changes: { from: 4, insert: "@src" }, userEvent: "input.paste" });
    expect(ed.boundaries()).toEqual([8]);
  });

  it("marks nothing for typing inside a word or where no word follows", () => {
    const inside = editor("/help /compact", "/help /com".length);
    inside.type("x");
    expect(inside.boundaries()).toEqual([]);

    const atEnd = editor("see ", 4);
    atEnd.type("#148");
    expect(atEnd.boundaries()).toEqual([]);

    const beforeSpace = editor("see  now", 4);
    beforeSpace.type("#148");
    expect(beforeSpace.boundaries()).toEqual([]);
  });

  it("marks nothing for a write that isn't the user's", () => {
    const ed = editor("I found");
    ed.apply({ changes: { from: 0, insert: "/gith" } });
    expect(ed.boundaries()).toEqual([]);
  });

  it("drops the mark once a space separates the two", () => {
    const ed = editor("I found");
    ed.type("/gith ");
    expect(ed.doc()).toBe("/gith I found");
    expect(ed.boundaries()).toEqual([]);
  });

  it("drops the mark when either side is deleted", () => {
    const back = editor("I found");
    back.type("/g");
    back.apply({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });
    expect(back.doc()).toBe("I found");
    expect(back.boundaries()).toEqual([]);

    const forward = editor("I found");
    forward.type("/g");
    forward.apply({ changes: { from: 2, to: 3 }, userEvent: "delete.forward" });
    expect(forward.doc()).toBe("/g found");
    expect(forward.boundaries()).toEqual([]);
  });

  it("follows an exact edit elsewhere and drops on a whole-draft replacement", () => {
    const ed = editor("x I found");
    ed.apply({ selection: { anchor: 2 } });
    ed.type("/g");
    expect(ed.boundaries()).toEqual([4]);
    ed.apply({ changes: { from: 0, insert: "so " } });
    expect(ed.boundaries()).toEqual([7]);
    ed.apply({ changes: { from: 0, to: ed.state.doc.length, insert: ed.doc() } });
    expect(ed.boundaries()).toEqual([]);
  });

  it("comes back when a completion that dropped it is undone, and goes again on redo", () => {
    const ed = editor("I found");
    ed.type("/gith");
    // Its own undo step, as a pick made after a pause is.
    ed.apply({
      changes: { from: 0, to: 5, insert: "/github-create-issue " },
      annotations: isolateHistory.of("full"),
    });
    expect(ed.doc()).toBe("/github-create-issue I found");
    expect(ed.boundaries()).toEqual([]);

    ed.run(undo);
    expect(ed.doc()).toBe("/githI found");
    expect(ed.boundaries()).toEqual([5]);

    ed.run(redo);
    expect(ed.doc()).toBe("/github-create-issue I found");
    expect(ed.boundaries()).toEqual([]);
  });
});
