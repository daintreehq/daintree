// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { history, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  rebindToComposer,
  recordComposerBindings,
} from "../inputEditorExtensions/composerBindings";

// Destroyed with each test, or the measure each schedules fires after it ends,
// in a jsdom that can't measure.
const views: EditorView[] = [];

function editor(view: EditorView): EditorView {
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function composer(doc = "", editableAtBuild = true) {
  const onUpdate = vi.fn();
  const compartment = new Compartment();
  const extensions: Extension[] = [
    history(),
    compartment.of(EditorView.editable.of(editableAtBuild)),
    EditorView.updateListener.of(onUpdate),
  ];
  const view = editor(
    new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc, extensions }),
    })
  );
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

  it.each([
    ["locked since it was built", true, false],
    ["unlocked since it was built", false, true],
  ])("brings a compartment along as it stands: %s", (_name, editableAtBuild, editableNow) => {
    const kept = composer("", !editableNow).view.state;

    const now = composer("", editableAtBuild);
    now.view.dispatch({
      effects: now.compartment.reconfigure(EditorView.editable.of(editableNow)),
    });
    now.view.setState(rebindToComposer(now.view, kept));

    expect(now.view.state.facet(EditorView.editable)).toBe(editableNow);
    // Still this composer's own to change, not only copied in.
    now.view.dispatch({
      effects: now.compartment.reconfigure(EditorView.editable.of(!editableNow)),
    });
    expect(now.view.state.facet(EditorView.editable)).toBe(!editableNow);
  });

  it("leaves a state alone in an editor no composer built", () => {
    const kept = EditorState.create({ doc: "text" });
    const view = editor(new EditorView({ parent: document.createElement("div") }));

    expect(rebindToComposer(view, kept)).toBe(kept);
  });
});
