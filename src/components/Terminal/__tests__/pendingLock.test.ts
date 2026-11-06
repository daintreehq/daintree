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

import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteLine,
  isolateHistory,
  undoDepth,
} from "@codemirror/commands";
import { VOICE_PENDING_REFUSAL_MS } from "@/lib/animationUtils";
import {
  createComposerHistory,
  outsideDraftWrite,
  pendingAIField,
  pendingLock,
  setPendingAIRanges,
  userEdit,
} from "../inputEditorExtensions";
import { pendingBlocksField, refusedBlocks } from "../inputEditorExtensions/pendingLock";
import type { PendingAIRange } from "../inputEditorExtensions/base";
import { REWRITE_USER_EVENT } from "../inputEditorExtensions/voiceRewrite";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

function mount(doc: string, ranges: PendingAIRange[], extensions: Extension[] = []): EditorView {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      extensions: [createComposerHistory(), pendingAIField, pendingLock, ...extensions],
    }),
  });
  views.push(view);
  view.dispatch({ effects: setPendingAIRanges.of(ranges) });
  return view;
}

const PASSAGE = "fix the bug";
const DOC = `now ${PASSAGE} please`;
const FROM = "now ".length;
const TO = FROM + PASSAGE.length;
const BLOCK = { from: FROM, to: TO };

function typeAt(view: EditorView, at: number, text: string) {
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "input.type",
  });
}

function caret(view: EditorView, at: number, head = at) {
  view.dispatch({ selection: { anchor: at, head }, userEvent: "select" });
}

const washed = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll(".cm-voice-pending-refused")).map(
    (el) => el.textContent
  );
const blocks = (view: EditorView) => view.state.field(pendingBlocksField);

describe("refusedBlocks", () => {
  const changes = (spec: { from: number; to?: number; insert?: string }) =>
    EditorState.create({ doc: DOC }).changes(spec);

  it("lets an insertion at either edge through and refuses one inside", () => {
    expect(refusedBlocks([BLOCK], changes({ from: FROM, insert: "x" }), null)).toBeNull();
    expect(refusedBlocks([BLOCK], changes({ from: TO, insert: "x" }), null)).toBeNull();
    expect(refusedBlocks([BLOCK], changes({ from: FROM + 1, insert: "x" }), null)).toEqual([BLOCK]);
  });

  it("refuses a deletion reaching one character into the block from either side", () => {
    expect(refusedBlocks([BLOCK], changes({ from: FROM - 1, to: FROM + 1 }), null)).toEqual([
      BLOCK,
    ]);
    expect(refusedBlocks([BLOCK], changes({ from: TO - 1, to: TO + 1 }), null)).toEqual([BLOCK]);
    expect(refusedBlocks([BLOCK], changes({ from: FROM - 1, to: FROM }), null)).toBeNull();
    expect(refusedBlocks([BLOCK], changes({ from: TO, to: TO + 1 }), null)).toBeNull();
  });

  it("takes a whole block out only for a selection that covers it", () => {
    const whole = changes({ from: 0, to: DOC.length });
    expect(refusedBlocks([BLOCK], whole, EditorSelection.single(0, DOC.length))).toBeNull();
    expect(refusedBlocks([BLOCK], whole, EditorSelection.single(DOC.length))).toEqual([BLOCK]);
    expect(refusedBlocks([BLOCK], whole, null)).toEqual([BLOCK]);
    expect(refusedBlocks([BLOCK], whole, EditorSelection.single(FROM + 1, DOC.length))).toEqual([
      BLOCK,
    ]);
  });
});

describe("pendingLock", () => {
  it("refuses typing inside the pending words and washes them", () => {
    const view = mount(DOC, [BLOCK]);
    typeAt(view, FROM + 3, "x");

    expect(view.state.doc.toString()).toBe(DOC);
    expect(washed(view)).toEqual([PASSAGE]);
  });

  it("puts text typed at either edge outside the block, which keeps its words", () => {
    const view = mount(PASSAGE, [{ from: 0, to: PASSAGE.length }]);
    typeAt(view, 0, "/fix ");
    typeAt(view, view.state.doc.length, " now");

    expect(view.state.doc.toString()).toBe(`/fix ${PASSAGE} now`);
    const [block] = blocks(view);
    expect(view.state.sliceDoc(block!.from, block!.to)).toBe(PASSAGE);
    expect(washed(view)).toEqual([]);
  });

  it("keeps Backspace right after the block and Delete right before it out of it", () => {
    const view = mount(DOC, [BLOCK]);
    caret(view, TO);
    deleteCharBackward(view);
    caret(view, FROM);
    deleteCharForward(view);
    expect(view.state.doc.toString()).toBe(DOC);

    // The other way, each takes the character beside the block.
    deleteCharBackward(view);
    caret(view, TO - 1);
    deleteCharForward(view);
    expect(view.state.doc.toString()).toBe(`now${PASSAGE}please`);
  });

  it("refuses word and line deletes, even one that would take the whole block", () => {
    const view = mount("ship it", [{ from: 5, to: 7 }]);
    caret(view, 7);
    deleteGroupBackward(view);
    deleteLine(view);
    expect(view.state.doc.toString()).toBe("ship it");
  });

  it("refuses a selection covering only part of the block, even past its edge", () => {
    const view = mount(DOC, [BLOCK]);
    caret(view, 0, FROM + 3);
    deleteCharBackward(view);
    view.dispatch(view.state.replaceSelection("x"), { userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: FROM + 3 });
  });

  it("lets select all and delete or type take the block out with everything else", () => {
    const deleted = mount(DOC, [BLOCK]);
    caret(deleted, 0, DOC.length);
    deleteCharBackward(deleted);
    expect(deleted.state.doc.toString()).toBe("");
    expect(blocks(deleted)).toEqual([]);

    const typed = mount(DOC, [BLOCK]);
    caret(typed, 0, DOC.length);
    typed.dispatch(
      typed.state.update(typed.state.replaceSelection("x"), { userEvent: "input.type" })
    );
    expect(typed.state.doc.toString()).toBe("x");
    expect(blocks(typed)).toEqual([]);
  });

  it("refuses paste, cut, a drop inside and a drag out of part of the block", () => {
    const view = mount(DOC, [BLOCK]);
    caret(view, FROM + 2);
    view.dispatch({ changes: { from: FROM + 2, insert: "pasted" }, userEvent: "input.paste" });
    view.dispatch({ changes: { from: FROM + 2, insert: "dropped" }, userEvent: "input.drop" });
    caret(view, FROM, FROM + 3);
    view.dispatch({ changes: { from: FROM, to: FROM + 3 }, userEvent: "delete.cut" });
    view.dispatch({
      changes: [
        { from: 0, insert: "fix" },
        { from: FROM, to: FROM + 3 },
      ],
      userEvent: "move.drop",
    });
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("refuses the composer's own user edits, a chip removed or a file pasted", () => {
    const view = mount(DOC, [BLOCK]);
    view.dispatch({ changes: { from: FROM, to: FROM + 4 }, annotations: userEdit.of(true) });
    view.dispatch({
      changes: { from: FROM + 4, insert: "@a.ts " },
      annotations: userEdit.of(true),
    });
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("refuses an edit that reaches one block and takes another out whole", () => {
    const doc = "one two three four";
    const view = mount(doc, [
      { from: 0, to: 7 },
      { from: 8, to: 18 },
    ]);
    caret(view, 0, 10);
    deleteCharBackward(view);
    expect(view.state.doc.toString()).toBe(doc);
    expect(washed(view)).toEqual(["three four"]);
  });

  it("locks the whole passage, the seam between its rewrite and the rest included", () => {
    const view = mount(DOC, [{ ...BLOCK, rewrite: { to: FROM + 3, text: "Fix" } }]);
    typeAt(view, FROM + 3, "x");
    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.contentDOM.querySelector(".cm-voice-pending-refused .cm-voice-rewrite")).not.toBe(
      null
    );
  });

  it("lets text in between two passages that touch, and keeps it out of both", () => {
    const view = mount("onetwo", [
      { from: 0, to: 3 },
      { from: 3, to: 6 },
    ]);
    typeAt(view, 3, " ");
    typeAt(view, 4, " ");
    expect(view.state.doc.toString()).toBe("one  two");
    expect(blocks(view)).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 8 },
    ]);
  });

  it("lets the caret and selection move through the block", () => {
    const view = mount(DOC, [BLOCK]);
    caret(view, FROM + 2);
    caret(view, FROM + 1, TO);
    expect(view.state.selection.main).toMatchObject({ anchor: FROM + 1, head: TO });
    expect(washed(view)).toEqual([]);
  });

  it("lets the session write into the block", () => {
    const view = mount(DOC, [BLOCK]);
    view.dispatch(outsideDraftWrite({ from: FROM, to: TO, insert: "Fix the bug" }, DOC, null));
    expect(view.state.doc.toString()).toBe("now Fix the bug please");

    view.dispatch({ changes: { from: FROM, to: FROM + 3, insert: "Mend" } });
    view.dispatch({
      changes: { from: FROM, to: FROM + 4, insert: "Patch" },
      userEvent: REWRITE_USER_EVENT,
    });
    expect(view.state.doc.toString()).toBe("now Patch the bug please");
  });

  it("unlocks once the pending ranges go", () => {
    const view = mount(DOC, [BLOCK]);
    view.dispatch({ effects: setPendingAIRanges.of([]) });
    typeAt(view, FROM + 3, "x");
    expect(view.state.doc.toString()).toBe("now fixx the bug please");
  });

  // CodeMirror reads a change from the DOM when its mutation observer reports
  // it, a microtask after the text node changed.
  const domFlushed = () => new Promise((resolve) => setTimeout(resolve, 0));
  function pendingText(view: EditorView): Text {
    const node = view.contentDOM.querySelector(".cm-voice-pending-ai")?.firstChild;
    if (!(node instanceof Text)) throw new Error("no pending text node");
    return node;
  }

  it("refuses typing that reaches the editor through its DOM, and redraws the words", async () => {
    const view = mount(DOC, [BLOCK]);
    pendingText(view).nodeValue = "fiXx the bug";
    await domFlushed();

    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.contentDOM.textContent).toBe(DOC);
    expect(washed(view)).toEqual([PASSAGE]);
  });

  it("refuses an IME composition inside the words, and redraws them once it ends", async () => {
    const view = mount(DOC, [BLOCK]);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    pendingText(view).nodeValue = "fix the かbug";
    await domFlushed();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { data: "か" }));
    await domFlushed();

    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.contentDOM.textContent).toBe(DOC);
  });

  it("clears the wash after a moment, each refusal starting it again", () => {
    vi.useFakeTimers();
    const view = mount(DOC, [BLOCK]);
    typeAt(view, FROM + 1, "x");
    vi.advanceTimersByTime(VOICE_PENDING_REFUSAL_MS - 1);
    typeAt(view, FROM + 1, "x");
    vi.advanceTimersByTime(VOICE_PENDING_REFUSAL_MS - 1);
    expect(washed(view)).toEqual([PASSAGE]);

    vi.advanceTimersByTime(1);
    expect(washed(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("takes the wash away with the block when its correction settles", () => {
    const view = mount(DOC, [BLOCK]);
    typeAt(view, FROM + 1, "x");
    view.dispatch({ effects: setPendingAIRanges.of([]) });
    expect(washed(view)).toEqual([]);
  });

  it("announces a refusal once per wash, not once per key", () => {
    const announced: unknown[] = [];
    const view = mount(
      DOC,
      [BLOCK],
      [
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            for (const effect of tr.effects) {
              if (effect.is(EditorView.announce)) announced.push(effect.value);
            }
          }
        }),
      ]
    );
    vi.useFakeTimers();
    typeAt(view, FROM + 1, "x");
    typeAt(view, FROM + 1, "x");
    expect(announced).toEqual(["Still correcting these words"]);

    vi.advanceTimersByTime(VOICE_PENDING_REFUSAL_MS);
    typeAt(view, FROM + 1, "x");
    expect(announced).toHaveLength(2);
  });
});

describe("pendingLock with undo and redo", () => {
  /** The next edit starts its own undo step. */
  const isolate = { annotations: isolateHistory.of("full") };
  const nativeHistory = (view: EditorView, inputType: "historyUndo" | "historyRedo") =>
    view.contentDOM.dispatchEvent(new InputEvent("beforeinput", { inputType, cancelable: true }));

  it("can't take back the dictation that wrote the pending words", () => {
    const view = mount("now ", []);
    view.dispatch(outsideDraftWrite({ from: FROM, insert: PASSAGE }, "now ", null));
    view.dispatch({ effects: setPendingAIRanges.of([BLOCK]) });
    const depth = undoDepth(view.state);

    view.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true })
    );
    expect(view.state.doc.toString()).toBe(`now ${PASSAGE}`);
    expect(undoDepth(view.state)).toBe(depth);
    expect(washed(view)).toEqual([PASSAGE]);

    // The step is still there for when the words unlock.
    view.dispatch({ effects: setPendingAIRanges.of([]) });
    view.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true })
    );
    expect(view.state.doc.toString()).toBe("now ");
  });

  it("still undoes typing outside the block", () => {
    const view = mount(DOC, [BLOCK]);
    view.dispatch({
      ...isolate,
      changes: { from: DOC.length, insert: "!" },
      userEvent: "input.type",
    });
    view.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true })
    );
    expect(view.state.doc.toString()).toBe(DOC);
    expect(washed(view)).toEqual([]);
  });

  it("can't redo a step that takes the pending words out, until they unlock", () => {
    const view = mount(DOC, []);
    view.dispatch({ ...isolate, changes: { from: FROM, to: TO }, userEvent: "delete" });
    nativeHistory(view, "historyUndo");
    view.dispatch({ effects: setPendingAIRanges.of([BLOCK]) });
    nativeHistory(view, "historyRedo");
    expect(view.state.doc.toString()).toBe(DOC);

    view.dispatch({ effects: setPendingAIRanges.of([]) });
    nativeHistory(view, "historyRedo");
    expect(view.state.doc.toString()).toBe("now  please");
  });

  it("still redoes typing outside the block", () => {
    const view = mount(DOC, [BLOCK]);
    view.dispatch({
      ...isolate,
      changes: { from: DOC.length, insert: "!" },
      userEvent: "input.type",
    });
    nativeHistory(view, "historyUndo");
    nativeHistory(view, "historyRedo");
    expect(view.state.doc.toString()).toBe(`${DOC}!`);
  });

  it("leaves history unguarded by an editor without the lock", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
    });
    views.push(view);
    view.dispatch({ changes: { from: 0, insert: "typed" }, userEvent: "input.type" });
    view.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true })
    );
    expect(view.state.doc.toString()).toBe("");
  });
});
