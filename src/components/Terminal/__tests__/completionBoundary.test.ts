import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import {
  completionBoundary,
  completionBoundaryAt,
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
    joins: () => state.field(completionBoundary).map((token) => token.to),
    doc: () => state.doc.toString(),
  };
}

describe("completionBoundary", () => {
  it("marks where a token typed in front of a word meets it, and keeps it there as typing goes on", () => {
    const ed = editor("I found an issue");
    ed.type("/");
    expect(ed.joins()).toEqual([1]);
    ed.type("gith");
    expect(ed.doc()).toBe("/githI found an issue");
    expect(ed.state.field(completionBoundary)).toEqual([{ from: 0, to: 5 }]);
    expect(completionBoundaryAt(ed.state, 5)).toBe(5);
    expect(completionBoundaryAt(ed.state, 2)).toBe(5);
    expect(completionBoundaryAt(ed.state, 6)).toBeUndefined();
  });

  it.each(["@", "#", "$"])("marks a %s token too", (trigger) => {
    const ed = editor("see that", "see ".length);
    ed.type(`${trigger}x`);
    expect(ed.joins()).toEqual([6]);
  });

  it("marks a pasted token in front of a word", () => {
    const ed = editor("see that", "see ".length);
    ed.apply({ changes: { from: 4, insert: "@src" }, userEvent: "input.paste" });
    expect(ed.joins()).toEqual([8]);
  });

  it("marks nothing for plain words, typing inside a token, or where no word follows", () => {
    const plain = editor("happy");
    plain.type("un");
    expect(plain.joins()).toEqual([]);

    const inside = editor("/help /compact", "/help /com".length);
    inside.type("x");
    expect(inside.joins()).toEqual([]);

    const atEnd = editor("see ", 4);
    atEnd.type("#148");
    expect(atEnd.joins()).toEqual([]);

    const beforeSpace = editor("see  now", 4);
    beforeSpace.type("#148");
    expect(beforeSpace.joins()).toEqual([]);
  });

  it("marks nothing for a write that isn't the user's", () => {
    const ed = editor("I found");
    ed.apply({ changes: { from: 0, insert: "/gith" } });
    expect(ed.joins()).toEqual([]);
  });

  it("drops the mark once a space separates the two or splits the token", () => {
    const after = editor("I found");
    after.type("/gith ");
    expect(after.doc()).toBe("/gith I found");
    expect(after.joins()).toEqual([]);

    const inside = editor("I found");
    inside.type("/gi");
    inside.apply({ changes: { from: 2, insert: " " }, userEvent: "input.type" });
    expect(inside.doc()).toBe("/g iI found");
    expect(inside.joins()).toEqual([]);
  });

  it("drops the mark when either side is deleted", () => {
    const back = editor("I found");
    back.type("/g");
    back.apply({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });
    expect(back.doc()).toBe("I found");
    expect(back.joins()).toEqual([]);

    const forward = editor("I found");
    forward.type("/g");
    forward.apply({ changes: { from: 2, to: 3 }, userEvent: "delete.forward" });
    expect(forward.doc()).toBe("/g found");
    expect(forward.joins()).toEqual([]);
  });

  it("drops the mark when a deleted space merges the token into the word before it", () => {
    const ed = editor("@src/ App.tsx", "@src/ ".length);
    ed.type("@New");
    expect(ed.joins()).toEqual([10]);
    ed.apply({ changes: { from: 5, to: 6 }, userEvent: "delete.backward" });
    expect(ed.doc()).toBe("@src/@NewApp.tsx");
    expect(ed.joins()).toEqual([]);
    expect(completionBoundaryAt(ed.state, "@src/@New".length)).toBeUndefined();
  });

  it("follows an exact edit elsewhere and drops on a whole-draft replacement", () => {
    const ed = editor("x I found", 2);
    ed.type("/g");
    expect(ed.joins()).toEqual([4]);
    ed.apply({ changes: { from: 0, insert: "so " } });
    expect(ed.joins()).toEqual([7]);
    ed.apply({ changes: { from: 0, to: ed.state.doc.length, insert: ed.doc() } });
    expect(ed.joins()).toEqual([]);
  });

  it("comes back when a completion is undone, and goes again on redo", () => {
    const ed = editor("I found");
    ed.type("/gith");
    // Its own undo step, as a pick made after a pause is.
    ed.apply({
      changes: { from: 0, to: 5, insert: "/github-create-issue " },
      annotations: isolateHistory.of("full"),
    });
    expect(ed.doc()).toBe("/github-create-issue I found");
    expect(ed.joins()).toEqual([]);
    // A write outside the history in between (a landed correction, a mirror).
    ed.apply({
      changes: { from: ed.state.doc.length, insert: " it" },
      annotations: Transaction.addToHistory.of(false),
    });

    ed.run(undo);
    expect(ed.doc()).toBe("/githI found it");
    expect(ed.joins()).toEqual([5]);

    ed.run(redo);
    expect(ed.doc()).toBe("/github-create-issue I found it");
    expect(ed.joins()).toEqual([]);
  });
});
