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

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import {
  captureRewriteSelection,
  createComposerHistory,
  voiceRewriteTracker,
} from "../inputEditorExtensions";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function mount(doc: string, anchor: number, head: number): EditorView {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [createComposerHistory(), voiceRewriteTracker],
    }),
  });
  views.push(view);
  return view;
}

const DOC = "Intro. please make this part much shorter. Outro.";
const FROM = DOC.indexOf("please");
const TO = DOC.indexOf(" Outro.");

describe("captureRewriteSelection", () => {
  it("captures nothing without a selection", () => {
    expect(captureRewriteSelection(mount(DOC, 3, 3))).toBeNull();
  });

  it("captures a backwards selection by its text and range", () => {
    const selection = captureRewriteSelection(mount(DOC, TO, FROM))!;
    expect(selection.text).toBe("please make this part much shorter.");
    expect(selection.range()).toEqual({ from: FROM, to: TO });
  });

  it("replaces the selection as one undo step and selects the result", () => {
    const view = mount(DOC, FROM, TO);
    const selection = captureRewriteSelection(view)!;
    const depth = undoDepth(view.state);

    expect(selection.apply("Shorter.")).toBe(true);

    expect(view.state.doc.toString()).toBe("Intro. Shorter. Outro.");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "Shorter."
    );
    expect(undoDepth(view.state)).toBe(depth + 1);
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    // Applied once; it can't land again.
    expect(selection.apply("Again.")).toBe(false);
  });

  it("follows typing either side of the selection and still lands", () => {
    const view = mount(DOC, FROM, TO);
    const selection = captureRewriteSelection(view)!;

    view.dispatch({ changes: [{ from: 0, insert: "Hi. " }, { from: TO, insert: "!" }] });

    expect(selection.range()).toEqual({ from: FROM + 4, to: TO + 4 });
    expect(selection.apply("Shorter.")).toBe(true);
    expect(view.state.doc.toString()).toBe("Hi. Intro. Shorter.! Outro.");
  });

  it("is lost for good by an edit inside it, even one that restores the text", () => {
    const view = mount(DOC, FROM, TO);
    const selection = captureRewriteSelection(view)!;
    const lost = vi.fn();
    selection.onLost(lost);

    view.dispatch({ changes: { from: FROM, to: FROM + 1, insert: "P" } });
    view.dispatch({ changes: { from: FROM, to: FROM + 1, insert: "p" } });

    expect(lost).toHaveBeenCalledTimes(1);
    expect(selection.range()).toBeNull();
    expect(selection.apply("Shorter.")).toBe(false);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("is lost when the draft is cleared or the editor goes away", () => {
    const cleared = mount(DOC, FROM, TO);
    const first = captureRewriteSelection(cleared)!;
    cleared.dispatch({ changes: { from: 0, to: cleared.state.doc.length, insert: "" } });
    expect(first.range()).toBeNull();

    const destroyed = mount(DOC, FROM, TO);
    const second = captureRewriteSelection(destroyed)!;
    const lost = vi.fn();
    second.onLost(lost);
    destroyed.destroy();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(second.range()).toBeNull();
  });

  it("refuses to land in a composer that has been locked", () => {
    const view = mount(DOC, FROM, TO);
    const selection = captureRewriteSelection(view)!;
    const locked = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: DOC,
        selection: { anchor: FROM, head: TO },
        extensions: [voiceRewriteTracker, EditorView.editable.of(false)],
      }),
    });
    views.push(locked);
    const lockedSelection = captureRewriteSelection(locked)!;

    expect(lockedSelection.apply("Shorter.")).toBe(false);
    expect(locked.state.doc.toString()).toBe(DOC);
    expect(selection.apply("Shorter.")).toBe(true);
  });

  it("stops following a released selection", () => {
    const view = mount(DOC, FROM, TO);
    const selection = captureRewriteSelection(view)!;
    const lost = vi.fn();
    selection.onLost(lost);

    selection.release();
    view.dispatch({ changes: { from: FROM, insert: "x" } });

    expect(lost).not.toHaveBeenCalled();
    expect(selection.apply("Shorter.")).toBe(false);
  });
});
