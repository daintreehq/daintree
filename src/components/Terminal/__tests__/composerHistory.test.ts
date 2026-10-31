/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { isolateHistory, redoDepth, undoDepth } from "@codemirror/commands";
import {
  addFileDropChip,
  addImageChip,
  clearComposerHistory,
  createComposerHistory,
  fileDropChipField,
  imageChipField,
  outsideDraftWrite,
  readImageChipPaths,
} from "../inputEditorExtensions";
import { composerDraftGeneration } from "../composerDraftGeneration";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function mount(doc: string, extensions: Extension[] = []): EditorView {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({ doc, extensions: [createComposerHistory(), ...extensions] }),
  });
  views.push(view);
  return view;
}

const isMac = /Mac/.test(navigator.platform);

function press(view: EditorView, key: string, shift = false): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: shift,
    metaKey: isMac,
    ctrlKey: !isMac,
    cancelable: true,
  });
  return runScopeHandlers(view, event, "editor");
}

const undoKey = (view: EditorView) => press(view, "z");
const redoKey = (view: EditorView) => (isMac ? press(view, "z", true) : press(view, "y"));

/** A pause longer than the grouping delay: the next edit starts its own undo step. */
function pause(view: EditorView): void {
  view.dispatch({ annotations: isolateHistory.of("after") });
}

function type(view: EditorView, at: number, text: string): void {
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "input.type",
  });
}

describe("composer history", () => {
  it("undoes and redoes typing", () => {
    const view = mount("");
    type(view, 0, "fix the test");

    expect(undoKey(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    expect(redoKey(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("fix the test");
  });

  it("keeps an isolated outside write its own step, apart from adjacent typing", () => {
    const view = mount("");
    type(view, 0, "Hello");
    view.dispatch({
      changes: { from: 5, insert: " there" },
      annotations: isolateHistory.of("full"),
    });
    type(view, 11, "!");

    undoKey(view);
    expect(view.state.doc.toString()).toBe("Hello there");
    undoKey(view);
    expect(view.state.doc.toString()).toBe("Hello");
    undoKey(view);
    expect(view.state.doc.toString()).toBe("");
  });

  it("refuses undo and redo, by key or from the Edit menu, while the composer is locked", () => {
    const editable = new Compartment();
    const view = mount("", [editable.of(EditorView.editable.of(true))]);
    type(view, 0, "held");
    pause(view);
    type(view, 4, " for send");
    undoKey(view);
    view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(false)) });

    undoKey(view);
    expect(view.state.doc.toString()).toBe("held");
    redoKey(view);
    expect(view.state.doc.toString()).toBe("held");
    const native = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(native);
    expect(native.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("held");

    view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(true)) });
    view.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })
    );
    expect(view.state.doc.toString()).toBe("");
  });

  it("clears every undo and redo step", () => {
    const view = mount("");
    type(view, 0, "sent prompt");
    pause(view);
    type(view, 11, " more");
    undoKey(view);
    expect(undoDepth(view.state)).toBe(1);
    expect(redoDepth(view.state)).toBe(1);

    clearComposerHistory(view);

    expect(undoDepth(view.state)).toBe(0);
    expect(redoDepth(view.state)).toBe(0);
    undoKey(view);
    redoKey(view);
    expect(view.state.doc.toString()).toBe("sent prompt");
  });

  it("leaves a view without history alone, and history kept working after a clear", () => {
    const bare = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "x" }),
    });
    views.push(bare);
    const dispatch = vi.spyOn(bare, "dispatch");
    clearComposerHistory(bare);
    expect(dispatch).not.toHaveBeenCalled();

    const view = mount("");
    type(view, 0, "old");
    clearComposerHistory(view);
    expect(undoDepth(view.state)).toBe(0);
    type(view, 3, " new");
    undoKey(view);
    expect(view.state.doc.toString()).toBe("old");
  });

  // An attachment still on its way checks this to learn its draft is gone
  // (#15599), and an empty draft just sent has nothing to undo either.
  it("starts a new draft on every clear, with or without steps to drop, and not on edits", () => {
    const view = mount("");
    const bare = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "" }),
    });
    views.push(bare);
    const first = composerDraftGeneration(view);

    type(view, 0, "typed");
    expect(composerDraftGeneration(view)).toBe(first);

    clearComposerHistory(view);
    const second = composerDraftGeneration(view);
    expect(second).not.toBe(first);
    clearComposerHistory(view);
    expect(composerDraftGeneration(view)).not.toBe(second);

    const bareBefore = composerDraftGeneration(bare);
    clearComposerHistory(bare);
    expect(composerDraftGeneration(bare)).not.toBe(bareBefore);
  });
});

describe("chips through undo", () => {
  const imagePath = "/tmp/clipboard-1700000000000-a.png";

  function withImageChip(): EditorView {
    const view = mount("", [imageChipField, fileDropChipField]);
    const text = `look ${imagePath} here`;
    view.dispatch({
      changes: { from: 0, insert: text },
      effects: addImageChip.of({
        from: 5,
        to: 5 + imagePath.length,
        filePath: imagePath,
        thumbnailUrl: "data:image/png;base64,",
      }),
    });
    pause(view);
    return view;
  }

  it("brings a deleted image chip back as a chip, not as its bare path", () => {
    const view = withImageChip();
    const entry = view.state.field(imageChipField)[0]!;
    view.dispatch({ changes: { from: entry.from, to: entry.to + 1 }, userEvent: "delete" });
    expect(readImageChipPaths(view)).toEqual([]);

    undoKey(view);

    expect(view.state.doc.toString()).toBe(`look ${imagePath} here`);
    expect(readImageChipPaths(view)).toEqual([imagePath]);
  });

  it("brings an image chip back after a partial edit inside it is undone", () => {
    const view = withImageChip();
    type(view, 9, "zz");
    expect(view.state.field(imageChipField)).toEqual([]);

    undoKey(view);

    expect(readImageChipPaths(view)).toEqual([imagePath]);
  });

  it("restores a chip where it was when its deletion merged with typing beside it", () => {
    const view = withImageChip();
    type(view, 5, "x");
    const entry = view.state.field(imageChipField)[0]!;
    expect(entry.from).toBe(6);
    view.dispatch({ changes: { from: entry.from, to: entry.to }, userEvent: "delete" });

    undoKey(view);

    expect(view.state.doc.toString()).toBe(`look ${imagePath} here`);
    expect(view.state.field(imageChipField).map((e) => [e.from, e.to])).toEqual([
      [5, 5 + imagePath.length],
    ]);
  });

  it("drops a chip it cannot place rather than throwing, when text moved outside history", () => {
    const view = withImageChip();
    const entry = view.state.field(imageChipField)[0]!;
    view.dispatch({ changes: { from: entry.from, to: entry.to }, userEvent: "delete" });
    view.dispatch({
      changes: { from: 0, insert: ">> " },
      annotations: Transaction.addToHistory.of(false),
    });

    expect(() => undoKey(view)).not.toThrow();

    expect(view.state.doc.toString()).toBe(`>> look ${imagePath} here`);
    expect(readImageChipPaths(view)).toEqual([]);
  });

  it("brings a file-drop chip back when its pasted insertion is undone and redone", () => {
    const view = mount("", [imageChipField, fileDropChipField]);
    const token = "@src/app.ts";
    view.dispatch({
      changes: { from: 0, insert: `${token} ` },
      effects: addFileDropChip.of({
        from: 0,
        to: token.length,
        filePath: "/repo/src/app.ts",
        fileName: "app.ts",
        fileSize: 12,
      }),
    });

    undoKey(view);
    expect(view.state.field(fileDropChipField)).toEqual([]);
    redoKey(view);

    expect(view.state.doc.toString()).toBe(`${token} `);
    expect(view.state.field(fileDropChipField).map((e) => [e.from, e.to, e.filePath])).toEqual([
      [0, token.length, "/repo/src/app.ts"],
    ]);
  });
});

describe("outsideDraftWrite", () => {
  it("scrolls to the caret it places, unless the write leaves the caret to the user", () => {
    const change = { from: 0, insert: "dictated " };
    expect(outsideDraftWrite(change, "dictated draft", null).scrollIntoView).toBe(true);
    // Dictation is followed on its own, and a cleanup lands where it shows.
    expect(
      outsideDraftWrite(change, "dictated draft", null, { keepsCaret: true }).scrollIntoView
    ).toBe(false);
  });
});
