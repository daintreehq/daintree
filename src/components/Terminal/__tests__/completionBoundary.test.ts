import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
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
    /** Where the token at the caret ends, if it was typed against a word. */
    end: () => completionBoundaryAt(state, state.selection.main.head),
    doc: () => state.doc.toString(),
  };
}

describe("completionBoundary", () => {
  it("marks where a token typed in front of a word meets it, and keeps it there as typing goes on", () => {
    const ed = editor("I found an issue");
    ed.type("/");
    expect(ed.end()).toBe(1);
    ed.type("gith");
    expect(ed.doc()).toBe("/githI found an issue");
    expect(ed.end()).toBe(5);
    expect(completionBoundaryAt(ed.state, 2)).toBe(5);
    expect(completionBoundaryAt(ed.state, 6)).toBeUndefined();
  });

  it.each(["@", "#", "$"])("marks a %s token too", (trigger) => {
    const ed = editor("see that", "see ".length);
    ed.type(`${trigger}x`);
    expect(ed.end()).toBe(6);
  });

  it("marks a pasted token in front of a word", () => {
    const ed = editor("see that", "see ".length);
    ed.apply({
      changes: { from: 4, insert: "@src" },
      selection: { anchor: 8 },
      userEvent: "input.paste",
    });
    expect(ed.end()).toBe(8);
  });

  it("marks nothing for plain words, typing inside a token, or where no word follows", () => {
    const plain = editor("happy");
    plain.type("un");
    expect(plain.state.field(completionBoundaryField)).toEqual([]);

    const inside = editor("/help /compact", "/help /com".length);
    inside.type("@x");
    expect(inside.state.field(completionBoundaryField)).toEqual([]);

    const atEnd = editor("see ", 4);
    atEnd.type("#148");
    expect(atEnd.state.field(completionBoundaryField)).toEqual([]);

    const beforeSpace = editor("see  now", 4);
    beforeSpace.type("#148");
    expect(beforeSpace.state.field(completionBoundaryField)).toEqual([]);
  });

  it("marks nothing for a write that isn't the user's", () => {
    const ed = editor("I found");
    ed.apply({ changes: { from: 0, insert: "/gith" }, selection: { anchor: 5 } });
    expect(ed.state.field(completionBoundaryField)).toEqual([]);
  });

  it("holds through a space typed at the join and taken out again", () => {
    const ed = editor("I found");
    ed.type("/gith ");
    expect(ed.doc()).toBe("/gith I found");
    expect(ed.end()).toBeUndefined();
    ed.apply({
      changes: { from: 5, to: 6 },
      selection: { anchor: 5 },
      userEvent: "delete.backward",
    });
    expect(ed.doc()).toBe("/githI found");
    expect(ed.end()).toBe(5);
  });

  it("holds when a space or a line goes in ahead of the trigger", () => {
    const ed = editor("I found");
    ed.type("/gith");
    ed.apply({ changes: { from: 0, insert: "\n" }, userEvent: "input.type" });
    expect(ed.doc()).toBe("\n/githI found");
    expect(completionBoundaryAt(ed.state, 6)).toBe(6);
  });

  it("drops the mark when the word or the token is deleted", () => {
    const word = editor("I found");
    word.type("/g");
    word.apply({ changes: { from: 2, to: 3 }, userEvent: "delete.forward" });
    expect(word.doc()).toBe("/g found");
    expect(word.state.field(completionBoundaryField)).toEqual([]);

    const token = editor("I found");
    token.type("/g");
    token.apply({
      changes: { from: 0, to: 2 },
      selection: { anchor: 0 },
      userEvent: "delete.backward",
    });
    expect(token.doc()).toBe("I found");
    expect(token.state.field(completionBoundaryField)).toEqual([]);
  });

  it("stops counting once a deleted space merges the token into the word before it", () => {
    const ed = editor("@src/ App.tsx", "@src/ ".length);
    ed.type("@New");
    expect(ed.end()).toBe(10);
    ed.apply({ changes: { from: 5, to: 6 }, userEvent: "delete.backward" });
    expect(ed.doc()).toBe("@src/@NewApp.tsx");
    expect(completionBoundaryAt(ed.state, "@src/@New".length)).toBeUndefined();
  });

  it("marks nothing when undo puts back part of a whole token", () => {
    const ed = editor("@src/App.tsx now");
    ed.apply({ changes: { from: 0, to: 5 }, userEvent: "delete.selection" });
    expect(ed.doc()).toBe("App.tsx now");
    ed.run(undo);
    expect(ed.doc()).toBe("@src/App.tsx now");
    expect(completionBoundaryAt(ed.state, "@sr".length)).toBeUndefined();
  });

  it("ends each token at its own word, the nearest one at or past the caret", () => {
    const ed = editor("ab cd", 0);
    ed.type("/x");
    ed.apply({ selection: { anchor: "/xab ".length } });
    ed.type("@y");
    expect(ed.doc()).toBe("/xab @ycd");
    expect(completionBoundaryAt(ed.state, 1)).toBe(2);
    expect(completionBoundaryAt(ed.state, 7)).toBe(7);
    // A join the caret has passed belongs to the query, not the word.
    expect(completionBoundaryAt(ed.state, 3)).toBeUndefined();
  });

  it("puts the mark back as it was when typing is undone and redone", () => {
    const ed = editor("fix it");
    ed.type("/gith");
    ed.run(undo);
    expect(ed.doc()).toBe("fix it");
    expect(ed.state.field(completionBoundaryField)).toEqual([]);
    ed.run(redo);
    expect(ed.doc()).toBe("/githfix it");
    expect(completionBoundaryAt(ed.state, 5)).toBe(5);
  });

  it("puts the mark back when deleting the token or the word's first letter is undone", () => {
    const token = editor("fix it");
    token.type("/gith");
    token.apply({
      changes: { from: 0, to: 5 },
      selection: { anchor: 0 },
      userEvent: "delete.selection",
      annotations: isolateHistory.of("full"),
    });
    token.run(undo);
    expect(token.doc()).toBe("/githfix it");
    expect(completionBoundaryAt(token.state, 5)).toBe(5);

    const letter = editor("fix it");
    letter.type("/gith");
    letter.apply({
      changes: { from: 5, to: 6 },
      userEvent: "delete.forward",
      annotations: isolateHistory.of("full"),
    });
    expect(letter.doc()).toBe("/githix it");
    letter.run(undo);
    expect(letter.doc()).toBe("/githfix it");
    expect(completionBoundaryAt(letter.state, 5)).toBe(5);
  });

  it("follows an exact edit elsewhere and drops on a whole-draft replacement", () => {
    const ed = editor("x I found", 2);
    ed.type("/g");
    expect(ed.end()).toBe(4);
    ed.apply({ changes: { from: 0, insert: "so " } });
    expect(completionBoundaryAt(ed.state, 7)).toBe(7);
    ed.apply({ changes: { from: 0, to: ed.state.doc.length, insert: ed.doc() } });
    expect(ed.state.field(completionBoundaryField)).toEqual([]);
  });

  it("is back where it was when a completion is undone, a write outside the history between", () => {
    const ed = editor("I found");
    ed.type("/github-create");
    // Its own undo step, as a pick made after a pause is; shorter than what
    // was typed, so a position kept from before it would be out of range.
    ed.apply({
      changes: { from: 0, to: 14, insert: "/help " },
      selection: { anchor: 6 },
      annotations: isolateHistory.of("full"),
    });
    expect(ed.doc()).toBe("/help I found");
    expect(ed.end()).toBeUndefined();
    ed.apply({
      changes: { from: ed.state.doc.length, insert: " it" },
      annotations: Transaction.addToHistory.of(false),
    });

    ed.run(undo);
    expect(ed.doc()).toBe("/github-createI found it");
    expect(completionBoundaryAt(ed.state, 14)).toBe(14);

    ed.run(redo);
    expect(ed.doc()).toBe("/help I found it");
    expect(completionBoundaryAt(ed.state, 5)).toBeUndefined();
  });
});
