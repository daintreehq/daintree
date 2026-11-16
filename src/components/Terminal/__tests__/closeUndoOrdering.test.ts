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
import { redo, undo } from "@codemirror/commands";
import { clearComposerHistory, createComposerHistory } from "../inputEditorExtensions";
import { editorHasEditsSinceClose } from "../inputEditorExtensions/closeUndoOrdering";
import {
  hasEditsSinceClose,
  nextCloseSeq,
  resetCloseUndoOrderForTests,
  trackNativeFieldEdits,
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

  it("hands over once the draft stops being the same draft", () => {
    const view = mount();
    const close = nextCloseSeq();
    type(view, "sent prompt");
    clearComposerHistory(view);

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
  function editField(field: HTMLTextAreaElement, value: string): void {
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value })
    );
    field.value = value;
  }

  it("orders a field's edits against the close by its value before them", () => {
    trackNativeFieldEdits();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    editField(field, "older");
    const close = nextCloseSeq();
    expect(hasEditsSinceClose(field, close)).toBe(false);

    editField(field, "older plus newer");
    expect(hasEditsSinceClose(field, close)).toBe(true);

    // The field's own undo brings it back to how the close left it.
    field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "historyUndo" }));
    field.value = "older";
    expect(hasEditsSinceClose(field, close)).toBe(false);
    field.remove();
  });
});
