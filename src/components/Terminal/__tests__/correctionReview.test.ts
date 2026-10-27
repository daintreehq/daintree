/**
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { isolateHistory, undoDepth } from "@codemirror/commands";
import { minimalDocChange } from "@/lib/textRangeMapping";
import {
  VOICE_CORRECTION_MARK_DWELL_MS,
  VOICE_CORRECTION_MARK_FADE_MS,
} from "@/lib/animationUtils";
import { createComposerHistory, outsideDraftWrite } from "../inputEditorExtensions/composerHistory";
import {
  correctionLanded,
  correctionReviewField,
  createCorrectionReview,
  diffCorrection,
  endCorrectionReview,
  replayLandedCorrection,
  type CorrectionReview,
} from "../inputEditorExtensions/correctionReview";

describe("diffCorrection", () => {
  const changedWords = (raw: string, corrected: string) =>
    diffCorrection(raw, corrected).changed.map((s) => [corrected.slice(s.from, s.to), s.heard]);

  it("marks a substituted run with the words that were heard there", () => {
    expect(changedWords("open the zoo stand store", "open the Zustand store")).toEqual([
      ["Zustand", "zoo stand"],
    ]);
  });

  it("counts a capital or a punctuation mark the correction added", () => {
    expect(changedWords("so we need to fix it", "So we need to fix it.")).toEqual([
      ["So", "so"],
      ["it.", "it"],
    ]);
  });

  it("marks words the correction added with nothing heard", () => {
    expect(changedWords("run tests", "run the tests")).toEqual([["the", ""]]);
  });

  it("anchors dropped words to the kept word before them, or the first word at the start", () => {
    const raw = "um we need um to fix it";
    const corrected = "we need to fix it";
    const { changed, removed } = diffCorrection(raw, corrected);
    expect(changed).toEqual([]);
    expect(removed).toEqual([
      { at: 0, afterWord: false, heard: "um" },
      { at: corrected.indexOf("need") + 4, afterWord: true, heard: "um" },
    ]);
  });

  it("finds nothing when only the spacing changed, or nothing did", () => {
    expect(diffCorrection("fix  the\ntest", "fix the test")).toEqual({ changed: [], removed: [] });
    expect(diffCorrection("same words", "same words")).toEqual({ changed: [], removed: [] });
  });

  it("aligns repeated words inside the changed middle to the ones the correction kept", () => {
    const raw = "fix the the bug in the test";
    const corrected = "fix the bug in this test";
    const { changed, removed } = diffCorrection(raw, corrected);
    expect(changed.map((s) => [corrected.slice(s.from, s.to), s.heard])).toEqual([["this", "the"]]);
    expect(removed).toEqual([{ at: "fix the".length, afterWord: true, heard: "the" }]);
  });

  it("marks one span between the common head and tail when a passage is too long to align", () => {
    const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`);
    // A word both sides share mid-passage, which a full alignment would keep.
    const middle = (w: string) => [...words(300, w), "shared", ...words(300, `${w}x`)];
    const raw = ["start", ...middle("a"), "end"].join(" ");
    const corrected = ["start", ...middle("b"), "end"].join(" ");
    const { changed } = diffCorrection(raw, corrected);
    expect(changed).toHaveLength(1);
    expect(corrected.slice(changed[0]!.from, changed[0]!.to)).toBe(middle("b").join(" "));
  });
});

// jsdom has no layout: CodeMirror's measure frame reads text through Range
// rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

const isMac = /Mac/.test(navigator.platform);

function press(view: EditorView, key: string, shift = false): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key, shiftKey: shift, metaKey: isMac, ctrlKey: !isMac }),
    "editor"
  );
}
const undoKey = (view: EditorView) => press(view, "z");
const redoKey = (view: EditorView) => (isMac ? press(view, "z", true) : press(view, "y"));

const views: EditorView[] = [];
let onShown: ReturnType<typeof vi.fn<(review: CorrectionReview) => void>>;
let onSwapped: ReturnType<
  typeof vi.fn<(review: CorrectionReview, now: "raw" | "corrected") => void>
>;

beforeEach(() => {
  vi.useFakeTimers();
  onShown = vi.fn();
  onSwapped = vi.fn();
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

function mount(doc: string, extensions: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        createComposerHistory(),
        createCorrectionReview({ onShown, onSwapped }),
        ...extensions,
      ],
    }),
  });
  views.push(view);
  return view;
}

/** What the composer's draft sync does when a correction swaps a passage. */
function land(view: EditorView, review: CorrectionReview): void {
  const before = view.state.doc.toString();
  const after =
    before.slice(0, review.from) +
    review.correctedText +
    before.slice(review.from + review.rawText.length);
  view.dispatch({
    changes: minimalDocChange(before, after)!,
    selection: { anchor: after.length },
    effects: correctionLanded.of(review),
    annotations: isolateHistory.of("full"),
  });
}

const marked = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll(".cm-voice-corrected")].map((el) => el.textContent);
const reviewing = (view: EditorView) => view.state.field(correctionReviewField, false) != null;

const INTRO = "Intro. ";
const RAW = "um open the zoo stand store";
const CORRECTED = "Open the Zustand store.";
const review: CorrectionReview = { from: INTRO.length, rawText: RAW, correctedText: CORRECTED };

describe("correction review", () => {
  it("marks the changed words and puts no restore control in the text", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    expect(view.state.doc.toString()).toBe(INTRO + CORRECTED);
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(view.contentDOM.querySelector(".cm-voice-restore")).toBeNull();
    expect(onShown).toHaveBeenCalledWith(review);
  });

  it("shows nothing when the correction changed no words", () => {
    const view = mount("fix  the test");
    land(view, { from: 0, rawText: "fix  the test", correctedText: "fix the test" });

    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(false);
    expect(onShown).not.toHaveBeenCalled();
  });

  it("fades the marks on its own and keeps the review until the next edit", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected-fading")).not.toHaveLength(0);
    expect(view.contentDOM.querySelector(".cm-voice-restore")).toBeNull();

    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_FADE_MS);
    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(true);
    expect(view.contentDOM.querySelector(".cm-voice-restore")).toBeNull();
    expect(onShown).toHaveBeenCalledTimes(1);
    const dispatch = vi.spyOn(view, "dispatch");
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS * 10);
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();

    view.dispatch({ changes: { from: view.state.doc.length, insert: " ok" } });
    expect(reviewing(view)).toBe(false);
  });

  it("clears the marks on the next edit", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });

    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(false);
    const dispatch = vi.spyOn(view, "dispatch");
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS + VOICE_CORRECTION_MARK_FADE_MS);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stays on its passage while dictation writes after it, keeping its deadline (#14772)", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS / 2);

    const more = " And then the next part.";
    const end = view.state.doc.length;
    view.dispatch(
      outsideDraftWrite({ from: end, insert: more }, view.state.doc.toString() + more, null)
    );
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(reviewing(view)).toBe(true);

    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS / 2);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected-fading")).not.toHaveLength(0);
  });

  it("follows its passage when an outside write lands before it", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    view.dispatch(outsideDraftWrite({ from: 0, insert: "Note. " }, "Note. ", null));
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(view.state.doc.toString()).toBe("Note. " + INTRO + CORRECTED);
  });

  it("ends when an outside write takes text out, even next to an identical copy", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    const copy = " " + CORRECTED;
    view.dispatch(
      outsideDraftWrite({ from: view.state.doc.length, insert: copy }, "", null, { anchor: 0 })
    );
    expect(reviewing(view)).toBe(true);

    // A scratch of the dictated copy, which a diff reads as removing the second.
    const end = view.state.doc.length;
    view.dispatch(outsideDraftWrite({ from: end - copy.length, to: end }, "", null, { anchor: 0 }));
    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(false);
  });

  it("ends when an outside write reaches its passage", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    const at = INTRO.length + 5;
    view.dispatch(outsideDraftWrite({ from: at, to: at + 3, insert: "XYZ" }, "", null));
    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(false);
  });

  it("undoes the swap with Cmd+Z as one step, and redoes it with its marks", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "raw");
    expect(reviewing(view)).toBe(false);

    redoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + CORRECTED);
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "corrected");
  });

  it("reports the swap undone after the marks are gone and after later typing is undone", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS + VOICE_CORRECTION_MARK_FADE_MS);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " Thanks" },
      userEvent: "input.type",
    });

    undoKey(view);
    expect(onSwapped).not.toHaveBeenCalled();
    undoKey(view);

    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenCalledExactlyOnceWith(review, "raw");
  });

  it("does not report the first landing as a swap", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    expect(onSwapped).not.toHaveBeenCalled();
  });

  it("replays a correction that landed before the editor saw it as an undoable swap", () => {
    const view = mount(INTRO + CORRECTED);
    replayLandedCorrection(view, review);

    expect(view.state.doc.toString()).toBe(INTRO + CORRECTED);
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(undoDepth(view.state)).toBe(1);

    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "raw");
  });

  it("refuses to replay a correction the draft no longer holds", () => {
    const view = mount(INTRO + "something else entirely");
    replayLandedCorrection(view, review);

    expect(marked(view)).toEqual([]);
    expect(undoDepth(view.state)).toBe(0);
    expect(view.state.doc.toString()).toBe(INTRO + "something else entirely");
  });

  it("ends on request, leaving the text, the caret and the undo step as they were (#14875)", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    view.dispatch({ selection: { anchor: 2, head: 5 } });
    const { doc, selection } = view.state;
    const depth = undoDepth(view.state);
    const dispatch = vi.spyOn(view, "dispatch");

    endCorrectionReview(view);
    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(false);
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(undoDepth(view.state)).toBe(depth);

    endCorrectionReview(view);
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS + VOICE_CORRECTION_MARK_FADE_MS);
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockRestore();
    expect(onSwapped).not.toHaveBeenCalled();

    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "raw");
  });

  it("ends a review whose marks already faded", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS + VOICE_CORRECTION_MARK_FADE_MS);
    expect(reviewing(view)).toBe(true);

    endCorrectionReview(view);

    expect(reviewing(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(INTRO + CORRECTED);
  });

  it("lands a correction out of review on request, and brings the review back on redo", () => {
    const view = mount(INTRO + RAW);
    const after = INTRO + CORRECTED;
    view.dispatch(
      outsideDraftWrite(
        minimalDocChange(view.state.doc.toString(), after)!,
        after,
        review,
        undefined,
        false
      )
    );

    expect(view.state.doc.toString()).toBe(after);
    expect(marked(view)).toEqual([]);
    expect(reviewing(view)).toBe(false);
    expect(onShown).not.toHaveBeenCalled();

    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "raw");
    redoKey(view);
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "corrected");
  });

  it("replays a correction out of review on request, as an undoable swap", () => {
    const view = mount(INTRO + CORRECTED);
    replayLandedCorrection(view, review, false);

    expect(reviewing(view)).toBe(false);
    expect(undoDepth(view.state)).toBe(1);
    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
  });

  it("drops its pending deadline when the editor goes away", () => {
    const view = mount(INTRO + RAW);
    land(view, review);
    const dispatch = vi.spyOn(view, "dispatch");

    view.destroy();
    views.splice(views.indexOf(view), 1);
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS + VOICE_CORRECTION_MARK_FADE_MS);

    expect(dispatch).not.toHaveBeenCalled();
  });
});
