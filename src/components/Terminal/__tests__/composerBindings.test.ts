// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { history, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  rebindToComposer,
  recordComposerBindings,
} from "../inputEditorExtensions/composerBindings";

function composer(doc = "") {
  const onUpdate = vi.fn();
  const compartment = new Compartment();
  const extensions: Extension[] = [
    history(),
    compartment.of(EditorView.editable.of(true)),
    EditorView.updateListener.of(onUpdate),
  ];
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({ doc, extensions }),
  });
  recordComposerBindings(view, { extensions, compartments: [compartment] });
  return { view, onUpdate, compartment };
}

describe("rebindToComposer", () => {
  it("keeps a state's text, selection and undo steps on the composer showing it now", () => {
    const gone = composer();
    gone.view.dispatch({ changes: { from: 0, insert: "half a prompt" }, userEvent: "input.type" });
    gone.view.dispatch({ selection: EditorSelection.cursor(4) });
    const kept = gone.view.state;

    const now = composer();
    now.view.setState(rebindToComposer(now.view, kept));

    expect(now.view.state.doc.toString()).toBe("half a prompt");
    expect(now.view.state.selection.main.head).toBe(4);
    expect(undoDepth(now.view.state)).toBe(1);

    gone.onUpdate.mockClear();
    now.onUpdate.mockClear();
    expect(undo(now.view)).toBe(true);
    expect(now.view.state.doc.toString()).toBe("");
    expect(now.onUpdate).toHaveBeenCalled();
    expect(gone.onUpdate).not.toHaveBeenCalled();
  });

  it("brings the composer's compartments along as they stand, not as they were built", () => {
    const gone = composer();
    const kept = gone.view.state;

    const now = composer();
    now.view.dispatch({
      effects: now.compartment.reconfigure(EditorView.editable.of(false)),
    });
    now.view.setState(rebindToComposer(now.view, kept));

    expect(now.view.state.facet(EditorView.editable)).toBe(false);
    now.view.dispatch({
      effects: now.compartment.reconfigure(EditorView.editable.of(true)),
    });
    expect(now.view.state.facet(EditorView.editable)).toBe(true);
  });

  it("leaves a state alone in an editor no composer built", () => {
    const kept = EditorState.create({ doc: "text" });
    const view = new EditorView({ parent: document.createElement("div") });

    expect(rebindToComposer(view, kept)).toBe(kept);
  });
});
