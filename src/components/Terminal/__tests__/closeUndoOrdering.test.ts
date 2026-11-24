/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { clearComposerHistory, createComposerHistory } from "../inputEditorExtensions";
import { editorHasEditsSinceClose } from "../inputEditorExtensions/closeUndoOrdering";
import {
  hasEditsSinceClose,
  nextCloseSeq,
  resetCloseUndoOrderForTests,
  subscribeCloseUndoEdits,
  trackNativeFieldEdits,
  undoFieldText,
} from "@/services/terminal/closeUndoOrder";

const views: EditorView[] = [];

beforeEach(() => {
  resetCloseUndoOrderForTests();
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function mount(doc = ""): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [createComposerHistory()] }),
  });
  views.push(view);
  return view;
}

function type(view: EditorView, text: string): void {
  const at = view.state.doc.length;
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "input.type",
  });
}

describe("closeUndoOrdering", () => {
  it("leaves a draft older than the close to come after it", () => {
    const view = mount();
    type(view, "older draft");
    const close = nextCloseSeq();

    expect(editorHasEditsSinceClose(view.state, close)).toBe(false);
    expect(hasEditsSinceClose(view.contentDOM, close)).toBe(false);
  });

  it("puts typing after the close first, in its own undo step, then hands over", () => {
    const view = mount();
    // Typed right before and right after the close, well inside the grouping
    // delay that would otherwise merge them into one undo step.
    type(view, "before");
    const close = nextCloseSeq();
    type(view, " after");

    expect(hasEditsSinceClose(view.contentDOM, close)).toBe(true);
    undo(view);
    expect(view.state.doc.toString()).toBe("before");
    expect(hasEditsSinceClose(view.contentDOM, close)).toBe(false);
  });

  it("orders edits between two closes against each close", () => {
    const view = mount();
    const first = nextCloseSeq();
    type(view, "between");
    const second = nextCloseSeq();

    // Newer than the first close, older than the second.
    expect(editorHasEditsSinceClose(view.state, second)).toBe(false);
    expect(editorHasEditsSinceClose(view.state, first)).toBe(true);

    type(view, " latest");
    expect(editorHasEditsSinceClose(view.state, second)).toBe(true);
    undo(view);
    expect(editorHasEditsSinceClose(view.state, second)).toBe(false);
    expect(editorHasEditsSinceClose(view.state, first)).toBe(true);
    undo(view);
    expect(view.state.doc.toString()).toBe("");
    expect(editorHasEditsSinceClose(view.state, first)).toBe(false);
  });

  it("counts a redo of the newer typing as newer again", () => {
    const view = mount();
    const close = nextCloseSeq();
    type(view, "x");
    undo(view);
    expect(editorHasEditsSinceClose(view.state, close)).toBe(false);
    redo(view);
    expect(view.state.doc.toString()).toBe("x");
    expect(editorHasEditsSinceClose(view.state, close)).toBe(true);
  });

  it("hands over once the draft stops being the same draft, and orders the next one afresh", () => {
    const view = mount();
    // History already holds a step from before the close.
    type(view, "earlier");
    const close = nextCloseSeq();
    type(view, " sent prompt");
    clearComposerHistory(view);
    expect(editorHasEditsSinceClose(view.state, close)).toBe(false);

    type(view, " next draft");
    expect(editorHasEditsSinceClose(view.state, close)).toBe(true);
    undo(view);
    expect(editorHasEditsSinceClose(view.state, close)).toBe(false);
  });

  it("keeps its answer when the history trims its oldest steps", () => {
    const view = mount();
    for (let i = 0; i < 130; i++) {
      type(view, `${i} `);
      view.dispatch({ annotations: isolateHistory.of("after") });
    }
    const close = nextCloseSeq();
    type(view, "after the close");

    expect(editorHasEditsSinceClose(view.state, close)).toBe(true);
    undo(view);
    expect(editorHasEditsSinceClose(view.state, close)).toBe(false);
  });

  it("ignores a write kept out of history", () => {
    const view = mount();
    const close = nextCloseSeq();
    view.dispatch({
      changes: { from: 0, insert: "loaded draft" },
      annotations: Transaction.addToHistory.of(false),
    });

    expect(editorHasEditsSinceClose(view.state, close)).toBe(false);
  });

  it("stops answering for an editor once it is destroyed", () => {
    const view = mount();
    const close = nextCloseSeq();
    type(view, "x");
    const content = view.contentDOM;
    expect(hasEditsSinceClose(content, close)).toBe(true);
    view.destroy();
    views.splice(views.indexOf(view), 1);

    expect(hasEditsSinceClose(content, close)).toBe(false);
  });
});

describe("native text fields", () => {
  function fire(field: HTMLTextAreaElement, type: "beforeinput" | "input", inputType: string) {
    field.dispatchEvent(new InputEvent(type, { bubbles: true, inputType }));
  }

  // What a keystroke does: beforeinput, the change, then input.
  function editField(field: HTMLTextAreaElement, value: string): void {
    fire(field, "beforeinput", "insertText");
    field.value = value;
    fire(field, "input", "insertText");
  }

  function undoField(field: HTMLTextAreaElement, value: string): void {
    fire(field, "beforeinput", "historyUndo");
    field.value = value;
    fire(field, "input", "historyUndo");
  }

  function mountField(): HTMLTextAreaElement {
    trackNativeFieldEdits();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    return field;
  }

  it("orders a field's edits against the close by its value before them", () => {
    const field = mountField();
    editField(field, "older");
    const close = nextCloseSeq();
    expect(hasEditsSinceClose(field, close)).toBe(false);

    editField(field, "older plus newer");
    expect(hasEditsSinceClose(field, close)).toBe(true);

    // The field's own undo brings it back to how the close left it.
    undoField(field, "older");
    expect(hasEditsSinceClose(field, close)).toBe(false);
    field.remove();
  });

  it("hands a taken press to a native field's own undo", () => {
    const field = mountField();
    field.focus();
    const execCommand = vi.fn(() => true);
    Reflect.set(document, "execCommand", execCommand);
    try {
      undoFieldText(field);
      expect(execCommand).toHaveBeenCalledWith("undo");
      execCommand.mockClear();
      undoFieldText(document.body);
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
      field.remove();
    }
  });

  it("hands over once the app resets the field, and orders typing after that afresh", () => {
    const field = mountField();
    editField(field, "query");
    const close = nextCloseSeq();
    editField(field, "query refined");
    // A clear button sets the value without an input event.
    field.value = "";
    expect(hasEditsSinceClose(field, close)).toBe(false);

    editField(field, "new");
    expect(hasEditsSinceClose(field, close)).toBe(true);
    undoField(field, "");
    expect(hasEditsSinceClose(field, close)).toBe(false);
    field.remove();
  });
});

describe("telling Edit > Undo a field's undo moved (#17108)", () => {
  it("tells it of an editor's edits, undos and teardown, not its caret moving", () => {
    const view = mount();
    const moved = vi.fn();
    const unsubscribe = subscribeCloseUndoEdits(moved);
    nextCloseSeq();

    type(view, "after the close");
    expect(moved).toHaveBeenCalledTimes(1);

    view.dispatch({ selection: { anchor: 0 } });
    expect(moved).toHaveBeenCalledTimes(1);

    undo(view);
    expect(moved).toHaveBeenCalledTimes(2);

    views.splice(views.indexOf(view), 1);
    view.destroy();
    expect(moved).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("tells it when the composer's history is cleared under an unchanged close", () => {
    const view = mount();
    nextCloseSeq();
    type(view, "after the close");
    const moved = vi.fn();
    const unsubscribe = subscribeCloseUndoEdits(moved);

    clearComposerHistory(view);

    expect(moved).toHaveBeenCalledTimes(1);
    expect(editorHasEditsSinceClose(view.state, 1)).toBe(false);
    unsubscribe();
  });

  it("tells it of typing in a native field once a close is in the history", () => {
    nextCloseSeq();
    trackNativeFieldEdits();
    const moved = vi.fn();
    const unsubscribe = subscribeCloseUndoEdits(moved);
    const field = document.createElement("input");
    document.body.appendChild(field);

    field.value = "typed";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    unsubscribe();
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(moved).toHaveBeenCalledTimes(1);
    field.remove();
  });
});
