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

import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { isolateHistory, undoDepth } from "@codemirror/commands";
import { minimalDocChange } from "@/lib/textRangeMapping";
import {
  VOICE_CORRECTION_MARK_DWELL_MS,
  VOICE_CORRECTION_MARK_FADE_MS,
} from "@/lib/animationUtils";
import { createComposerHistory } from "../inputEditorExtensions/composerHistory";
import {
  correctionLanded,
  createCorrectionReview,
  diffCorrection,
  restoreCorrection,
  showCorrectionReview,
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

  it("aligns repeated words to the ones the correction kept", () => {
    expect(changedWords("the the test the end", "the test the end")).toEqual([]);
    expect(diffCorrection("the the test the end", "the test the end").removed).toHaveLength(1);
  });

  it("marks one span between the common head and tail when a passage is too long to align", () => {
    const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`);
    const raw = ["start", ...words(600, "a"), "end"].join(" ");
    const corrected = ["start", ...words(600, "b"), "end"].join(" ");
    const { changed } = diffCorrection(raw, corrected);
    expect(changed).toHaveLength(1);
    expect(corrected.slice(changed[0]!.from, changed[0]!.to)).toBe(words(600, "b").join(" "));
  });
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

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [createComposerHistory(), createCorrectionReview({ onShown, onSwapped })],
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
const restoreControl = (view: EditorView) =>
  view.contentDOM.querySelector<HTMLElement>(".cm-voice-restore");

const INTRO = "Intro. ";
const RAW = "um open the zoo stand store";
const CORRECTED = "Open the Zustand store.";
const review: CorrectionReview = { from: INTRO.length, rawText: RAW, correctedText: CORRECTED };

describe("correction review", () => {
  it("marks the changed words and offers a named restore control", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    expect(view.state.doc.toString()).toBe(INTRO + CORRECTED);
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(restoreControl(view)?.getAttribute("aria-label")).toBe("Restore original transcription");
    expect(onShown).toHaveBeenCalledWith(review);
  });

  it("shows nothing when the correction changed no words", () => {
    const view = mount("fix  the test");
    land(view, { from: 0, rawText: "fix  the test", correctedText: "fix the test" });

    expect(marked(view)).toEqual([]);
    expect(restoreControl(view)).toBeNull();
    expect(onShown).not.toHaveBeenCalled();
  });

  it("fades the marks on its own and keeps the restore control until the next edit", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected-fading")).not.toHaveLength(0);

    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_FADE_MS);
    expect(marked(view)).toEqual([]);
    expect(restoreControl(view)).not.toBeNull();
    const dispatch = vi.spyOn(view, "dispatch");
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS * 10);
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();

    view.dispatch({ changes: { from: view.state.doc.length, insert: " ok" } });
    expect(restoreControl(view)).toBeNull();
  });

  it("clears the marks on the next edit", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });

    expect(marked(view)).toEqual([]);
    expect(restoreControl(view)).toBeNull();
    const dispatch = vi.spyOn(view, "dispatch");
    vi.advanceTimersByTime(VOICE_CORRECTION_MARK_DWELL_MS + VOICE_CORRECTION_MARK_FADE_MS);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("restores the raw transcription with the control, as one undo step", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    restoreControl(view)!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));

    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "raw");
    expect(restoreControl(view)).toBeNull();

    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + CORRECTED);
    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "corrected");
  });

  it("undoes the swap with Cmd+Z, and redoes it with its marks", () => {
    const view = mount(INTRO + RAW);
    land(view, review);

    undoKey(view);
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
    expect(onSwapped).toHaveBeenLastCalledWith(review, "raw");
    expect(restoreControl(view)).toBeNull();

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

  it("shows a correction that landed before the editor saw it, without an undo step", () => {
    const view = mount(INTRO + CORRECTED);
    showCorrectionReview(view, review);

    expect(marked(view)).toEqual(["Open", "Zustand store."]);
    expect(undoDepth(view.state)).toBe(0);

    restoreControl(view)!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(view.state.doc.toString()).toBe(INTRO + RAW);
  });

  it("refuses to show or restore a correction the draft no longer holds", () => {
    const view = mount(INTRO + "something else entirely");
    showCorrectionReview(view, review);

    expect(marked(view)).toEqual([]);
    expect(restoreCorrection(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(INTRO + "something else entirely");
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
