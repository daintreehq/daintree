// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createCaretTracker } from "../inputEditorExtensions/caretTracker";
import { selectionAfterOutsideWrite } from "../inputEditorExtensions/composerHistory";
import { readComposerSelection } from "@/lib/composerCaret";

const views: EditorView[] = [];
function mount(doc: string, panelId = "panel-1") {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({ doc, extensions: [createCaretTracker(() => panelId)] }),
  });
  views.push(view);
  return view;
}
// jsdom's DOM selection never follows a dispatched one, so focus is stubbed.
const focus = (view: EditorView) =>
  Object.defineProperty(view, "hasFocus", { configurable: true, get: () => true });

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("createCaretTracker", () => {
  it("publishes nothing for a composer that was never focused", () => {
    const view = mount("hello world");
    view.dispatch({ selection: { anchor: 3 } });
    expect(readComposerSelection("panel-1", "hello world")).toBeNull();
  });

  it("publishes the selection once focused, and keeps it when focus leaves", () => {
    const view = mount("hello world");
    focus(view);
    view.dispatch({ selection: { anchor: 8, head: 2 } });
    expect(readComposerSelection("panel-1", "hello world")).toEqual({ from: 2, to: 8 });
    Object.defineProperty(view, "hasFocus", { configurable: true, get: () => false });
    view.dispatch({ selection: { anchor: 4 } });

    expect(readComposerSelection("panel-1", "hello world")).toEqual({ from: 4, to: 4 });
  });

  it("reports nothing against a draft the composer doesn't show", () => {
    const view = mount("hello world");
    focus(view);
    view.dispatch({ selection: { anchor: 4 } });
    expect(readComposerSelection("panel-1", "hello there")).toBeNull();
  });

  it("is forgotten when its composer goes, but not when another took over", () => {
    const first = mount("one");
    focus(first);
    first.dispatch({ selection: { anchor: 1 } });
    const second = mount("one");
    focus(second);
    second.dispatch({ selection: { anchor: 2 } });

    first.destroy();
    expect(readComposerSelection("panel-1", "one")).toEqual({ from: 2, to: 2 });
    second.destroy();
    expect(readComposerSelection("panel-1", "one")).toBeNull();
  });
});

describe("selectionAfterOutsideWrite", () => {
  const state = EditorState.create({
    doc: "hello world",
    selection: { anchor: 2, head: 4 },
  });

  it("uses the selection the writer asked for", () => {
    expect(
      selectionAfterOutsideWrite(state, true, { from: 0, insert: "x" }, { from: 7, to: 7 })
    ).toEqual({
      anchor: 7,
      head: 7,
    });
  });

  it("carries the user's selection through the write", () => {
    expect(selectionAfterOutsideWrite(state, true, { from: 0, insert: "> " }, null)).toEqual({
      anchor: 4,
      head: 6,
    });
    expect(selectionAfterOutsideWrite(state, true, { from: 11, insert: "!" }, null)).toEqual({
      anchor: 2,
      head: 4,
    });
  });

  it("uses the selection the writer asked for even without focus", () => {
    expect(
      selectionAfterOutsideWrite(state, false, { from: 0, insert: "x" }, { from: 7, to: 7 })
    ).toEqual({ anchor: 7, head: 7 });
  });

  it("leaves an unfocused composer's caret to the default", () => {
    expect(
      selectionAfterOutsideWrite(state, false, { from: 0, insert: "x" }, null)
    ).toBeUndefined();
  });
});

describe("composer draft scopes", () => {
  it("keeps a pane's composer and an isolated one apart on the same terminal", () => {
    const pane = mount("pane draft", "project-1:term-1");
    focus(pane);
    pane.dispatch({ selection: { anchor: 4 } });
    const isolated = mount("own draft", "isolated-composer:term-1");
    focus(isolated);
    isolated.dispatch({ selection: { anchor: 1 } });

    expect(readComposerSelection("project-1:term-1", "pane draft")).toEqual({ from: 4, to: 4 });
    expect(readComposerSelection("isolated-composer:term-1", "own draft")).toEqual({
      from: 1,
      to: 1,
    });
  });
});
