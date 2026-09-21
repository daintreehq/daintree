// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, getDrawSelectionConfig } from "@codemirror/view";
import { createCursorBlink } from "../inputEditorExtensions/cursorBlink";
import { COMPOSER_CURSOR_BLINK_MS } from "@/lib/animationUtils";

const HALF = COMPOSER_CURSOR_BLINK_MS / 2;

let view: EditorView | null = null;

function mount(doc = "hello world"): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [createCursorBlink()] }),
    parent,
  });
  return view;
}

function cursorLayer(v: EditorView): HTMLElement {
  const layer = v.scrollDOM.querySelector<HTMLElement>(":scope > .cm-cursorLayer");
  if (!layer) throw new Error("no cursor layer");
  return layer;
}

const isHidden = (v: EditorView) => cursorLayer(v).style.opacity === "0";

// CodeMirror notices focus changes from its own focus/blur listeners, then
// confirms them on a short timeout before issuing the focus-changed update.
function focus(v: EditorView) {
  v.focus();
  vi.advanceTimersByTime(20);
}

function blur(v: EditorView) {
  v.contentDOM.blur();
  vi.advanceTimersByTime(20);
}

describe("createCursorBlink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("switches off CodeMirror's infinite CSS blink animation", () => {
    const v = mount();
    expect(getDrawSelectionConfig(v.state).cursorBlinkRate).toBe(0);
    expect(cursorLayer(v).style.animationDuration).toBe("0ms");
  });

  it("keeps the same period as the CSS blink it replaces", () => {
    expect(COMPOSER_CURSOR_BLINK_MS).toBe(
      getDrawSelectionConfig(EditorState.create()).cursorBlinkRate
    );
  });

  it("runs no timer while the editor is unfocused", () => {
    const v = mount();
    vi.advanceTimersByTime(COMPOSER_CURSOR_BLINK_MS * 3);
    expect(isHidden(v)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blinks on the CSS animation's cadence while focused", () => {
    const v = mount();
    focus(v);
    expect(v.hasFocus).toBe(true);
    expect(isHidden(v)).toBe(false);

    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(false);
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);
  });

  it("shows the cursor the moment it moves and restarts the phase", () => {
    const v = mount();
    focus(v);
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);

    v.dispatch({ selection: EditorSelection.cursor(3) });
    expect(isHidden(v)).toBe(false);

    vi.advanceTimersByTime(HALF - 1);
    expect(isHidden(v)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isHidden(v)).toBe(true);
  });

  it("shows the cursor on typing", () => {
    const v = mount();
    focus(v);
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);

    v.dispatch({ changes: { from: 0, insert: "x" } });

    expect(isHidden(v)).toBe(false);
  });

  it("stops the timer and leaves the cursor visible on blur", () => {
    const v = mount();
    focus(v);
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);

    blur(v);

    expect(isHidden(v)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the cursor solid in performance mode", () => {
    document.body.dataset.performanceMode = "true";
    try {
      const v = mount();
      focus(v);
      vi.advanceTimersByTime(COMPOSER_CURSOR_BLINK_MS * 3);
      expect(isHidden(v)).toBe(false);
    } finally {
      delete document.body.dataset.performanceMode;
    }
  });

  it("settles visible when performance mode turns on mid-blink", () => {
    const v = mount();
    focus(v);
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);

    document.body.dataset.performanceMode = "true";
    try {
      vi.advanceTimersByTime(HALF);
      expect(isHidden(v)).toBe(false);
      vi.advanceTimersByTime(COMPOSER_CURSOR_BLINK_MS * 3);
      expect(isHidden(v)).toBe(false);
    } finally {
      delete document.body.dataset.performanceMode;
    }

    // Leaving performance mode resumes on the next interaction.
    v.dispatch({ selection: EditorSelection.cursor(2) });
    vi.advanceTimersByTime(HALF);
    expect(isHidden(v)).toBe(true);
  });

  it("clears its timer when the editor is destroyed", () => {
    // CodeMirror schedules its own timers during teardown, so check the blink's
    // interval specifically rather than the global count.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const v = mount();
    focus(v);
    const blinkTimer = setIntervalSpy.mock.results.at(-1)?.value;
    expect(blinkTimer).toBeDefined();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    v.destroy();
    view = null;

    expect(clearIntervalSpy).toHaveBeenCalledWith(blinkTimer);
  });
});
